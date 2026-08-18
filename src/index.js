const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {"content-type": "application/json; charset=utf-8"}
  });

function cors(headers = {}) {
  return {
    ...headers,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,PUT,OPTIONS",
    "access-control-allow-headers": "Content-Type,X-Library-Secret"
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

  // Telegram Web App validation:
  // secret_key = HMAC_SHA256(key="WebAppData", message=bot_token)
  // hash       = HMAC_SHA256(key=secret_key, message=data_check_string)
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
  if (!chatId) return {ok:false, member:false, status:"missing_chat_id"};

  const r = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(userId)}`
  );

  let data = null;
  try { data = await r.json(); } catch {}

  if (!r.ok || !data?.ok) {
    return {
      ok:false,
      member:false,
      status:"telegram_error",
      error_code:data?.error_code || r.status,
      description:data?.description || ""
    };
  }

  const result = data.result || {};
  const status = result.status || "";
  // Telegram can return "restricted" for a user who is still a member.
  const member =
    ["creator", "administrator", "member"].includes(status) ||
    (status === "restricted" && result.is_member === true);

  return {ok:true, member, status};
}

async function checkAccess(request, env) {
  const requestUrl = new URL(request.url);
  const initData =
    request.headers.get("X-Telegram-Init-Data") ||
    requestUrl.searchParams.get("init_data") ||
    "";

  const user = await verifyTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!user?.id) {
    return {ok:false, code:401, reason:"invalid_telegram_session"};
  }

  if (!env.MVP_CHANNEL_ID || !env.MVP_DISCUSSION_ID) {
    return {ok:false, code:503, reason:"membership_ids_not_configured"};
  }

  // Cache ONLY successful checks for 30 seconds.
  // This reduces Telegram API calls while keeping membership changes reasonably fresh.
  const cache = caches.default;
  const cacheKey = new Request(
    `${requestUrl.origin}/__mvp_access/${user.id}`
  );
  const cached = await cache.match(cacheKey);
  if (cached) return {ok:true, user};

  const [mvp, discussion] = await Promise.all([
    telegramMemberStatus(env, env.MVP_CHANNEL_ID, user.id),
    telegramMemberStatus(env, env.MVP_DISCUSSION_ID, user.id)
  ]);

  if (mvp.member !== true || discussion.member !== true) {
    return {
      ok:false,
      code:403,
      reason:"not_member",
      checks:{
        mvp:{ok:mvp.ok, member:mvp.member, status:mvp.status},
        discussion:{ok:discussion.ok, member:discussion.member, status:discussion.status}
      }
    };
  }

  const response = new Response("ok", {
    headers: {
      "cache-control": "private, max-age=30",
      "x-mvp-access": "verified"
    }
  });
  await cache.put(cacheKey, response.clone());

  return {ok:true, user};
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
          {ok: false, code: access.code, reason: access.reason, checks: access.checks || undefined},
          access.code === 403 ? 403 : access.code === 401 ? 401 : 503
        );
      }
      return json({
        ok: true,
        user: {
          id: String(access.user.id),
          username: access.user.username || ""
        }
      });
    }

    // Protect catalog access so an old Mini App tab cannot keep loading
    // library data after membership is lost.
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

    // Proxies Telegram-hosted images through the Worker.
    // The bot token stays in Cloudflare Secret and is never sent to the browser.
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
