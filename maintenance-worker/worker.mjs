import payload from "../diagnostic-payload.cjs";
const { safeEvent } = payload;
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
function authorized(request, secret, minimumLength = 24) {
  return typeof secret === "string" && secret.length >= minimumLength && request.headers.get("authorization") === `Bearer ${secret}`;
}
async function bodyWithinLimit(request) {
  const reader = request.body?.getReader();
  if (!reader) throw Error("EMPTY_BODY");
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 16384) { await reader.cancel(); throw Error("BODY_TOO_LARGE"); }
    chunks.push(value);
  }
  const buffer = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(buffer));
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return json({ ok: true, service: "tek-stock-maintenance", schema: 1 });
    if (url.pathname.startsWith("/releases/") && request.method === "GET") {
      let manifest;
      try { manifest = JSON.parse(env.RELEASE_MANIFEST || "null"); } catch {}
      if (!manifest?.desktop) return json({ error: "RELEASE_UNAVAILABLE" }, 503);
      if (url.pathname === "/releases/latest.json") return json(manifest);
      const name = url.pathname.slice("/releases/".length);
      if (!/^TEK-STOCK-[A-Za-z0-9.-]+\.exe$/.test(name)) return json({ error: "NOT_FOUND" }, 404);
      let origin;
      try { origin = new URL(env.RELEASE_ASSET_URL); } catch { return json({ error: "RELEASE_UNAVAILABLE" }, 503); }
      if (origin.protocol !== "https:" || origin.hostname !== "github.com" || origin.username || origin.password
          || !origin.pathname.startsWith("/teopoh71/tek-stock-desktop/releases/download/")
          || !origin.pathname.endsWith("/" + name)) return json({ error: "NOT_FOUND" }, 404);
      const response = await fetch(origin.toString(), { redirect: "follow" });
      if (!response.ok) return json({ error: "RELEASE_UNAVAILABLE" }, 503);
      const headers = new Headers(response.headers);
      headers.set("content-type", "application/octet-stream");
      headers.set("cache-control", "public, max-age=86400, immutable");
      return new Response(response.body, { status: 200, headers });
    }
    if (url.pathname === "/v1/diagnostics" && request.method === "POST") {
      // The existing legacy sync credential is allowed to write sanitized reports only.
      // Incident reads still require the separate strong monitor credential.
      if (!authorized(request, env.INGEST_TOKEN) && !authorized(request, env.SYNC_INGEST_TOKEN, 7)) return json({ error: "UNAUTHORIZED" }, 401);
      try {
        const body = await bodyWithinLimit(request);
        if (!Array.isArray(body.events) || !body.events.length || body.events.length > 20) return json({ error: "INVALID_BATCH" }, 400);
        const events = body.events.map(event => {
          if (!/^[a-f0-9-]{36}$/.test(event?.id)) throw Error("INVALID_ID");
          const safe = safeEvent(event);
          // Server receipt time is authoritative for incident ordering and retention.
          return { id: event.id, ...safe };
        });
        const receivedAt = new Date().toISOString();
        await env.DB.batch(events.map(event => env.DB.prepare(
          "INSERT OR IGNORE INTO diagnostic_events (id, occurred_at, received_at, app_version, stage, error_code) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(event.id, event.timestamp, receivedAt, event.appVersion, event.stage, event.errorCode)));
        return json({ accepted: events.map(e => e.id) }, 202);
      } catch { return json({ error: "REPORT_NOT_ACCEPTED" }, 400); }
    }
    if (url.pathname === "/v1/incidents" && request.method === "GET") {
      if (!authorized(request, env.MONITOR_TOKEN)) return json({ error: "UNAUTHORIZED" }, 401);
      const requested = Date.parse(url.searchParams.get("since") || "");
      const since = new Date(Math.max(Date.now() - 7 * 86400000, Number.isFinite(requested) ? requested : Date.now() - 86400000)).toISOString();
      const result = await env.DB.prepare(
        "SELECT app_version, stage, error_code, COUNT(*) AS occurrences, MIN(received_at) AS first_seen, MAX(received_at) AS last_seen FROM diagnostic_events WHERE received_at > ? GROUP BY app_version, stage, error_code ORDER BY last_seen DESC LIMIT 100"
      ).bind(since).all();
      return json({ incidents: result.results, checkedAt: new Date().toISOString() });
    }
    return json({ error: "NOT_FOUND" }, 404);
  },
  async scheduled(_event, env) {
    await env.DB.prepare("DELETE FROM diagnostic_events WHERE received_at < ?")
      .bind(new Date(Date.now() - 7 * 86400000).toISOString()).run();
  },
};
