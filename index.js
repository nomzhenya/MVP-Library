import logging
import os
import re
import sqlite3
import time
import zipfile
import xml.etree.ElementTree as ET
import aiohttp
import io
import asyncio
from datetime import datetime
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from pathlib import Path
# Menambahkan ReplyKeyboardMarkup dan KeyboardButton
from telegram import BotCommand, BotCommandScopeChat, InlineKeyboardButton, InlineKeyboardMarkup, ReplyKeyboardMarkup, KeyboardButton, Update, WebAppInfo, MenuButtonDefault
from telegram.constants import ChatMemberStatus
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters, CallbackQueryHandler

ROOT_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT_DIR / ".env"
load_dotenv(ENV_FILE, override=True)
TOKEN = os.getenv("Zhenya_BOT_TOKEN")
LIBRARY_URL = "https://mvp-library.vissarionova91.workers.dev"
CHANNEL_ID = int(os.environ["MVP_CHANNEL_ID"])
DISCUSSION_ID = int(os.environ["MVP_DISCUSSION_ID"])
MVP_CORE_ID = int(os.environ["MVP_CORE_ID"])
LIBRARY_SYNC_URL = os.getenv("LIBRARY_SYNC_URL", "").rstrip("/")
LIBRARY_SYNC_SECRET = os.getenv("LIBRARY_SYNC_SECRET", "")
LIBRARY_DB = os.getenv("ZHENYA_LIBRARY_DB", str(ROOT_DIR / "zhenya_library.db"))
if not os.path.isabs(LIBRARY_DB):
    LIBRARY_DB = str(ROOT_DIR / LIBRARY_DB)

db=sqlite3.connect(LIBRARY_DB,check_same_thread=False)

db.execute("""CREATE TABLE IF NOT EXISTS projects(
project_id TEXT PRIMARY KEY,title TEXT NOT NULL,project_type TEXT NOT NULL DEFAULT 'comic',
description TEXT NOT NULL DEFAULT '',cover_file_id TEXT,comment_link TEXT,tags TEXT NOT NULL DEFAULT '',author TEXT NOT NULL DEFAULT '',translator TEXT NOT NULL DEFAULT '',trakteer TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'Ongoing',updated_at INTEGER NOT NULL,source_message_id INTEGER)""")

db.execute("""CREATE TABLE IF NOT EXISTS chapters(
id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,chapter TEXT NOT NULL,
decensored INTEGER NOT NULL DEFAULT 0,file_id TEXT NOT NULL,message_id INTEGER NOT NULL UNIQUE,updated_at INTEGER NOT NULL DEFAULT 0,content_type TEXT NOT NULL DEFAULT 'image',file_name TEXT NOT NULL DEFAULT '')""")

# TABEL BARU UNTUK MEMORI ZHENYA (PANGGILAN HYUNG/NOONA)
db.execute("""CREATE TABLE IF NOT EXISTS user_prefs(
user_id INTEGER PRIMARY KEY, honorific TEXT NOT NULL)""")

db.commit()

# Migrations untuk database Zhenya versi lama.
for migration in [
    "ALTER TABLE projects ADD COLUMN source_message_id INTEGER",
    "ALTER TABLE projects ADD COLUMN comment_count INTEGER NOT NULL DEFAULT 0",
]:
    try:
        db.execute(migration)
        db.commit()
    except sqlite3.OperationalError:
        pass

db.execute("""CREATE TABLE IF NOT EXISTS discussion_comments(
    message_id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL
)""")
db.commit()

# Update otomatis jika ada kolom baru
for col in ["tags TEXT NOT NULL DEFAULT ''", "author TEXT NOT NULL DEFAULT ''", "translator TEXT NOT NULL DEFAULT ''", "trakteer TEXT NOT NULL DEFAULT ''", "status TEXT NOT NULL DEFAULT 'Ongoing'"]:
    try:
        db.execute(f"ALTER TABLE projects ADD COLUMN {col}")
        db.commit()
    except sqlite3.OperationalError:
        pass

for col in ["updated_at INTEGER NOT NULL DEFAULT 0", "content_type TEXT NOT NULL DEFAULT 'image'", "file_name TEXT NOT NULL DEFAULT ''"]:
    try:
        db.execute(f"ALTER TABLE chapters ADD COLUMN {col}")
        db.commit()
    except sqlite3.OperationalError:
        pass

MEDIA_GROUP_CACHE = {}
MEDIA_GROUP_PENDING = {}

