# Cloudflare Worker Proxy (Free, 1–2 minutes)

## Why you need this
GitHub Pages is static and most DOT/map APIs do **not** allow browser CORS. A tiny proxy fixes that.

## Steps
1. Go to https://dash.cloudflare.com → **Workers & Pages** → **Create Worker**.
2. Replace the default code with this:

```js
export default {
  async fetch(req) {
    const url = new URL(req.url);
    const target = url.searchParams.get("url");
    if (!target) return new Response("Missing ?url=", { status: 400 });
    const r = await fetch(target, { headers: { "User-Agent": "Mozilla/5.0" } });
    const body = await r.text();
    return new Response(body, {
      status: r.status,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": r.headers.get("content-type") || "application/json; charset=utf-8"
      }
    });
  }
};
```

3. **Deploy** and copy your worker URL, e.g. `https://myproxy.john.workers.dev`.
4. Open `app.js` and set:
```js
const PROXY_BASE = "https://myproxy.john.workers.dev/?url=";
```
5. Commit to GitHub Pages, **turn off** the “Mock data” checkbox in the UI, and search your ZIP.

## Notes
- The app uses **OSM Nominatim** for ZIP → lat/lon and **511PA WZDx + events** for data.
- If you want NJ too, ping me and I’ll add the 511NJ provider.
