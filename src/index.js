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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {headers: cors()});
    }

    if (url.pathname === "/api/catalog" && request.method === "GET") {
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