def parse_project(text):
    m=re.search(r"\[PROJECT\](.*?)\[/PROJECT\]",text or "",re.I|re.S)
    if not m:return None
    
    raw_content = m.group(1).strip()
    d={}
    
    desc_match = re.search(r"DESCRIPTION:\s*(.*)", raw_content, re.I | re.S)
    if desc_match:
        d["DESCRIPTION"] = desc_match.group(1).strip()
        raw_content = re.sub(r"DESCRIPTION:\s*.*", "", raw_content, flags=re.I | re.S).strip()
    
    for line in raw_content.splitlines():
        if ":" in line:
            k,v = line.split(":",1)
            k = k.strip().upper()
            if k != "DESCRIPTION": 
                d[k] = v.strip()
            
    if not d.get("ID") or not d.get("TITLE"):return None
    return d

def docx_to_html(file_bytes):
    with zipfile.ZipFile(file_bytes) as docx:
        xml_data = docx.read("word/document.xml")
    root = ET.fromstring(xml_data)
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    parts = []
    
    for p in root.findall(".//w:p", ns):
        align_style = ""
        pPr = p.find(".//w:pPr", ns)
        if pPr is not None:
            jc = pPr.find(".//w:jc", ns)
            if jc is not None:
                val = jc.get(f"{{{ns['w']}}}val")
                if val == "both":
                    align_style = ' style="text-align: justify;"'
                elif val in ["center", "right"]:
                    align_style = f' style="text-align: {val};"'

        runs = []
        for r in p.findall(".//w:r", ns):
            t_nodes = r.findall(".//w:t", ns)
            if not t_nodes:
                continue
            text = "".join(t.text or "" for t in t_nodes)
            if not text:
                continue
            text = esc_html(text)
            rPr = r.find(".//w:rPr", ns)
            if rPr is not None:
                if rPr.find(".//w:b", ns) is not None:
                    text = f"<strong>{text}</strong>"
                if rPr.find(".//w:i", ns) is not None:
                    text = f"<em>{text}</em>"
            runs.append(text)

        para_html = "".join(runs).strip()
        if para_html:
            parts.append(f"<p{align_style}>{para_html}</p>")
    return "".join(parts)

def esc_html(value):
    return (str(value or "")
            .replace("&","&amp;")
            .replace("<","&lt;")
            .replace(">","&gt;")
            .replace('"',"&quot;")
            .replace("'","&#39;"))


async def sync_comment_counts():
    if not LIBRARY_SYNC_URL or not LIBRARY_SYNC_SECRET:
        return
    rows = db.execute(
        "SELECT project_id, comment_count FROM projects ORDER BY project_id"
    ).fetchall()
    payload = {"projects": [
        {"id": pid, "comments": int(count or 0)}
        for pid, count in rows
    ]}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.put(
                LIBRARY_SYNC_URL + "/api/admin/comment-stats",
                headers={"X-Library-Secret": LIBRARY_SYNC_SECRET},
                json=payload,
                timeout=20
            ) as r:
                if r.status >= 300:
                    log.error("Comment stats sync failed: %s %s", r.status, await r.text())
    except Exception:
        log.exception("Comment stats sync error")


async def sync_catalog():
    if not LIBRARY_SYNC_URL or not LIBRARY_SYNC_SECRET:
        log.warning("Library sync is not configured.")
        return
    projects=[]
    for row in db.execute("SELECT project_id,title,project_type,description,cover_file_id,comment_link,tags,author,translator,trakteer,status FROM projects ORDER BY title COLLATE NOCASE"):
        pid,title,ptype,desc,cover,comment,tags,author,translator,trakteer,status=row
        
        chapter_rows = db.execute("""
            SELECT chapter, decensored, file_id, updated_at, content_type
            FROM chapters WHERE project_id=? ORDER BY file_name ASC, id ASC
        """, (pid,)).fetchall()
        
        grouped = {}
        for ch, dec, fid, updated_at, content_type in chapter_rows:
            key = (ch, int(dec))
            grouped.setdefault(key, []).append((fid, updated_at, content_type))
        chapters = [
            {
                "chapter": ch,
                "decensored": dec,
                "pages": len(items),
                "file_ids": [fid for fid, _, _ in items],
                "updated_at": max([ts for _, ts, _ in items] or [0]),
                "content_type": items[0][2] if items else "image",
            }
            for (ch, dec), items in grouped.items()
        ]
        comment_count = db.execute("SELECT COUNT(*) FROM discussion_comments WHERE project_id=?", (pid,)).fetchone()[0]
        projects.append({"id":pid,"title":title,"type":ptype,"description":desc,
                         "cover_file_id":cover,"comment_link":comment,
                         "tags":[t.strip() for t in (tags or "").split(",") if t.strip()],
                         "author":author, "translator":translator, "trakteer":trakteer,
                         "status":status, "comments":int(comment_count), "chapters":chapters})
    try:
        async with aiohttp.ClientSession() as s:
            async with s.put(LIBRARY_SYNC_URL+"/api/admin/catalog",
                headers={"X-Library-Secret":LIBRARY_SYNC_SECRET},
                json=projects,timeout=20) as r:
                if r.status >= 300:
                    log.error("Library sync failed: %s %s",r.status,await r.text())
                else:
                    log.info("Library catalog synced: %s projects",len(projects))
    except Exception:
        log.exception("Library catalog sync error")

