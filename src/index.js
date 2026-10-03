function randomReaderCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let res = "";
  for (let i = 0; i < 6; i++) res += chars[Math.floor(Math.random() * chars.length)];
  return res;
}

async function getStats(env, projectId) {
  const key = `stats:${String(projectId || "").toLowerCase()}`;
  return (await env.LIBRARY.get(key, "json")) || {rating: 0, votes: 0, bookmarks: 0, comments: 0};
}

async function putStats(env, projectId, stats) {
  const key = `stats:${String(projectId || "").toLowerCase()}`;
  await env.LIBRARY.put(key, JSON.stringify({
    rating: Number(stats.rating || 0),
    votes: Number(stats.votes || 0),
    bookmarks: Number(stats.bookmarks || 0),
    comments: Number(stats.comments || 0)
  }));
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {"content-type": "application/json; charset=utf-8"}
});

async function getReaderCode(env, user) {
  const uid = String(user.id);
  const userKey = `reader-code:user:${uid}`;
  const existing = await env.LIBRARY.get(userKey, "json");
  if (existing && /^[A-Z0-9]{6}$/.test(String(existing.code || ""))) return String(existing.code);

  let code = "";
  for (let i = 0; i < 5; i++) {
    const candidate = randomReaderCode();
    if (!(await env.LIBRARY.get(`reader-code:map:${candidate}`))) {
      code = candidate;
      break;
    }
  }
  if (!code) throw new Error("reader code generation failed");
  const record = {
    code, telegram_id: uid, username: user.username || "",
    first_name: user.first_name || "", last_name: user.last_name || "",
    created_at: Math.floor(Date.now() / 1000)
  };
  await env.LIBRARY.put(userKey, JSON.stringify(record));
  await env.LIBRARY.put(`reader-code:map:${code}`, JSON.stringify(record));
  return code;
}

function cors(headers = {}) {
  return {
    ...headers,
    "access-control-allow-origin": "https://web.telegram.org",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "Content-Type,X-Library-Secret,X-Telegram-Init-Data,X-Telegram-Platform"
  };
}

