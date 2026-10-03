import { checkAccess } from "./auth.js";

const cors = (extra = {}) => ({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS, PUT",
  "access-control-allow-headers": "authorization, content-type, x-library-secret",
  ...extra
});

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: cors({ "content-type": "application/json; charset=utf-8" })
});

const nowSec = () => Math.floor(Date.now() / 1000);

async function getCommunity(env, projectId) {
  const data = await env.LIBRARY.get(`community_${projectId}`, "json");
  return data || { reviews: [], comments: [] };
}

async function putCommunity(env, projectId, data) {
  await env.LIBRARY.put(`community_${projectId}`, JSON.stringify(data));
}

async function getInteraction(env, projectId) {
  const data = await env.LIBRARY.get(`interaction_${projectId}`, "json");
  return data || { views: 0, votes: {}, comments: 0 };
}

async function saveInteraction(env, projectId, data) {
  await env.LIBRARY.put(`interaction_${projectId}`, JSON.stringify(data));
}

function summarizeInteraction(interaction, uid, commentCount = 0) {
  let scoreSum = 0;
  let scoreCount = 0;
  for (const v of Object.values(interaction.votes || {})) {
    if (v >= 1 && v <= 10) {
      scoreSum += v;
      scoreCount++;
    }
  }
  return {
    views: interaction.views || 0,
    score: scoreCount > 0 ? Number((scoreSum / scoreCount).toFixed(2)) : 0,
    votes: scoreCount,
    comments: commentCount,
    user_vote: uid && interaction.votes && interaction.votes[uid] ? interaction.votes[uid] : null
  };
}

async function getNotifications(env, userId) {
  const data = await env.LIBRARY.get(`notifications_${userId}`, "json");
  return data || [];
}

async function putNotifications(env, userId, notifications) {
  await env.LIBRARY.put(`notifications_${userId}`, JSON.stringify(notifications));
}

async function addNotification(env, userId, notification) {
  const notifications = await getNotifications(env, userId);
  notification.id = crypto.randomUUID();
  notification.created_at = nowSec();
  notification.read = false;
  notifications.unshift(notification);
  await putNotifications(env, userId, notifications.slice(0, 100)); // Keep last 100
}

function isModUser(env, userId) {
  if (!env.MOD_USERS) return false;
  const mods = env.MOD_USERS.split(',').map(s => String(s).trim());
  return mods.includes(String(userId));
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

// System Anti-Spam (Rate Limiting) menggunakan KV
// Membatasi request user berdasarkan Telegram ID
async function checkRateLimit(env, userId) {
  const key = `ratelimit_${userId}`;
  const limit = 3; // Maksimal 3 request...
  const windowSec = 10; // ...dalam 10 detik

  let record = await env.LIBRARY.get(key, "json");
  const now = nowSec();

  if (!record) {
    record = { count: 1, reset_at: now + windowSec };
  } else {
    if (now > record.reset_at) {
      // Waktu sudah lewat, reset counter
      record = { count: 1, reset_at: now + windowSec };
    } else {
      record.count += 1;
      if (record.count > limit) {
         return false; // Rate limit tercapai, blokir!
      }
    }
  }

  // Simpan kembali ke KV dengan waktu kedaluwarsa sesuai sisa windowSec agar hemat memori
  await env.LIBRARY.put(key, JSON.stringify(record), { expirationTtl: 60 }); 
  return true;
}

function displayCallFromUser(user) {
  return user.username ? `@${user.username}` : (user.first_name || "Reader");
}

async function requireApiAccess(request, env) {
  return await checkAccess(request, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }

    if (url.pathname === "/api/catalog" && request.method === "GET") {
      const access = await checkAccess(request, env);
      if (!access.ok) {
        return json({ ok: false, code: access.code }, access.code);
      }

      const raw = await env.LIBRARY.get("catalog");
      if (!raw) return json([]);
      const catalog = JSON.parse(raw);

      return new Response(JSON.stringify(catalog), {
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

    // NOVEL: store HTML with BOOK-aware keys.
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

    // NOVEL: reader endpoint.
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

      // Backward compatibility
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

    // =========================
    // COMMUNITY: REVIEWS / COMMENTS
    // =========================

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
      
      // IMPLEMENTASI RATE LIMITING
      const isAllowed = await checkRateLimit(env, uid);
      if (!isAllowed) {
        return json({ error: "Tolong jangan spam! Tunggu beberapa detik sebelum mengirim lagi." }, 429);
      }

      const body = await request.json().catch(() => ({}));
      const projectId = String(body.project_id || "").trim();
      const text = String(body.text || "").trim();
      const reviewId = String(body.review_id || "").trim();
      const hasScore = body.score !== undefined && body.score !== null && body.score !== "";
      const score = hasScore ? Number(body.score) : null;
      if (!projectId) return json({ error: "project required" }, 400);
      if (text.length > 2000) return json({ error: "review too long" }, 400);
      if (hasScore && (!Number.isInteger(score) || score < 1 || score > 10)) return json({ error: "invalid review score" }, 400);

      const catalog = await env.LIBRARY.get("catalog", "json");
      if (!Array.isArray(catalog) || !catalog.some(p => String(p.id) === projectId)) return json({ error: "project not found" }, 404);

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
      
      // IMPLEMENTASI RATE LIMITING
      const isAllowed = await checkRateLimit(env, uid);
      if (!isAllowed) {
        return json({ error: "Tolong jangan spam! Tunggu beberapa detik sebelum mengirim lagi." }, 429);
      }

      const body = await request.json().catch(() => ({}));
      const projectId = String(body.project_id || "").trim();
      const text = String(body.text || "").trim();
      const commentId = String(body.comment_id || "").trim();
      const parentId = String(body.parent_id || "").trim();
      const chapter = body.chapter == null || body.chapter === "" ? null : String(body.chapter);
      if (!projectId) return json({ error: "missing project_id" }, 400);
      if (!text && body.action !== "delete") return json({ error: "empty comment" }, 400);
      if (text.length > 2000) return json({ error: "comment too long" }, 400);
      const catalog = await env.LIBRARY.get("catalog", "json");
      if (!Array.isArray(catalog) || !catalog.some(p => String(p.id) === projectId)) return json({ error: "project not found" }, 404);
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
      
      // IMPLEMENTASI RATE LIMITING UNTUK LIKE
      const isAllowed = await checkRateLimit(env, uid);
      if (!isAllowed) {
        return json({ error: "Tolong jangan spam like! Tunggu beberapa detik." }, 429);
      }

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

    // =========================
    // NOTIFICATIONS
    // =========================

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