async def index_core(update,context):
    msg=update.channel_post
    if not msg or msg.chat.id != MVP_CORE_ID:return
    cap=msg.caption or ""
    body=msg.text or cap
    mg_id = msg.media_group_id
    
    if body.strip().lower() == "/info":
        info_text = """👑 <b>PANDUAN KONTROL MVP MINIWEB</b> 👑

<b>1. Tambah / Edit Project</b>
<code>[PROJECT]
ID: solo_leveling
TITLE: Solo Leveling
TYPE: comic
AUTHOR: Chugong, Dubu
TRANSLATOR: Nama Kamu / Temanmu
TAGS: Action, Fantasy
STATUS: Ongoing (atau Tamat)
COMMENT: https://t.me/MVP_Lounge/123
TRAKTEER: https://trakteer.id/namaakun
DESCRIPTION: Sinopsis cerita di sini...
[/PROJECT]</code>

<b>2. Ganti Cover</b> (Kirim File dgn caption)
<code>COVER: solo_leveling</code>

<b>3. Chapter Normal</b> (Kirim File dgn caption)
<code>PJ: solo_leveling
CHAPTER: 1
DECENSORED: 0</code>

<b>4. Chapter Khusus</b> (Kirim File dgn caption)
<code>PJ: solo_leveling
CHAPTER: 1
DECENSORED: 1 ATAU UNCENSORED: 1</code>

<b>5. Hapus Keseluruhan Project</b>
<code>DELETE_PJ: solo_leveling</code>

<b>6. Hapus 1 Chapter Spesifik</b>
<code>DELETE_CH: solo_leveling | 1</code>

<b>7. Cek Daftar Project & ID-nya</b>
<code>/listpj</code>"""
        await msg.reply_text(info_text, parse_mode="HTML")
        return

    if body.strip().lower() == "/listpj":
        rows = db.execute("SELECT title, project_id, project_type FROM projects ORDER BY title COLLATE NOCASE").fetchall()
        if not rows:
            await msg.reply_text("Belum ada project yang terdaftar di database.")
            return
        
        messages = []
        current_msg = "📚 <b>DAFTAR PROJECT & ID</b>\n\n"
        for title, pid, ptype in rows:
            icon = "📖" if ptype.lower() == "novel" else "🖼️"
            entry = f"{icon} <b>{esc_html(title)}</b>\n└ ID: <code>{pid}</code>\n\n"
            
            if len(current_msg) + len(entry) > 3800:
                messages.append(current_msg)
                current_msg = entry
            else:
                current_msg += entry
                
        if current_msg:
            messages.append(current_msg)
            
        for m in messages:
            try:
                await msg.reply_text(m, parse_mode="HTML")
            except Exception as e:
                log.error(f"Gagal mengirim list pj: {e}")
        return
    
    m_del_pj = re.match(r"^DELETE_PJ\s*[:=]\s*([A-Za-z0-9_.-]+)", body.strip(), re.I)
    if m_del_pj:
        pid = m_del_pj.group(1).lower()
        cur = db.execute("DELETE FROM projects WHERE project_id=?", (pid,))
        db.execute("DELETE FROM chapters WHERE project_id=?", (pid,))
        db.execute("DELETE FROM discussion_comments WHERE project_id=?", (pid,))
        db.commit()
        if cur.rowcount > 0:
            log.info(f"Project dihapus: {pid}")
            await sync_catalog()
            await sync_comment_counts()
            try: await msg.reply_text(f"✅ Berhasil!\nProject '{pid}' telah dihapus.")
            except: pass
        else:
            try: await msg.reply_text(f"⚠️ Gagal!\nProject '{pid}' tidak ditemukan.")
            except: pass
        return

    m_del_ch = re.match(r"^DELETE_CH\s*[:=]\s*([A-Za-z0-9_.-]+)\s*\|\s*([^\s|]+)", body.strip(), re.I)
    if m_del_ch:
        pid = m_del_ch.group(1).lower()
        ch = m_del_ch.group(2)
        cur = db.execute("DELETE FROM chapters WHERE project_id=? AND chapter=?", (pid, ch))
        db.commit()
        if cur.rowcount > 0:
            log.info(f"Chapter dihapus: {pid} | {ch}")
            await sync_catalog()
            try: await msg.reply_text(f"✅ Berhasil!\nChapter {ch} dari project '{pid}' telah dihapus.")
            except: pass
        else:
            try: await msg.reply_text(f"⚠️ Gagal!\nChapter {ch} untuk project '{pid}' tidak ditemukan.")
            except: pass
        return
    
    p=parse_project(body)
    if p:
        db.execute("""INSERT INTO projects(
            project_id, title, project_type, description, cover_file_id, 
            comment_link, tags, author, translator, trakteer, status, updated_at, source_message_id
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(project_id) DO UPDATE SET 
            title=excluded.title,
            project_type=excluded.project_type,
            description=excluded.description,
            comment_link=excluded.comment_link,
            tags=excluded.tags,
            author=excluded.author,
            translator=excluded.translator,
            trakteer=excluded.trakteer,
            status=excluded.status,
            updated_at=excluded.updated_at,
            source_message_id=excluded.source_message_id""",
        (p["ID"].lower(),p["TITLE"],p.get("TYPE","comic"),p.get("DESCRIPTION",""),
         None,p.get("COMMENT",""),p.get("TAGS",""),p.get("AUTHOR",""),p.get("TRANSLATOR",""),p.get("TRAKTEER",""),p.get("STATUS","Ongoing"),int(time.time()),msg.message_id))
        db.commit();await sync_catalog();await sync_comment_counts();return
        
    m=re.match(r"^COVER:\s*([A-Za-z0-9_.-]+)$",cap,re.I)
    if m:
        fid = None
        if msg.photo:
            fid = msg.photo[-1].file_id
        elif msg.document and (msg.document.mime_type or "").startswith("image/"):
            fid = msg.document.file_id
            
        if fid:
            db.execute("UPDATE projects SET cover_file_id=?,updated_at=? WHERE project_id=?",
                       (fid,int(time.time()),m.group(1).lower()))
            db.commit();await sync_catalog();await sync_comment_counts();return
    
    m = re.search(
        r"PJ:\s*([A-Za-z0-9_.-]+).*?"
        r"CHAPTER:\s*([^\s|]+).*?"
        r"(DECENSORED|UNCENSORED):\s*([01])",
        cap,
        re.I | re.S
    )

    pid = None
    ch = None
    dec = 0

    if m:
        pid = m.group(1).lower()
        ch = m.group(2)
        c_type_meta = m.group(3).upper()
        val = int(m.group(4))

        if val == 1:
            dec = 1 if c_type_meta == "DECENSORED" else 2

        if mg_id:
            MEDIA_GROUP_CACHE[mg_id] = {
                "pid": pid,
                "ch": ch,
                "dec": dec
            }

    elif mg_id and mg_id in MEDIA_GROUP_CACHE:
        cached = MEDIA_GROUP_CACHE[mg_id]
        pid = cached["pid"]
        ch = cached["ch"]
        dec = cached["dec"]


    fid = None
    content_type = "image"
    file_name_attr = ""

    if msg.photo:
        fid = msg.photo[-1].file_id
        content_type = "image"
        file_name_attr = msg.photo[-1].file_unique_id

    elif msg.document:
        fid = msg.document.file_id
        if (msg.document.file_name or "").lower().endswith(".docx"):
            content_type = "docx"
        else:
            content_type = "image"
        file_name_attr = msg.document.file_name or ""


    if not fid:
        return

    if mg_id:
        if not pid or not ch:
            MEDIA_GROUP_PENDING.setdefault(mg_id, []).append({
                "fid": fid,
                "message_id": msg.message_id,
                "updated_at": int(msg.date.timestamp()) if msg.date else int(time.time()),
                "content_type": content_type,
                "file_name": file_name_attr
            })
            return

        pending = MEDIA_GROUP_PENDING.pop(mg_id, [])
        items = pending + [{
            "fid": fid,
            "message_id": msg.message_id,
            "updated_at": int(msg.date.timestamp()) if msg.date else int(time.time()),
            "content_type": content_type,
            "file_name": file_name_attr
        }]
    else:
        items = [{
            "fid": fid,
            "message_id": msg.message_id,
            "updated_at": int(msg.date.timestamp()) if msg.date else int(time.time()),
            "content_type": content_type,
            "file_name": file_name_attr
        }]

    inserted = 0

    for item in items:
        item_fid = item["fid"]
        item_type = item["content_type"]

        if item_type == "docx":
            try:
                file = await context.bot.get_file(item_fid)
                byte_array = await file.download_as_bytearray()
                html_content = docx_to_html(io.BytesIO(byte_array))

                async with aiohttp.ClientSession() as s:
                    async with s.put(
                        LIBRARY_SYNC_URL + "/api/admin/novel",
                        headers={"X-Library-Secret": LIBRARY_SYNC_SECRET},
                        json={"project_id": pid, "chapter": ch, "decensored": dec, "html": html_content},
                        timeout=30
                    ) as r:
                        if r.status >= 300:
                            continue
            except Exception:
                continue

        db.execute(
            """INSERT OR IGNORE INTO chapters(
                project_id, chapter, decensored, file_id, message_id, updated_at, content_type, file_name
            ) VALUES(?,?,?,?,?,?,?,?)""",
            (pid, ch, dec, item_fid, item["message_id"], item["updated_at"], item_type, item["file_name"])
        )
        inserted += 1

    db.commit()
    await sync_catalog()
    return


