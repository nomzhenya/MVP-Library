
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
    comments: Number(data.comments || fallbackComments || 0),
    user_vote: Number(votes[String(userId)] || 0),
    bookmarked: Object.prototype.hasOwnProperty.call(bookmarks, String(userId))
  };
}

async function saveInteraction(env, projectId, data) {
  await env.LIBRARY.put(`interaction:${projectId}`, JSON.stringify(data));
}

async function enrichCatalog(env, catalog, userId) {
  if (!Array.isArray(catalog)) return [];
  return Promise.all(catalog.map(async p => {
    const data = await getInteraction(env, p.id);
    const summary = summarizeInteraction(data, userId, 0);
    return {...p, rating: summary.rating, bookmarks: summary.bookmarks, user_vote: summary.user_vote, bookmarked: summary.bookmarked};
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

function latestProjectStamp(project) {
  if (!project || typeof project !== "object") return 0;
  const chapters = Array.isArray(project.chapters) ? project.chapters : [];
  let latest = Number(project.updated_at || 0) || 0;
  for (const ch of chapters) {
    const ts = Number(ch?.updated_at || 0) || 0;
    if (ts > latest) latest = ts;
  }
  return latest;
}

function projectUpdateChanged(oldProject, newProject) {
  if (!oldProject) return false;
  const oldStamp = latestProjectStamp(oldProject);
  const newStamp = latestProjectStamp(newProject);
  if (newStamp > oldStamp) return true;
  const oldChapters = Array.isArray(oldProject.chapters) ? oldProject.chapters : [];
  const newChapters = Array.isArray(newProject.chapters) ? newProject.chapters : [];
  if (newChapters.length !== oldChapters.length) return true;
  const oldKeys = new Set(oldChapters.map(ch => `${String(ch?.chapter ?? "")}|${Number(ch?.decensored || 0)}|${Number(ch?.updated_at || 0)}`));
  return newChapters.some(ch => !oldKeys.has(`${String(ch?.chapter ?? "")}|${Number(ch?.decensored || 0)}|${Number(ch?.updated_at || 0)}`));
}

async function notifyBookmarkedProjectUpdate(env, project) {
  const projectId = String(project?.id || "").trim();
  if (!projectId) return 0;
  const interaction = await getInteraction(env, projectId);
  const bookmarks = interaction.bookmarks || {};
  const title = String(project.title || projectId);
  const latest = Array.isArray(project.chapters) && project.chapters.length
    ? project.chapters.reduce((a,b) => latestProjectStamp({chapters:[a]}) >= latestProjectStamp({chapters:[b]}) ? a : b)
    : null;
  const chapterText = latest?.chapter != null ? `Chapter ${latest.chapter}` : "Project update";
  let sent = 0;
  for (const uid of Object.keys(bookmarks)) {
    if (!bookmarks[uid]) continue;
    await addNotification(env, uid, {
      type: "project_update",
      project_id: projectId,
      text: `${title} diperbarui · ${chapterText}`
    });
    sent++;
  }
  return sent;
}

async function saveReviewEvent(env, review) {
  if (!review?.id || !review?.user_id || !review?.project_id) return;
  const uid = String(review.user_id);
  const projectId = String(review.project_id);
  // Stable award key: one review point per user per project, forever.
  const awardId = `review:${projectId}:${uid}`;
  await env.LIBRARY.put(`review_event:${awardId}`, JSON.stringify({
    id: awardId,
    review_id: String(review.id),
    project_id: projectId,
    user_id: uid,
    created_at: Number(review.created_at || nowSec())
  }));
}

async function saveCommentEvent(env, comment) {
  if (!comment?.id || !comment?.user_id) return;
  await env.LIBRARY.put(`comment_event:${String(comment.id)}`, JSON.stringify({
    id: String(comment.id),
    project_id: String(comment.project_id || ""),
    user_id: String(comment.user_id),
    created_at: Number(comment.created_at || nowSec()),
    parent_id: comment.parent_id || null
  }));
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
          telegram_name: [access.user.first_name, access.user.last_name].filter(Boolean).join(" ").trim()
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
      data.votes[String(access.user.id)] = score;
      await saveInteraction(env, projectId, data);
      return json({ok:true, ...summarizeInteraction(data, access.user.id, catalog.find(p=>String(p.id)===projectId)?.comments || 0)});
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
      return json({ok:true, ...summarizeInteraction(data, access.user.id, catalog.find(p=>String(p.id)===projectId)?.comments || 0)});
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

    if (url.pathname === "/api/admin/comment-events" && request.method === "GET") {
      const secret = request.headers.get("X-Library-Secret") || "";
      if (!env.LIBRARY_SECRET || secret !== env.LIBRARY_SECRET) {
        return json({ok:false, reason:"unauthorized"}, 401);
      }

      // The point sync uses independent streams for comments and reviews.
      // A shared cursor is unsafe because two different event types can have
      // identical timestamps and different IDs, which can cause one stream
      // to jump past an event from the other stream.
      const stream = String(url.searchParams.get("stream") || "all").toLowerCase();
      const since = Number(url.searchParams.get("since") || 0);
      const sinceId = String(url.searchParams.get("since_id") || "");
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 200)));

      const prefixes = stream === "reviews"
        ? ["review_event:"]
        : stream === "comments"
          ? ["comment_event:"]
          : ["comment_event:", "review_event:"];

      const events = [];
      for (const prefix of prefixes) {
        const keys = [];
        let listCursor;
        do {
          const page = await env.LIBRARY.list({prefix, limit:1000, ...(listCursor ? {cursor:listCursor} : {})});
          for (const k of page.keys || []) keys.push(k.name);
          listCursor = page.list_complete ? null : page.cursor;
        } while (listCursor && keys.length < 5000);

        for (let i = 0; i < keys.length; i += 50) {
          const chunk = await Promise.all(keys.slice(i, i + 50).map(k => env.LIBRARY.get(k, "json")));
          for (const ev of chunk) {
            if (!ev) continue;
            const ts = Number(ev.created_at || 0);
            const id = String(ev.id || "");
            if (ts > since || (ts === since && id > sinceId)) events.push(ev);
          }
        }
      }

      events.sort((a,b) => Number(a.created_at||0)-Number(b.created_at||0) || String(a.id||"").localeCompare(String(b.id||"")));
      const out = events.slice(0, limit);
      const last = out[out.length - 1];
      const nextCursor = last
        ? {created_at:Number(last.created_at||0), id:String(last.id||"")}
        : {created_at:since, id:sinceId};

      return json({
        ok:true,
        stream,
        comments:out.filter(ev => !String(ev.id||"").startsWith("review:")),
        reviews:out.filter(ev => String(ev.id||"").startsWith("review:")),
        cursor:nextCursor,
        has_more:events.length > out.length
      });
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

      const oldCatalog = await env.LIBRARY.get("catalog", "json");
      const oldMap = new Map(Array.isArray(oldCatalog) ? oldCatalog.map(p => [String(p.id), p]) : []);
      await env.LIBRARY.put("catalog", JSON.stringify(body));

      let notificationsSent = 0;
      for (const project of body) {
        const oldProject = oldMap.get(String(project?.id || ""));
        if (projectUpdateChanged(oldProject, project)) {
          notificationsSent += await notifyBookmarkedProjectUpdate(env, project);
        }
      }
      return json({ok: true, count: body.length, notifications_sent: notificationsSent});
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
      const interaction = await getInteraction(env, projectId);
      const cleanReview = data.reviews.map(r => {
        const loves = r.loved_by && typeof r.loved_by === "object" ? r.loved_by : {};
        const {loved_by, ...safeReview} = r;
        return {
          ...safeReview,
          score: Number(interaction.votes[String(r.user_id || r.telegram_id)] || r.score || 0),
          love_count: Object.keys(loves).length,
          user_loved: !!loves[uid]
        };
      }).sort((a,b) => Number(b.created_at || 0) - Number(a.created_at || 0));
      const cleanComments = data.comments.map(c => {
        const loves = c.loved_by && typeof c.loved_by === "object" ? c.loved_by : {};
        const {loved_by, ...safeComment} = c;
        return {
          ...safeComment,
          love_count: Object.keys(loves).length,
          user_loved: !!loves[uid]
        };
      }).sort((a,b) => Number(b.created_at || 0) - Number(a.created_at || 0));

      return new Response(JSON.stringify({
        ok: true,
        reviews: cleanReview,
        comments: cleanComments
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
      const requestedScore = body.score == null || body.score === "" ? null : Number(body.score);
      if (!projectId) return json({error:"project required"}, 400);
      if (text.length > 2000) return json({error:"review too long"}, 400);
      if (requestedScore !== null && (!Number.isInteger(requestedScore) || requestedScore < 1 || requestedScore > 10)) {
        return json({error:"invalid review rating"}, 400);
      }

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
        return json({ok:true});
      }

      let existing = data.reviews.find(r => String(r.user_id || r.telegram_id) === uid);
      if (reviewId) {
        existing = data.reviews.find(r => String(r.id) === reviewId);
        if (!existing || String(existing.user_id || existing.telegram_id) !== uid) return json({error:"review not found or forbidden"}, 404);
      }

      if (existing) {
        if (!text && !reviewId) return json({error:"review text required"}, 400);
        existing.text = text;
        existing.score = requestedScore !== null ? requestedScore : Number(interaction.votes[uid] || existing.score || 0);
        if (existing.score < 1 || existing.score > 10) return json({error:"review rating required"}, 400);
        interaction.votes[uid] = existing.score;
        existing.updated_at = now;
        existing.telegram_name = telegramName;
        existing.first_name = access.user.first_name || "";
        existing.last_name = access.user.last_name || "";
        existing.username = access.user.username || "";
      } else {
        if (!text) return json({error:"review text required"}, 400);
        const score = requestedScore !== null ? requestedScore : Number(interaction.votes[uid] || 0);
        if (!score || score < 1 || score > 10) return json({error:"review rating required"}, 400);
        interaction.votes[uid] = score;
        existing = {
          id: crypto.randomUUID(), user_id: uid, telegram_id: uid,
          username: access.user.username || "", first_name: access.user.first_name || "",
          last_name: access.user.last_name || "", telegram_name: telegramName,
          score, text, created_at: now, updated_at: now, loved_by: {},
          project_id: projectId
        };
        data.reviews.push(existing);
        await saveReviewEvent(env, existing);
      }
      await putCommunity(env, projectId, data);
      await saveInteraction(env, projectId, interaction);
      return json({ok:true, review:existing, interaction:summarizeInteraction(interaction, access.user.id)});
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
        return json({ok:true});
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
        parent_id: parentId || null, created_at: nowSec(), updated_at: nowSec(), loved_by: {},
        project_id: projectId
      };
      data.comments.push(comment);
      await putCommunity(env, projectId, data);
      await saveCommentEvent(env, comment);

      // Notify the owner of the parent comment when someone replies.
      if (parentId) {
        const parent = data.comments.find(c => String(c.id) === parentId);
        const parentOwner = parent ? String(parent.user_id || parent.telegram_id || "") : "";
        if (parentOwner && parentOwner !== uid) {
          await addNotification(env, parentOwner, {
            type: "comment_reply",
            project_id: projectId,
            comment_id: comment.id,
            parent_id: parentId,
            actor_id: uid,
            actor_name: telegramName || access.user.username || "Reader",
            text: `${telegramName || access.user.username || "Reader"} membalas komentarmu: ${text.slice(0, 180)}`
          });
        }
      }

      return json({ok:true, comment});
    }

    if (url.pathname === "/api/love" && request.method === "POST") {
      const access = await requireApiAccess(request, env);
      if (!access.ok) return json({ok:false, code:access.code}, access.code);
      const body = await request.json().catch(() => ({}));
      const projectId = String(body.project_id || "").trim();
      const targetType = String(body.target_type || "").trim();
      const targetId = String(body.target_id || "").trim();
      if (!projectId || !["comment","review"].includes(targetType) || !targetId) return json({error:"invalid love target"}, 400);

      const data = await getCommunity(env, projectId);
      const list = targetType === "comment" ? data.comments : data.reviews;
      const item = list.find(x => String(x.id) === targetId);
      if (!item) return json({error:"target not found"}, 404);
      item.loved_by = item.loved_by && typeof item.loved_by === "object" ? item.loved_by : {};
      const uid = String(access.user.id);
      const loved = !!item.loved_by[uid];
      if (loved) delete item.loved_by[uid]; else item.loved_by[uid] = true;
      await putCommunity(env, projectId, data);
      return json({ok:true, loved:!loved, love_count:Object.keys(item.loved_by).length});
    }

    // =========================
    // NOTIFICATIONS
    // =========================

    if (url.pathname === "/api/notifications" && request.method === "GET") {
      const access = await requireApiAccess(request, env);
      if (!access.ok) return json({ok:false, code:access.code}, access.code);

      const notifications = await getNotifications(env, access.user.id);
      const allowed = notifications.filter(n => ["project_update", "comment_reply"].includes(String(n.type || "")));
      return json({
        ok: true,
        notifications: allowed.slice(0, 100)
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
