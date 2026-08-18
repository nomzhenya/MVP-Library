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

  if (!env.MVP_CHANNEL_ID || !env.MVP_DISCUSSION_ID) {
    return {ok: false, code: 503};
  }

  // Membership is checked live here. This endpoint is intentionally not
  // cached so a refresh can revoke access promptly.
  const [mvp, discussion] = await Promise.all([
    telegramMemberStatus(env, env.MVP_CHANNEL_ID, user.id),
    telegramMemberStatus(env, env.MVP_DISCUSSION_ID, user.id)
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