async function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) return null;

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Math.abs(Math.floor(Date.now() / 1000) - authDate) > 86400) return null;

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const webAppKey = await crypto.subtle.importKey("raw", new TextEncoder().encode("WebAppData"), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  const secretKeyBytes = new Uint8Array(await crypto.subtle.sign("HMAC", webAppKey, new TextEncoder().encode(botToken)));
  const secretKey = await crypto.subtle.importKey("raw", secretKeyBytes, {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);

  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", secretKey, new TextEncoder().encode(dataCheckString)));
  const expectedHash = [...signature].map(b => b.toString(16).padStart(2, "0")).join("");
  if (expectedHash !== receivedHash) return null;

  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

async function telegramMemberStatus(env, chatId, userId) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(userId)}`);
  if (!r.ok) return null;
  const data = await r.json();
  if (!data.ok) return null;
  const status = data.result?.status;
  return ["creator", "administrator", "member"].includes(status);
}

async function checkAccess(request, env) {
  const initData = request.headers.get("X-Telegram-Init-Data") || new URL(request.url).searchParams.get("init_data") || "";
  const user = await verifyTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!user?.id) return {ok: false, code: 401};
  if (!user.username || user.username.trim() === "") return {ok: false, code: 403};

  const CHANNEL_ID = env.MVP_CHANNEL_ID || "-1004459399775";
  const DISCUSSION_ID = env.MVP_DISCUSSION_ID || "-1003923062839";
  if (!CHANNEL_ID || !DISCUSSION_ID) return {ok: false, code: 503};

  const [mvp, discussion] = await Promise.all([
    telegramMemberStatus(env, CHANNEL_ID, user.id),
    telegramMemberStatus(env, DISCUSSION_ID, user.id)
  ]);

  if (mvp !== true || discussion !== true) return {ok: false, code: 403};
  return {ok: true, user};
}

async function getInteraction(env, projectId) {
  const data = await env.LIBRARY.get(`interaction:${projectId}`, "json");
  if (!data || typeof data !== "object") return {votes: {}, bookmarks: {}, comments: 0};
  return {
    votes: data.votes && typeof data.votes === "object" ? data.votes : {},
    bookmarks: data.bookmarks && typeof data.bookmarks === "object" ? data.bookmarks : {},
    comments: Number(data.comments || 0)
  };
}

function summarizeInteraction(data, userId, fallbackComments = 0) {
  const votes = data.votes || {};
  const bookmarks = data.bookmarks || {};
  const values = Object.values(votes).map(Number).filter(v => v >= 1 && v <= 10);
  const rating = values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : 0;
  const vote_distribution = {1:0, 2:0, 3:0, 4:0, 5:0, 6:0, 7:0, 8:0, 9:0, 10:0};
  values.forEach(v => { if(vote_distribution[v] !== undefined) vote_distribution[v]++; });

  return {
    rating,
    votes: values.length,
    vote_distribution,
    bookmarks: Object.keys(bookmarks).length,
    comments: Number(fallbackComments || data.comments || 0),
    user_vote: Number(votes[String(userId)] || 0),
    bookmarked: Object.prototype.hasOwnProperty.call(bookmarks, String(userId))
  };
}

async function saveInteraction(env, projectId, data) {
  await env.LIBRARY.put(`interaction:${projectId}`, JSON.stringify(data));
}

function envIdSet(value) {
  return new Set(String(value || "").split(",").map(x => x.trim()).filter(Boolean));
}

function isModUser(env, userId) {
  return envIdSet(env.MOD_USER_IDS).has(String(userId || ""));
}

function decoratePublicUser(item, env) {
  const uid = String(item.user_id || item.telegram_id || "");
  const mod = isModUser(env, uid);
  const out = {...item, is_mod: mod};
  if (mod) delete out.username;
  return out;
}

async function enrichCatalog(env, catalog, userId) {
  if (!Array.isArray(catalog)) return [];
  return Promise.all(catalog.map(async p => {
    const data = await getInteraction(env, p.id);
    const community = await getCommunity(env, p.id);
    const summary = summarizeInteraction(data, userId, community.comments.length);
    return {
      ...p,
      is_mod: isModUser(env, userId),
      rating: summary.rating,
      votes: summary.votes,
      vote_distribution: summary.vote_distribution,
      bookmarks: summary.bookmarks,
      comments: community.comments.length,
      reviews: community.reviews.length,
      review_count: community.reviews.length,
      user_vote: summary.user_vote,
      bookmarked: summary.bookmarked
    };
  }));
}

function safeId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 180);
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

async function getCommunity(env, projectId) {
  const data = await env.LIBRARY.get(`community:${safeId(projectId)}`, "json");
  return {
    reviews: Array.isArray(data?.reviews) ? data.reviews : [],
    comments: Array.isArray(data?.comments) ? data.comments : []
  };
}

async function putCommunity(env, projectId, data) {
  await env.LIBRARY.put(`community:${safeId(projectId)}`, JSON.stringify(data));
}

async function getNotifications(env, userId) {
  const data = await env.LIBRARY.get(`notifications:${String(userId)}`, "json");
  return Array.isArray(data) ? data : [];
}

async function putNotifications(env, userId, data) {
  await env.LIBRARY.put(`notifications:${String(userId)}`, JSON.stringify(data.slice(0, 100)));
}

async function addNotification(env, userId, notification) {
  const uid = String(userId || "").trim();
  if (!uid) return;
  const list = await getNotifications(env, uid);
  list.unshift({ id: crypto.randomUUID(), created_at: nowSec(), read: false, ...notification });
  await putNotifications(env, uid, list);
}

function projectCatalogSignature(project) {
  if (!project || typeof project !== "object") return "";
  const chapters = Array.isArray(project.chapters) ? project.chapters.map(ch => ({
    chapter: String(ch?.chapter ?? ""),
    decensored: Number(ch?.decensored || 0),
    updated_at: Number(ch?.updated_at || 0),
    pages: Number(ch?.pages || 0),
    content_type: String(ch?.content_type || "")
  })) : [];
  return JSON.stringify({
    title: String(project.title || ""),
    type: String(project.type || ""),
    description: String(project.description || ""),
    cover_file_id: String(project.cover_file_id || ""),
    tags: Array.isArray(project.tags) ? project.tags.map(String) : String(project.tags || ""),
    author: String(project.author || ""),
    translator: String(project.translator || ""),
    trakteer: String(project.trakteer || ""),
    status: String(project.status || ""),
    alt_title: String(project.alt_title || ""),
    chapters
  });
}

function changedProjectUpdate(previous, current) {
  if (!current || !previous) return null;
  const oldChapters = Array.isArray(previous.chapters) ? previous.chapters : [];
  const newChapters = Array.isArray(current.chapters) ? current.chapters : [];
  const oldMap = new Map(oldChapters.map(ch => [`${String(ch?.chapter ?? "")}::${Number(ch?.decensored || 0)}`, ch]));

  let changedChapter = null;
  for (const ch of newChapters) {
    const key = `${String(ch?.chapter ?? "")}::${Number(ch?.decensored || 0)}`;
    const old = oldMap.get(key);
    if (!old || Number(old?.updated_at || 0) !== Number(ch?.updated_at || 0) || Number(old?.pages || 0) !== Number(ch?.pages || 0)) {
      if (!changedChapter || Number(ch?.updated_at || 0) > Number(changedChapter?.updated_at || 0)) {
        changedChapter = ch;
      }
    }
  }
  const oldMeta = {...previous};
  const newMeta = {...current};
  delete oldMeta.chapters;
  delete newMeta.chapters;
  const metadataChanged = projectCatalogSignature({...oldMeta, chapters: []}) !== projectCatalogSignature({...newMeta, chapters: []});

  if (!changedChapter && !metadataChanged) return null;
  return {
    chapter: changedChapter ? String(changedChapter.chapter ?? "") : "",
    decensored: changedChapter ? Number(changedChapter.decensored || 0) : 0
  };
}

async function notifyBookmarkedProjectUpdate(env, previousCatalog, nextCatalog) {
  if (!Array.isArray(previousCatalog) || !Array.isArray(nextCatalog)) return;
  const previousMap = new Map(previousCatalog.map(p => [String(p?.id || ""), p]));
  for (const project of nextCatalog) {
    const pid = String(project?.id || "").trim();
    if (!pid) continue;
    const previous = previousMap.get(pid);
    if (!previous) continue;

    const update = changedProjectUpdate(previous, project);
    if (!update) continue;

    const interaction = await getInteraction(env, pid);
    const bookmarkers = Object.keys(interaction.bookmarks || {});
    if (!bookmarkers.length) continue;

    const title = String(project.title || pid);
    const chapter = update.chapter;
    const text = chapter
      ? `${title} punya update baru • Chapter ${chapter}${update.decensored ? " (Decensored)" : ""}`
      : `${title} punya update baru.`;

    for (const userId of bookmarkers) {
      try {
        await addNotification(env, userId, {
          type: "project_update",
          project_id: pid,
          chapter: chapter || null,
          decensored: update.decensored || 0,
          text
        });
      } catch (e) {
        console.error("Failed to notify bookmarked user", userId, pid, e);
      }
    }
  }
}

function displayCallFromUser(user) {
  return user.username ? `@${user.username}` : (user.first_name || "Reader");
}

async function requireApiAccess(request, env) {
  return await checkAccess(request, env);
}

// System Anti-Spam (Rate Limiting) menggunakan KV
async function checkRateLimit(env, userId) {
  const key = `ratelimit_${userId}`;
  const limit = 3; // Maksimal 3 request
  const windowSec = 10; // dalam 10 detik

  let record = await env.LIBRARY.get(key, "json");
  const now = nowSec();

  if (!record) {
    record = { count: 1, reset_at: now + windowSec };
  } else {
    if (now > record.reset_at) {
      record = { count: 1, reset_at: now + windowSec };
    } else {
      record.count += 1;
      if (record.count > limit) {
         return false;
      }
    }
  }

  await env.LIBRARY.put(key, JSON.stringify(record), { expirationTtl: 60 });
  return true;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }
    
    if (url.pathname === "/api/reader-code" && request.method === "GET") {
      const access = await checkAccess(request, env);
      if (!access.ok) return json({ok: false, code: access.code}, access.code);
      try {
        const code = await getReaderCode(env, access.user);
        return json({ok: true, reader_code: code});
      } catch(e) {
        return json({error: e.message}, 500);
      }
    }

    if (url.pathname === "/api/catalog" && request.method === "GET") {
      const access = await checkAccess(request, env);
      if (!access.ok) {
        return json({ ok: false, code: access.code }, access.code);
      }

      const raw = await env.LIBRARY.get("catalog");
      const catalog = raw ? JSON.parse(raw) : [];
      const enriched = await enrichCatalog(env, catalog, access.user.id);

      return new Response(JSON.stringify(enriched), {
        headers: cors({ "content-type": "application/json; charset=utf-8" })
      });
    }

    if (url.pathname === "/api/admin/catalog" && request.method === "PUT") {
      const secret = request.headers.get("x-library-secret");
      if (!env.LIBRARY_SECRET || secret !== env.LIBRARY_SECRET) {
        return json({ error: "unauthorized" }, 401);
      }

      const body = await request.json();
      if (!Array.isArray(body)) {
        return json({ error: "catalog must be an array" }, 400);
      }

      const previousCatalog = await env.LIBRARY.get("catalog", "json");
      await env.LIBRARY.put("catalog", JSON.stringify(body));
      try {
        await notifyBookmarkedProjectUpdate(env, previousCatalog, body);
      } catch (e) {
        console.error("Bookmarked update notification sync failed", e);
      }
      return json({ ok: true, count: body.length });
    }

    if (url.pathname === "/api/admin/novel" && request.method === "PUT") {
      const secret = request.headers.get("x-library-secret");
      if (!env.LIBRARY_SECRET || secret !== env.LIBRARY_SECRET) {
        return json({ error: "unauthorized" }, 401);
      }

      const body = await request.json();
      const projectId = String(body.project_id || "").trim();
      const chapter = String(body.chapter || "").trim();
      const book = String(body.book || "").trim();
      const key = `novel_${projectId}_${book || "-"}_${chapter}`;
      await env.LIBRARY.put(key, JSON.stringify({
        html: body.html,
        book
      }));
      return json({ ok: true });
    }

    if (url.pathname === "/api/novel" && request.method === "GET") {
      const access = await checkAccess(request, env);
      if (!access.ok) {
        return json({ ok: false, code: access.code }, access.code);
      }

      const pid = url.searchParams.get("project_id");
      const ch = url.searchParams.get("chapter");
      const book = url.searchParams.get("book") || "";
      const dec = url.searchParams.get("decensored") || "0";

      const key = `novel_${pid}_${book || "-"}_${ch}`;
      let data = await env.LIBRARY.get(key, "json");

      if (!data) {
        data = await env.LIBRARY.get(`novel_${pid}_${ch}_${dec}`, "json");
      }

      if (!data) return json({ error: "not found" }, 404);

      return new Response(JSON.stringify(data), {
        headers: cors({ "content-type": "application/json; charset=utf-8" })
      });
    }

    if (url.pathname === "/api/file" && request.method === "GET") {
      const access = await checkAccess(request, env);
      if (!access.ok) {
        return json({ ok: false, code: access.code }, access.code);
      }
      const fileId = url.searchParams.get("file_id");
      if (!fileId) return new Response("Missing file_id", { status: 400 });

      if (!env.TELEGRAM_BOT_TOKEN) {
        return new Response("Telegram file proxy is not configured", { status: 503 });
      }

      const tg = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`
      );
      const info = await tg.json();

      if (!info.ok || !info.result?.file_path) {
        return new Response("Telegram file not found", { status: 404 });
      }

      const file = await fetch(
        `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${info.result.file_path}`
      );

      if (!file.ok) {
        return new Response("Unable to fetch Telegram file", { status: 502 });
      }

      const headers = new Headers(cors({
        "cache-control": "public, max-age=3600",
        "content-type": file.headers.get("content-type") || "image/jpeg"
      }));
      return new Response(file.body, { status: 200, headers });
    }

    if (url.pathname === "/api/community" && request.method === "GET") {
      const access = await requireApiAccess(request, env);
      if (!access.ok) return json({ ok: false, code: access.code }, access.code);

      const projectId = String(url.searchParams.get("project_id") || "").trim();
      if (!projectId) return json({ error: "missing project_id" }, 400);

      const data = await getCommunity(env, projectId);
      const uid = String(access.user.id);
      const decorate = (item) => {
        item.loves = item.loves && typeof item.loves === "object" ? item.loves : {};
        const out = { ...item, love_count: Object.keys(item.loves).length, user_loved: Object.prototype.hasOwnProperty.call(item.loves, uid), is_mod: isModUser(env, item.user_id || item.telegram_id) };
        if (out.is_mod) delete out.username;
        return out;
      };
      data.reviews = data.reviews.map(decorate).sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
      data.comments = data.comments.map(decorate).sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));

      return new Response(JSON.stringify({
        ok: true,
        reviews: data.reviews,
        comments: data.comments,
        review_count: data.reviews.length,
        comment_count: data.comments.length
      }), {
        headers: cors({ "content-type": "application/json; charset=utf-8" })
      });
    }

    if (url.pathname === "/api/review" && request.method === "POST") {
      const access = await requireApiAccess(request, env);
      if (!access.ok) return json({ ok: false, code: access.code }, access.code);

      const uid = String(access.user.id);
      const isAllowed = await checkRateLimit(env, uid);
      if (!isAllowed) return json({ error: "Tolong jangan spam! Tunggu beberapa detik sebelum mengirim lagi." }, 429);

      const body = await request.json().catch(() => ({}));
      const projectId = String(body.project_id || "").trim();
      const text = String(body.text || "").trim();
      const reviewId = String(body.review_id || "").trim();
      const hasScore = body.score !== undefined && body.score !== null && body.score !== "";
      const score = hasScore ? Number(body.score) : null;
      if (!projectId) return json({ error: "project required" }, 400);
      if (text.length > 2000) return json({ error: "review too long" }, 400);
      if (hasScore && (!Number.isInteger(score) || score < 1 || score > 10)) return json({ error: "invalid review score" }, 400);

      const rawCat = await env.LIBRARY.get("catalog", "json");
      const catalog = Array.isArray(rawCat) ? rawCat : [];
      if (!catalog.some(p => String(p.id) === projectId)) return json({ error: "project not found" }, 404);

      const data = await getCommunity(env, projectId);
      data.reviews = Array.isArray(data.reviews) ? data.reviews : [];
      const now = nowSec();
      const telegramName = [access.user.first_name, access.user.last_name].filter(Boolean).join(" ").trim();
      const interaction = await getInteraction(env, projectId);

      if (body.action === "delete") {
        const idx = data.reviews.findIndex(r => String(r.id) === reviewId);
        if (idx < 0) return json({ error: "review not found or forbidden" }, 404);
        const owner = String(data.reviews[idx].user_id || data.reviews[idx].telegram_id || "");
        if (owner !== uid && !isModUser(env, uid)) return json({ error: "review not found or forbidden" }, 403);
        data.reviews.splice(idx, 1);
        await putCommunity(env, projectId, data);
        const summary = summarizeInteraction(interaction, uid, data.comments.length);
        return json({ ok: true, reviews: data.reviews.length, interaction: summary });
      }

      let existing = data.reviews.find(r => String(r.user_id || r.telegram_id) === uid);
      let newReviewCreated = false;
      if (reviewId) {
        existing = data.reviews.find(r => String(r.id) === reviewId);
        if (!existing || String(existing.user_id || existing.telegram_id) !== uid) return json({ error: "review not found or forbidden" }, 404);
      }

      if (existing) {
        if (text) existing.text = text;
        if (hasScore) {
          existing.score = score;
          interaction.votes[uid] = score;
        } else if (existing.score && !interaction.votes[uid]) {
          interaction.votes[uid] = Number(existing.score);
        }
        existing.updated_at = now;
        existing.telegram_name = telegramName;
        existing.first_name = access.user.first_name || "";
        existing.last_name = access.user.last_name || "";
        existing.username = access.user.username || "";
        existing.loves = existing.loves && typeof existing.loves === "object" ? existing.loves : {};
      } else {
        if (!text) return json({ error: "review text required" }, 400);
        if (!hasScore) return json({ error: "review score required" }, 400);
        interaction.votes[uid] = score;
        existing = {
          id: crypto.randomUUID(), user_id: uid, telegram_id: uid,
          username: access.user.username || "", first_name: access.user.first_name || "",
          last_name: access.user.last_name || "", telegram_name: telegramName,
          score, text, loves: {}, created_at: now, updated_at: now
        };
        data.reviews.push(existing);
        newReviewCreated = true;
      }

      await putCommunity(env, projectId, data);
      if (newReviewCreated) {
        await env.LIBRARY.put("web-point-version", `${Date.now()}-${crypto.randomUUID()}`);
      }
      await saveInteraction(env, projectId, interaction);
      const summary = summarizeInteraction(interaction, uid, data.comments.length);
      return json({ ok: true, review: existing, reviews: data.reviews.length, interaction: summary });
    }

    if (url.pathname === "/api/comment" && request.method === "POST") {
      const access = await requireApiAccess(request, env);
      if (!access.ok) return json({ ok: false, code: access.code }, access.code);

      const uid = String(access.user.id);
      const isAllowed = await checkRateLimit(env, uid);
      if (!isAllowed) return json({ error: "Tolong jangan spam! Tunggu beberapa detik sebelum mengirim lagi." }, 429);

      const body = await request.json().catch(() => ({}));
      const projectId = String(body.project_id || "").trim();
      const text = String(body.text || "").trim();
      const commentId = String(body.comment_id || "").trim();
      const parentId = String(body.parent_id || "").trim();
      const chapter = body.chapter == null || body.chapter === "" ? null : String(body.chapter);
      if (!projectId) return json({ error: "missing project_id" }, 400);
      if (!text && body.action !== "delete") return json({ error: "empty comment" }, 400);
      if (text.length > 2000) return json({ error: "comment too long" }, 400);
      const rawCat = await env.LIBRARY.get("catalog", "json");
      const catalog = Array.isArray(rawCat) ? rawCat : [];
      if (!catalog.some(p => String(p.id) === projectId)) return json({ error: "project not found" }, 404);
      
      const data = await getCommunity(env, projectId);
      data.comments = Array.isArray(data.comments) ? data.comments : [];
      const telegramName = [access.user.first_name, access.user.last_name].filter(Boolean).join(" ").trim();

      if (body.action === "delete") {
        const idx = data.comments.findIndex(c => String(c.id) === commentId);
        if (idx < 0) return json({ error: "comment not found or forbidden" }, 404);
        const owner = String(data.comments[idx].user_id || data.comments[idx].telegram_id || "");
        if (owner !== uid && !isModUser(env, uid)) return json({ error: "comment not found or forbidden" }, 403);
        
        const removeIds = new Set([commentId]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const c of data.comments) {
            if (c.parent_id && removeIds.has(String(c.parent_id)) && !removeIds.has(String(c.id))) {
              removeIds.add(String(c.id));
              changed = true;
            }
          }
        }
        data.comments = data.comments.filter(c => !removeIds.has(String(c.id)));
        await putCommunity(env, projectId, data);
        const interaction = await getInteraction(env, projectId);
        interaction.comments = data.comments.length;
        await saveInteraction(env, projectId, interaction);
        return json({ ok: true, comments: data.comments.length, interaction: summarizeInteraction(interaction, uid, data.comments.length) });
      }

      if (commentId) {
        const existing = data.comments.find(c => String(c.id) === commentId);
        if (!existing || String(existing.user_id || existing.telegram_id) !== uid) return json({ error: "comment not found or forbidden" }, 404);
        existing.text = text;
        existing.updated_at = nowSec();
        existing.edited_at = nowSec();
        existing.telegram_name = telegramName;
        existing.first_name = access.user.first_name || "";
        existing.last_name = access.user.last_name || "";
        existing.username = access.user.username || "";
        await putCommunity(env, projectId, data);
        return json({ ok: true, comment: existing });
      }

      if (parentId && !data.comments.some(c => String(c.id) === parentId)) return json({ error: "parent comment not found" }, 404);
      const comment = {
        id: crypto.randomUUID(), user_id: uid, telegram_id: uid,
        username: access.user.username || "", first_name: access.user.first_name || "",
        last_name: access.user.last_name || "", telegram_name: telegramName,
        text, chapter: parentId ? (data.comments.find(c => String(c.id) === parentId)?.chapter ?? chapter) : chapter,
        parent_id: parentId || null, loves: {}, created_at: nowSec(), updated_at: nowSec()
      };
      data.comments.push(comment);
      await putCommunity(env, projectId, data);
      await env.LIBRARY.put("web-point-version", `${Date.now()}-${crypto.randomUUID()}`);

      const interaction = await getInteraction(env, projectId);
      interaction.comments = data.comments.length;
      await saveInteraction(env, projectId, interaction);

      if (parentId) {
        const parent = data.comments.find(c => String(c.id) === parentId);
        const parentOwner = parent ? String(parent.user_id || parent.telegram_id || "") : "";
        if (parentOwner && parentOwner !== uid) {
          const rootCommentId = (() => {
            let r = parent;
            let guard = 0;
            while (r && r.parent_id && guard++ < 100) {
              const next = data.comments.find(c => String(c.id) === String(r.parent_id));
              if (!next) break;
              r = next;
            }
            return r ? String(r.id) : parentId;
          })();
          const targetChapter = comment.chapter ?? parent.chapter ?? null;
          await addNotification(env, parentOwner, {
            type: "comment_reply",
            target_type: "comment",
            project_id: projectId,
            comment_id: comment.id,
            parent_id: parentId,
            root_comment_id: rootCommentId,
            chapter: targetChapter,
            actor_id: uid,
            actor_name: telegramName || access.user.username || "Reader",
            text: `${telegramName || access.user.username || "Reader"} membalas komentarmu: ${text.slice(0, 180)}`
          });
        }
      }

      const summary = summarizeInteraction(interaction, uid, data.comments.length);
      return json({ ok: true, comment, comments: data.comments.length, interaction: summary });
    }

    if (url.pathname === "/api/love" && request.method === "POST") {
      const access = await requireApiAccess(request, env);
      if (!access.ok) return json({ ok: false, code: access.code }, access.code);
      
      const uid = String(access.user.id);
      const isAllowed = await checkRateLimit(env, uid);
      if (!isAllowed) return json({ error: "Tolong jangan spam like! Tunggu beberapa detik." }, 429);

      const body = await request.json().catch(() => ({}));
      const projectId = String(body.project_id || "").trim();
      const targetType = String(body.target_type || "").trim();
      const targetId = String(body.target_id || "").trim();
      if (!projectId || !["comment", "review"].includes(targetType) || !targetId) return json({ error: "invalid love target" }, 400);

      const data = await getCommunity(env, projectId);
      const list = targetType === "comment" ? data.comments : data.reviews;
      const target = list.find(x => String(x.id) === targetId);
      if (!target) return json({ error: "target not found" }, 404);
      target.loves = target.loves && typeof target.loves === "object" ? target.loves : {};
      
      const loved = Object.prototype.hasOwnProperty.call(target.loves, uid);
      if (loved) delete target.loves[uid]; else target.loves[uid] = true;
      await putCommunity(env, projectId, data);

      const loveCount = Object.keys(target.loves).length;
      const interaction = await getInteraction(env, projectId);
      return json({ ok: true, loved: !loved, love_count: loveCount, target_type: targetType, target_id: targetId, comments: data.comments.length, reviews: data.reviews.length, interaction: summarizeInteraction(interaction, uid, data.comments.length) });
    }

    if (url.pathname === "/api/notifications" && request.method === "GET") {
      const access = await requireApiAccess(request, env);
      if (!access.ok) return json({ ok: false, code: access.code }, access.code);

      const notifications = await getNotifications(env, access.user.id);
      return json({
        ok: true,
        notifications: notifications.slice(0, 100)
      });
    }

    if (url.pathname === "/api/notifications/read" && request.method === "POST") {
      const access = await requireApiAccess(request, env);
      if (!access.ok) return json({ ok: false, code: access.code }, access.code);

      const body = await request.json().catch(() => ({}));
      const notificationId = String(body.id || "").trim();
      if (!notificationId) return json({ error: "missing notification id" }, 400);

      const notifications = await getNotifications(env, access.user.id);
      let found = false;

      for (const item of notifications) {
        if (String(item.id) === notificationId) {
          item.read = true;
          found = true;
          break;
        }
      }

      if (found) {
        await putNotifications(env, access.user.id, notifications);
      }

      return json({ ok: true, found });
    }

    return env.ASSETS.fetch(request);
  }
};