async def resolve_project_from_discussion_reply(msg):
    reply = getattr(msg, "reply_to_message", None)
    if not reply:
        return None

    origin = getattr(reply, "forward_origin", None)
    origin_id = getattr(origin, "message_id", None)
    if origin_id:
        row = db.execute(
            "SELECT project_id FROM projects WHERE source_message_id=?",
            (origin_id,)
        ).fetchone()
        if row:
            return row[0]

    row = db.execute(
        "SELECT project_id FROM discussion_comments WHERE message_id=?",
        (reply.message_id,)
    ).fetchone()
    if row:
        return row[0]

    forwarded_id = getattr(reply, "forward_from_message_id", None)
    if forwarded_id:
        row = db.execute(
            "SELECT project_id FROM projects WHERE source_message_id=?",
            (forwarded_id,)
        ).fetchone()
        if row:
            return row[0]

    return None


async def index_discussion(update, context):
    msg = update.effective_message
    if not msg or msg.chat_id != DISCUSSION_ID or not msg.from_user or msg.from_user.is_bot:
        return

    project_id = await resolve_project_from_discussion_reply(msg)

    if not project_id:
        text = (msg.text or msg.caption or "").strip()
        m = re.search(r"(?:PJ|PROJECT)\s*[:#]\s*([A-Za-z0-9_.-]+)", text, re.I)
        if m:
            candidate = m.group(1).lower()
            row = db.execute(
                "SELECT project_id FROM projects WHERE project_id=?",
                (candidate,)
            ).fetchone()
            if row:
                project_id = row[0]

    if not project_id:
        return

    cur = db.execute(
        "INSERT OR IGNORE INTO discussion_comments(message_id,project_id) VALUES(?,?)",
        (msg.message_id, project_id)
    )
    db.commit()

    if cur.rowcount:
        await sync_catalog()
        await sync_comment_counts()


