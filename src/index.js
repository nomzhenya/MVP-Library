
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
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
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
          username: access.user.username || ""
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

    return env.ASSETS.fetch(request);
  }
};
