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
      if (!authorized(request, env.INGEST_TOKEN) && !authorized(request, env.INVENTORY_INGEST_TOKEN)
          && !authorized(request, env.SYNC_INGEST_TOKEN, 7)) return json({ error: "UNAUTHORIZED" }, 401);
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
          "INSERT OR IGNORE INTO diagnostic_events (id, occurred_at, received_at, app_version, stage, error_code, device_id, authority_id, ok, recovered, revision, pending_count, event_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(event.id, event.timestamp, receivedAt, event.appVersion, event.stage, event.errorCode,
          event.deviceId || "legacy", event.authorityId || "unknown", event.ok ? 1 : 0, event.recovered ? 1 : 0,
          event.revision ?? null, event.pending ?? null, event.eventSequence ?? 0)));
        return json({ accepted: events.map(e => e.id) }, 202);
      } catch { return json({ error: "REPORT_NOT_ACCEPTED" }, 400); }
    }
    if (url.pathname === "/v1/incidents" && request.method === "GET") {
      if (!authorized(request, env.MONITOR_TOKEN)) return json({ error: "UNAUTHORIZED" }, 401);
      const requested = Date.parse(url.searchParams.get("since") || "");
      const since = new Date(Math.max(Date.now() - 7 * 86400000, Number.isFinite(requested) ? requested : Date.now() - 86400000)).toISOString();
      const result = await env.DB.prepare(
        `WITH scoped AS (
          SELECT device_id, authority_id, app_version, stage,
            CASE WHEN stage LIKE 'refresh_%' OR stage = 'cloud_download'
                OR (stage = 'app.error' AND (error_code LIKE 'CLOUD%' OR error_code LIKE 'API%' OR error_code LIKE 'HTTP_%' OR error_code LIKE 'AUTH_%' OR error_code IN ('SYNC_TOKEN_MISSING', 'UNAUTHORIZED')))
                THEN 'cloud_download'
              WHEN stage LIKE 'sync_%' OR stage IN ('excel_sync', 'excel_sync_ipc', 'excel_import', 'excel_ack')
                OR (stage = 'app.error' AND (error_code LIKE 'EXCEL%' OR error_code LIKE 'WORKBOOK%'))
                THEN 'excel_sync' ELSE stage END AS incident_stage,
            error_code, ok, recovered, revision, pending_count, event_sequence, occurred_at, received_at, id,
            ROW_NUMBER() OVER (PARTITION BY device_id, authority_id, CASE WHEN stage LIKE 'refresh_%' OR stage = 'cloud_download' OR (stage = 'app.error' AND (error_code LIKE 'CLOUD%' OR error_code LIKE 'API%' OR error_code LIKE 'HTTP_%' OR error_code LIKE 'AUTH_%' OR error_code IN ('SYNC_TOKEN_MISSING', 'UNAUTHORIZED'))) THEN 'cloud_download' WHEN stage LIKE 'sync_%' OR stage IN ('excel_sync', 'excel_sync_ipc', 'excel_import', 'excel_ack') OR (stage = 'app.error' AND (error_code LIKE 'EXCEL%' OR error_code LIKE 'WORKBOOK%')) THEN 'excel_sync' ELSE stage END ORDER BY occurred_at DESC, event_sequence DESC, received_at DESC) AS latest_rank,
            COUNT(*) OVER (PARTITION BY device_id, authority_id, CASE WHEN stage LIKE 'refresh_%' OR stage = 'cloud_download' OR (stage = 'app.error' AND (error_code LIKE 'CLOUD%' OR error_code LIKE 'API%' OR error_code LIKE 'HTTP_%' OR error_code LIKE 'AUTH_%' OR error_code IN ('SYNC_TOKEN_MISSING', 'UNAUTHORIZED'))) THEN 'cloud_download' WHEN stage LIKE 'sync_%' OR stage IN ('excel_sync', 'excel_sync_ipc', 'excel_import', 'excel_ack') OR (stage = 'app.error' AND (error_code LIKE 'EXCEL%' OR error_code LIKE 'WORKBOOK%')) THEN 'excel_sync' ELSE stage END) AS occurrences,
            MIN(received_at) OVER (PARTITION BY device_id, authority_id, CASE WHEN stage LIKE 'refresh_%' OR stage = 'cloud_download' OR (stage = 'app.error' AND (error_code LIKE 'CLOUD%' OR error_code LIKE 'API%' OR error_code LIKE 'HTTP_%' OR error_code LIKE 'AUTH_%' OR error_code IN ('SYNC_TOKEN_MISSING', 'UNAUTHORIZED'))) THEN 'cloud_download' WHEN stage LIKE 'sync_%' OR stage IN ('excel_sync', 'excel_sync_ipc', 'excel_import', 'excel_ack') OR (stage = 'app.error' AND (error_code LIKE 'EXCEL%' OR error_code LIKE 'WORKBOOK%')) THEN 'excel_sync' ELSE stage END) AS first_seen
          FROM diagnostic_events WHERE received_at > ?
        )
        SELECT device_id, authority_id, app_version, incident_stage, stage AS last_event_stage, error_code, ok, recovered, revision, pending_count, occurrences, first_seen, received_at AS last_seen
        FROM scoped WHERE latest_rank = 1 ORDER BY occurred_at DESC, event_sequence DESC, last_seen DESC LIMIT 100`
      ).bind(since).all();
      const incidents = (result.results || []).map(row => ({
        deviceId: row.device_id === "legacy" ? null : row.device_id,
        deviceKnown: row.device_id !== "legacy",
        authorityId: row.authority_id || "unknown",
        appVersion: row.app_version,
        stage: row.incident_stage,
        lastEventStage: row.last_event_stage,
        errorCode: row.error_code,
        state: row.recovered || row.ok ? "recovered" : "active",
        revision: row.revision == null ? null : row.revision,
        pending: row.pending_count == null ? null : row.pending_count,
        occurrences: row.occurrences,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
      }));
      return json({ incidents, checkedAt: new Date().toISOString() });
    }
    return json({ error: "NOT_FOUND" }, 404);
  },
  async scheduled(_event, env) {
    await env.DB.prepare("DELETE FROM diagnostic_events WHERE received_at < ?")
      .bind(new Date(Date.now() - 7 * 86400000).toISOString()).run();
  },
};