logging.basicConfig(
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    level=logging.INFO,
)
log = logging.getLogger("MVP_Zhenya")

async def is_mvp_member(bot, user_id: int) -> bool:
    valid = {ChatMemberStatus.MEMBER, ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.OWNER}
    try:
        channel = await bot.get_chat_member(CHANNEL_ID, user_id)
        lounge = await bot.get_chat_member(DISCUSSION_ID, user_id)
        return (channel.status in valid and lounge.status in valid)
    except Exception:
        log.exception("Membership check failed for user %s", user_id)
        return False


# FUNGSI UNTUK MENGIRIM SAPAAN (DENGAN REPLY KEYBOARD)
async def send_greeting(message, honorific, is_edit=False):
    tz = ZoneInfo("Asia/Jakarta")
    hour = datetime.now(tz).hour
    
    if 4 <= hour < 11:
        waktu = "pagi"
    elif 11 <= hour < 15:
        waktu = "siang"
    elif 15 <= hour < 18:
        waktu = "sore"
    else:
        waktu = "malam"
        
    pesan_sapaan = (
        f"Selamat {waktu} {honorific}, tap tombol di bawah untuk membuka miniweb\n\n"
        f"semangat rebahan, and enjoy the ride~"
    )
        
    # KUNCI UTAMA: Kita pakai Custom Keyboard (ReplyKeyboardMarkup).
    # Tombol ini akan nempel terus di bawah seukuran layar, TAPI tetap di-protect!
    keyboard = ReplyKeyboardMarkup(
        [[KeyboardButton(text="👑 Buka MVP Miniweb", web_app=WebAppInfo(url=LIBRARY_URL))]],
        resize_keyboard=True
    )
        
    if is_edit:
        # Hapus pesan (Inline Keyboard) lama
        await message.delete()
        # Kirim ulang pesan baru beserta ReplyKeyboard raksasa di bawah + PROTECT
        await message.chat.send_message(pesan_sapaan, parse_mode="HTML", reply_markup=keyboard, protect_content=True)
    else:
        await message.reply_text(pesan_sapaan, parse_mode="HTML", reply_markup=keyboard, protect_content=True)


