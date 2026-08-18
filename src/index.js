const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {"content-type": "application/json; charset=utf-8"}
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/catalog") {
      const catalog = await env.LIBRARY.get("catalog", "json");
      return json(catalog || []);
    }

    if (url.pathname === "/api/admin/catalog" && request.method === "PUT") {
      // For the first test, Zhenya can upload the generated catalog using
      // a secret header. Replace the secret before production use.
      const secret = request.headers.get("x-library-secret");
      if (!env.LIBRARY_SECRET || secret !== env.LIBRARY_SECRET) {
        return json({error: "unauthorized"}, 401);
      }
      const body = await request.json();
      if (!Array.isArray(body)) return json({error: "catalog must be an array"}, 400);
      await env.LIBRARY.put("catalog", JSON.stringify(body));
      return json({ok: true, count: body.length});
    }

    return env.ASSETS.fetch(request);
  }
};
