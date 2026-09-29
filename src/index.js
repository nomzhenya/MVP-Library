
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
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {"content-type": "application/json; charset=utf-8"}
  });

function cors(headers = {}) {
  return {
    ...headers,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "Content-Type,X-Library-Secret,X-Telegram-Init-Data"
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

  const webAppKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("WebAppData"),
    {name: "HMAC", hash: "SHA-256"},
    false,
    ["sign"]
  );
  const secretKeyBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", webAppKey, new TextEncoder().encode(botToken))
  );
  const secretKey = await crypto.subtle.importKey(
    "raw",
    secretKeyBytes,
    {name: "HMAC", hash: "SHA-256"},
    false,
    ["sign"]
  );

  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", secretKey, new TextEncoder().encode(dataCheckString))
  );

  const expectedHash = [...signature].map(b => b.toString(16).padStart(2, "0")).join("");
  if (expectedHash !== receivedHash) return null;

  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

async function telegramMemberStatus(env, chatId, userId) {
  const r = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(userId)}`
  );
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
  if (!user.username || user.username.trim() === "") {
    return {ok: false, code: 403};
  }

  const CHANNEL_ID = env.MVP_CHANNEL_ID || "-1004459399775";
  const DISCUSSION_ID = env.MVP_DISCUSSION_ID || "-1003923062839";

  if (!CHANNEL_ID || !DISCUSSION_ID) {
    return {ok: false, code: 503};
  }

  const [mvp, discussion] = await Promise.all([
    telegramMemberStatus(env, CHANNEL_ID, user.id),
    telegramMemberStatus(env, DISCUSSION_ID, user.id)
  ]);

  if (mvp !== true || discussion !== true) {
    return {ok: false, code: 403};
  }

  return {ok: true, user};
}


async function getInteraction(env, projectId) {
  const data = await env.LIBRARY.get(`interaction:${projectId}`, "json");
  if (!data || typeof data !== "object") return {votes:{}, bookmarks:{}, comments:0};
  return {
    votes: data.votes && typeof data.votes === "object" ? data.votes : {},
    bookmarks: data.bookmarks && typeof data.bookmarks === "object" ? data.bookmarks : {},
    comments: Number(data.comments || 0)
  };
}

function summarizeInteraction(data, userId, fallbackComments=0) {
  const votes = data.votes || {};
  const bookmarks = data.bookmarks || {};
  const values = Object.values(votes).map(Number).filter(v => Number.isInteger(v) && v >= 1 && v <= 10);
  const rating = values.length ? (values.reduce((a,b)=>a+b,0) / values.length).toFixed(1) : "0.0";

  // Five compact display bands from the underlying 1-10 voting system:
  // 5★ = 9-10, 4★ = 7-8, 3★ = 5-6, 2★ = 3-4, 1★ = 1-2.
  const vote_distribution = [0,0,0,0,0];
  values.forEach(v => {
    const band = 5 - Math.ceil(v / 2); // 10/9=>0 (5★), ... 2/1=>4 (1★)
    vote_distribution[Math.max(0, Math.min(4, band))]++;
  });

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
  if (mod) {
    // Mod public identity never exposes Telegram username.
    delete out.username;
  }
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
function nowSec() { return Math.floor(Date.now() / 1000); }

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
  list.unshift({
    id: crypto.randomUUID(),
    created_at: nowSec(),
    read: false,
    ...notification
  });
  await putNotifications(env, uid, list);
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
      return new Response(null, {headers: cors()});
    }

    if (url.pathname === "/api/access" && request.method === "GET") {
      const access = await checkAccess(request, env);
      if (!access.ok) {
        return json(
          {ok: false, code: access.code},
          access.code === 403 ? 403 : access.code === 401 ? 401 : 503
        );
      }
      return new Response(JSON.stringify({
        ok: true,
        user: {
          id: String(access.user.id),
          username: access.user.username || "",
          first_name: access.user.first_name || "",
          last_name: access.user.last_name || "",
          telegram_name: [access.user.first_name, access.user.last_name].filter(Boolean).join(" ").trim(),
          is_mod: isModUser(env, access.user.id)
        }
      }), {
        headers: cors({"content-type": "application/json; charset=utf-8"})
      });
    }

    if (url.pathname === "/api/catalog" && request.method === "GET") {
      const access = await checkAccess(request, env);
      if (!access.ok) {
        return json({ok: false, code: access.code}, access.code);
      }

      const catalog = await env.LIBRARY.get("catalog", "json");
      const enriched = await enrichCatalog(env, catalog || [], access.user.id);
      return new Response(JSON.stringify(enriched), {
        headers: cors({"content-type": "application/json; charset=utf-8"})
      });
    }


    if (url.pathname === "/api/vote" && request.method === "POST") {
      const access = await checkAccess(request, env);
      if (!access.ok) return json({ok:false, code:access.code}, access.code);
      const body = await request.json().catch(() => ({}));
      const projectId = String(body.project_id || "").trim();
      const score = Number(body.score);
      if (!projectId || !Number.isInteger(score) || score < 1 || score > 10) return json({error:"invalid vote"},400);
      const catalog = await env.LIBRARY.get("catalog","json");
      if (!Array.isArray(catalog) || !catalog.some(p => String(p.id) === projectId)) return json({error:"project not found"},404);
      const data = await getInteraction(env, projectId);
      const uid = String(access.user.id);
      data.votes[uid] = score;
      const community = await getCommunity(env, projectId);
      const ownReview = community.reviews.find(r => String(r.user_id || r.telegram_id) === uid);
      if (ownReview) {
        ownReview.score = score;
        ownReview.updated_at = nowSec();
        await putCommunity(env, projectId, community);
      }
      await saveInteraction(env, projectId, data);
      return json({ok:true, reviews:community.reviews.length, ...summarizeInteraction(data, access.user.id, community.comments.length)});
    }

    if (url.pathname === "/api/bookmark" && request.method === "POST") {
      const access = await checkAccess(request, env);
      if (!access.ok) return json({ok:false, code:access.code}, access.code);
      const body = await request.json().catch(() => ({}));
      const projectId = String(body.project_id || "").trim();
      const bookmarked = Boolean(body.bookmarked);
      if (!projectId) return json({error:"missing project_id"},400);
      const catalog = await env.LIBRARY.get("catalog","json");
      if (!Array.isArray(catalog) || !catalog.some(p => String(p.id) === projectId)) return json({error:"project not found"},404);
      const data = await getInteraction(env, projectId);
      const uid = String(access.user.id);
      if (bookmarked) data.bookmarks[uid] = true; else delete data.bookmarks[uid];
      await saveInteraction(env, projectId, data);
      const community = await getCommunity(env, projectId);
      return json({ok:true, reviews:community.reviews.length, ...summarizeInteraction(data, access.user.id, community.comments.length)});
    }

    
    if (url.pathname === "/api/admin/comment-stats" && request.method === "PUT") {
      const secret = request.headers.get("X-Library-Secret") || "";
      if (!env.LIBRARY_SECRET || secret !== env.LIBRARY_SECRET) {
        return json({ok:false, reason:"unauthorized"}, 401);
      }
      const body = await request.json().catch(() => null);
      if (!body || !Array.isArray(body.projects)) {
        return json({ok:false, reason:"invalid_payload"}, 400);
      }
      for (const item of body.projects) {
        if (!item?.id) continue;
        const current = await getStats(env, item.id);
        await putStats(env, item.id, {
          ...current,
          comments: Number(item.comments || 0)
        });
      }
      return json({ok:true, updated: body.projects.length});
    }

if (url.pathname === "/api/admin/catalog" && request.method === "PUT") {
      const secret = request.headers.get("x-library-secret");
      if (!env.LIBRARY_SECRET || secret !== env.LIBRARY_SECRET) {
        return json({error: "unauthorized"}, 401);
      }

      const body = await request.json();
      if (!Array.isArray(body)) {
        return json({error: "catalog must be an array"}, 400);
      }

      await env.LIBRARY.put("catalog", JSON.stringify(body));
      return json({ok: true, count: body.length});
    }

    // TAMBAHAN: Endpoint Menerima Text HTML Novel dari Bot
    if (url.pathname === "/api/admin/novel" && request.method === "PUT") {
      const secret = request.headers.get("x-library-secret");
      if (!env.LIBRARY_SECRET || secret !== env.LIBRARY_SECRET) {
        return json({error: "unauthorized"}, 401);
      }

      const body = await request.json();
      const key = `novel_${body.project_id}_${body.chapter}_${body.decensored}`;
      await env.LIBRARY.put(key, JSON.stringify({html: body.html}));
      return json({ok: true});
    }

    // TAMBAHAN: Endpoint Mengirim Text HTML Novel ke Mini Web Reader
    if (url.pathname === "/api/novel" && request.method === "GET") {
      const access = await checkAccess(request, env);
      if (!access.ok) {
        return json({ok: false, code: access.code}, access.code);
      }

      const pid = url.searchParams.get("project_id");
      const ch = url.searchParams.get("chapter");
      const dec = url.searchParams.get("decensored");
      
      const key = `novel_${pid}_${ch}_${dec}`;
      const data = await env.LIBRARY.get(key, "json");
      
      if (!data) return json({error: "not found"}, 404);

      return new Response(JSON.stringify(data), {
        headers: cors({"content-type": "application/json; charset=utf-8"})
      });
    }

    if (url.pathname === "/api/file" && request.method === "GET") {
      const access = await checkAccess(request, env);
      if (!access.ok) {
        return json({ok: false, code: access.code}, access.code);
      }
      const fileId = url.searchParams.get("file_id");
      if (!fileId) return new Response("Missing file_id", {status: 400});

      if (!env.TELEGRAM_BOT_TOKEN) {
        return new Response("Telegram file proxy is not configured", {status: 503});
      }

      const tg = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`
      );
      const info = await tg.json();

      if (!info.ok || !info.result?.file_path) {
        return new Response("Telegram file not found", {status: 404});
      }

      const file = await fetch(
        `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${info.result.file_path}`
      );

      if (!file.ok) {
        return new Response("Unable to fetch Telegram file", {status: 502});
      }

      const headers = new Headers(cors({
        "cache-control": "public, max-age=3600",
        "content-type": file.headers.get("content-type") || "image/jpeg"
      }));
      return new Response(file.body, {status: 200, headers});
    }


    // =========================
    // COMMUNITY: REVIEWS / COMMENTS
    // =========================

    if (url.pathname === "/api/community" && request.method === "GET") {
      const access = await requireApiAccess(request, env);
      if (!access.ok) return json({ok:false, code:access.code}, access.code);

      const projectId = String(url.searchParams.get("project_id") || "").trim();
      if (!projectId) return json({error:"missing project_id"}, 400);

      const data = await getCommunity(env, projectId);
      const uid = String(access.user.id);
      const decorate = (item) => {
        item.loves = item.loves && typeof item.loves === "object" ? item.loves : {};
        const out = {...item, love_count:Object.keys(item.loves).length, user_loved:Object.prototype.hasOwnProperty.call(item.loves, uid), is_mod:isModUser(env, item.user_id || item.telegram_id)};
        if (out.is_mod) delete out.username;
        return out;
      };
      data.reviews = data.reviews.map(decorate).sort((a,b) => Number(b.created_at || 0) - Number(a.created_at || 0));
      data.comments = data.comments.map(decorate).sort((a,b) => Number(b.created_at || 0) - Number(a.created_at || 0));

      return new Response(JSON.stringify({
        ok: true,
        reviews: data.reviews,
        comments: data.comments,
        review_count: data.reviews.length,
        comment_count: data.comments.length
      }), {
        headers: cors({"content-type":"application/json; charset=utf-8"})
      });
    }

    if (url.pathname === "/api/review" && request.method === "POST") {
      const access = await requireApiAccess(request, env);
      if (!access.ok) return json({ok:false, code:access.code}, access.code);

      const body = await request.json().catch(() => ({}));
      const projectId = String(body.project_id || "").trim();
      const text = String(body.text || "").trim();
      const reviewId = String(body.review_id || "").trim();
      const hasScore = body.score !== undefined && body.score !== null && body.score !== "";
      const score = hasScore ? Number(body.score) : null;
      if (!projectId) return json({error:"project required"}, 400);
      if (text.length > 2000) return json({error:"review too long"}, 400);
      if (hasScore && (!Number.isInteger(score) || score < 1 || score > 10)) return json({error:"invalid review score"}, 400);

      const catalog = await env.LIBRARY.get("catalog", "json");
      if (!Array.isArray(catalog) || !catalog.some(p => String(p.id) === projectId)) return json({error:"project not found"}, 404);

      const data = await getCommunity(env, projectId);
      data.reviews = Array.isArray(data.reviews) ? data.reviews : [];
      const uid = String(access.user.id);
      const now = nowSec();
      const telegramName = [access.user.first_name, access.user.last_name].filter(Boolean).join(" ").trim();
      const interaction = await getInteraction(env, projectId);

      if (body.action === "delete") {
        const idx = data.reviews.findIndex(r => String(r.id) === reviewId && String(r.user_id || r.telegram_id) === uid);
        if (idx < 0) return json({error:"review not found or forbidden"}, 404);
        data.reviews.splice(idx, 1);
        await putCommunity(env, projectId, data);
        const summary = summarizeInteraction(interaction, uid, data.comments.length);
        return json({ok:true, reviews:data.reviews.length, interaction:summary});
      }

      let existing = data.reviews.find(r => String(r.user_id || r.telegram_id) === uid);
      if (reviewId) {
        existing = data.reviews.find(r => String(r.id) === reviewId);
        if (!existing || String(existing.user_id || existing.telegram_id) !== uid) return json({error:"review not found or forbidden"}, 404);
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
        if (!text) return json({error:"review text required"}, 400);
        if (!hasScore) return json({error:"review score required"}, 400);
        interaction.votes[uid] = score;
        existing = {
          id: crypto.randomUUID(), user_id: uid, telegram_id: uid,
          username: access.user.username || "", first_name: access.user.first_name || "",
          last_name: access.user.last_name || "", telegram_name: telegramName,
          score, text, loves:{}, created_at: now, updated_at: now
        };
        data.reviews.push(existing);
      }

      await putCommunity(env, projectId, data);
      await saveInteraction(env, projectId, interaction);
      const summary = summarizeInteraction(interaction, uid, data.comments.length);
      return json({ok:true, review:existing, reviews:data.reviews.length, interaction:summary});
    }

    if (url.pathname === "/api/comment" && request.method === "POST") {
      const access = await requireApiAccess(request, env);
      if (!access.ok) return json({ok:false, code:access.code}, access.code);
      const body = await request.json().catch(() => ({}));
      const projectId = String(body.project_id || "").trim();
      const text = String(body.text || "").trim();
      const commentId = String(body.comment_id || "").trim();
      const parentId = String(body.parent_id || "").trim();
      const chapter = body.chapter == null || body.chapter === "" ? null : String(body.chapter);
      if (!projectId) return json({error:"missing project_id"}, 400);
      if (!text && body.action !== "delete") return json({error:"empty comment"}, 400);
      if (text.length > 2000) return json({error:"comment too long"}, 400);
      const catalog = await env.LIBRARY.get("catalog", "json");
      if (!Array.isArray(catalog) || !catalog.some(p => String(p.id) === projectId)) return json({error:"project not found"}, 404);
      const data = await getCommunity(env, projectId);
      data.comments = Array.isArray(data.comments) ? data.comments : [];
      const uid = String(access.user.id);
      const telegramName = [access.user.first_name, access.user.last_name].filter(Boolean).join(" ").trim();

      if (body.action === "delete") {
        const idx = data.comments.findIndex(c => String(c.id) === commentId && String(c.user_id || c.telegram_id) === uid);
        if (idx < 0) return json({error:"comment not found or forbidden"}, 404);
        data.comments.splice(idx, 1);
        await putCommunity(env, projectId, data);
        const interaction = await getInteraction(env, projectId);
        interaction.comments = data.comments.length;
        await saveInteraction(env, projectId, interaction);
        return json({ok:true, comments:data.comments.length, interaction:summarizeInteraction(interaction, uid, data.comments.length)});
      }

      if (commentId) {
        const existing = data.comments.find(c => String(c.id) === commentId);
        if (!existing || String(existing.user_id || existing.telegram_id) !== uid) return json({error:"comment not found or forbidden"}, 404);
        existing.text = text;
        existing.updated_at = nowSec();
        existing.edited_at = nowSec();
        existing.telegram_name = telegramName;
        existing.first_name = access.user.first_name || "";
        existing.last_name = access.user.last_name || "";
        existing.username = access.user.username || "";
        await putCommunity(env, projectId, data);
        return json({ok:true, comment:existing});
      }

      if (parentId && !data.comments.some(c => String(c.id) === parentId)) return json({error:"parent comment not found"}, 404);
      const comment = {
        id: crypto.randomUUID(), user_id: uid, telegram_id: uid,
        username: access.user.username || "", first_name: access.user.first_name || "",
        last_name: access.user.last_name || "", telegram_name: telegramName,
        text, chapter: parentId ? (data.comments.find(c => String(c.id) === parentId)?.chapter ?? chapter) : chapter,
        parent_id: parentId || null, loves: {}, created_at: nowSec(), updated_at: nowSec()
      };
      data.comments.push(comment);
      await putCommunity(env, projectId, data);

      const interaction = await getInteraction(env, projectId);
      interaction.comments = data.comments.length;
      await saveInteraction(env, projectId, interaction);

      // Notify the owner of the parent comment when someone replies.
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
      return json({ok:true, comment, comments:data.comments.length, interaction:summary});
    }

    if (url.pathname === "/api/love" && request.method === "POST") {
      const access = await requireApiAccess(request, env);
      if (!access.ok) return json({ok:false, code:access.code}, access.code);
      const body = await request.json().catch(() => ({}));
      const projectId = String(body.project_id || "").trim();
      const targetType = String(body.target_type || "").trim();
      const targetId = String(body.target_id || "").trim();
      if (!projectId || !["comment","review"].includes(targetType) || !targetId) return json({error:"invalid love target"},400);

      const data = await getCommunity(env, projectId);
      const list = targetType === "comment" ? data.comments : data.reviews;
      const target = list.find(x => String(x.id) === targetId);
      if (!target) return json({error:"target not found"},404);
      target.loves = target.loves && typeof target.loves === "object" ? target.loves : {};
      const uid = String(access.user.id);
      const loved = Object.prototype.hasOwnProperty.call(target.loves, uid);
      if (loved) delete target.loves[uid]; else target.loves[uid] = true;
      await putCommunity(env, projectId, data);

      const loveCount = Object.keys(target.loves).length;
      const interaction = await getInteraction(env, projectId);
      return json({ok:true, loved:!loved, love_count:loveCount, target_type:targetType, target_id:targetId, comments:data.comments.length, reviews:data.reviews.length, interaction:summarizeInteraction(interaction, uid, data.comments.length)});
    }

    // =========================
    // NOTIFICATIONS
    // =========================

    if (url.pathname === "/api/notifications" && request.method === "GET") {
      const access = await requireApiAccess(request, env);
      if (!access.ok) return json({ok:false, code:access.code}, access.code);

      const notifications = await getNotifications(env, access.user.id);
      return json({
        ok: true,
        notifications: notifications.slice(0, 100)
      });
    }

    if (url.pathname === "/api/notifications/read" && request.method === "POST") {
      const access = await requireApiAccess(request, env);
      if (!access.ok) return json({ok:false, code:access.code}, access.code);

      const body = await request.json().catch(() => ({}));
      const notificationId = String(body.id || "").trim();
      if (!notificationId) return json({error:"missing notification id"}, 400);

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

      return json({ok:true, found});
    }

    return env.ASSETS.fetch(request);
  }
};