async def set_menu(context: ContextTypes.DEFAULT_TYPE, chat_id: int, member: bool):
    commands = ([BotCommand("start", "Buka Library")] if member else [BotCommand("start", "Mulai")])
    await context.bot.set_my_commands(commands, scope=BotCommandScopeChat(chat_id=chat_id))
    
    # WAJIB DEFAULT! Menu Button bawaan API TIDAK BISA dipasang protect_content.
    # Maka kita matikan, dan posisinya akan digantikan oleh Custom Keyboard di atas.
    await context.bot.set_chat_menu_button(
        chat_id=chat_id,
        menu_button=MenuButtonDefault()
    )


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.effective_user or not update.effective_chat:
        return
    user = update.effective_user
    chat_id = update.effective_chat.id
    log.info("/start from user=%s chat=%s", user.id, chat_id)
    if update.effective_chat.type != "private":
        return
        
    member = await is_mvp_member(context.bot, user.id)
    await set_menu(context, chat_id, member)
    
    if not member:
        await update.effective_message.reply_text("Anda bukan bagian dari MVP.", protect_content=True)
        return

    cur = db.execute("SELECT honorific FROM user_prefs WHERE user_id=?", (user.id,))
    row = cur.fetchone()

    if row:
        honorific = row[0]
        await send_greeting(update.effective_message, honorific)
    else:
        # Jika belum ingat, tanya dulu pakai Inline (Wajib terproteksi juga)
        keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton("Hyung", callback_data="set_Hyung"),
             InlineKeyboardButton("Noona", callback_data="set_Noona")]
        ])
        await update.effective_message.reply_text("Bagaimana aku harus memanggilmu?", reply_markup=keyboard, protect_content=True)


async def handle_preference(update: Update, context: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    user_id = q.from_user.id
    data = q.data

    if data in ["set_Hyung", "set_Noona"]:
        honorific = data.split("_")[1]
        
        # Simpan ke ingatan Zhenya
        db.execute("INSERT OR REPLACE INTO user_prefs(user_id, honorific) VALUES(?,?)", (user_id, honorific))
        db.commit()

        # Panggil fungsi send_greeting yang akan men-delete pesan inline ini
        # lalu memunculkan Custom Keyboard di layar bawah.
        await send_greeting(q.message, honorific, is_edit=True)

async def post_init(application: Application):
    await application.bot.set_my_commands([BotCommand("start", "Mulai")])

def main():
    if not TOKEN: raise RuntimeError("Zhenya_BOT_TOKEN tidak ditemukan di .env")
    log.info("MVP_Zhenya starting...")
    app = Application.builder().token(TOKEN).post_init(post_init).build()
    
    app.add_handler(CommandHandler("start", start))
    app.add_handler(MessageHandler(filters.UpdateType.CHANNEL_POST, index_core))
    app.add_handler(MessageHandler(filters.Chat(DISCUSSION_ID) & ~filters.COMMAND, index_discussion))
    app.add_handler(CallbackQueryHandler(handle_preference, pattern="^set_"))
    
    log.info("MVP_Zhenya polling...")
    app.run_polling()

if __name__ == "__main__":
    main()