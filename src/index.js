const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {"content-type": "application/json; charset=utf-8"}
  });

function cors(headers = {}) {
  return {
    ...headers,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,PUT,POST,OPTIONS",
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
      return new Response(JSON.stringify(catalog || []), {
        headers: cors({"content-type": "application/json; charset=utf-8"})
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

      await env.LIBRARY.put("catalog", JSON.stringify(body));
      return json({ok: true, count: body.length});
    }

    // =========================================================
    // ENDPOINT BARU: MENERIMA VOTE & BOOKMARK DARI MINIWEB
    // =========================================================
    if (url.pathname === "/api/interact" && request.method === "POST") {
      const access = await checkAccess(request, env);
      if (!access.ok) return json({ok: false, code: access.code}, access.code);

      try {
        const body = await request.json();
        const data = {
          uid: access.user.id,
          action: body.action, // "vote", "bookmark", atau "unbookmark"
          pid: body.project_id,
          val: body.value, // angka 1-10 untuk vote
          ts: Date.now()
        };

        // Simpan ke Antrean (Queue) di Cloudflare KV
        let queue = await env.LIBRARY.get("interaction_queue", "json") || [];
        queue.push(data);
        await env.LIBRARY.put("interaction_queue", JSON.stringify(queue));

        return json({ok: true});
      } catch (e) {
        return json({ok: false, error: e.message}, 400);
      }
    }

    // =========================================================
    // ENDPOINT BARU: ZHENYA MENGAMBIL ANTREAN TIAP 1 MENIT
    // =========================================================
    if (url.pathname === "/api/admin/interactions" && request.method === "GET") {
      const secret = request.headers.get("x-library-secret");
      if (!env.LIBRARY_SECRET || secret !== env.LIBRARY_SECRET) return json({error: "unauthorized"}, 401);

      let queue = await env.LIBRARY.get("interaction_queue", "json") || [];
      if (queue.length > 0) {
        // Kosongkan antrean setelah diambil oleh bot agar tidak dobel
        await env.LIBRARY.put("interaction_queue", "[]");
      }
      return json({ok: true, data: queue});
    }

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
