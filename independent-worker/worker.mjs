const AUTHORITY = 'tek-stock-cloudflare';
const PHOTO_LIMIT = 15_000_000;
const mimeTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const fail = (code, status = 400) => { throw Object.assign(new Error(code), { status }); };
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
function response(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), { status, headers: {
    'content-type': 'application/json', 'cache-control': 'no-store',
    'x-tek-stock-authority-id': AUTHORITY, 'access-control-allow-origin': '*', ...extra,
  } });
}
function authorized(req, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || req.headers.get('x-sync-token') || '';
  if (provided.length !== secret.length) return false;
  let different = 0; for (let i = 0; i < secret.length; i++) different |= provided.charCodeAt(i) ^ secret.charCodeAt(i);
  return different === 0;
}
async function bounded(req, limit) {
  const reader = req.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks = []; let size = 0;
  for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
    if (size > limit) { await reader.cancel(); fail('PAYLOAD_TOO_LARGE', 413); } chunks.push(part.value); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.length; } return bytes;
}
async function jsonBody(req) {
  try {
    const body = JSON.parse(new TextDecoder().decode(await bounded(req, 4_000_000)));
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('BODY_INVALID');
    return body;
  }
  catch (e) { if (e.status) throw e; fail('BODY_NOT_JSON'); }
}
function item(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('ITEM_INVALID');
  if (typeof value.id !== 'string' || !value.id || value.id.length > 512 || /[\r\n]/.test(value.id)) fail('ITEM_ID_INVALID');
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 300) fail('MODEL_INVALID');
  if (!Number.isFinite(value.stock)) fail('STOCK_INVALID');
  if (JSON.stringify(value).length > 32000) fail('ITEM_TOO_LARGE');
  return Object.fromEntries(Object.entries(value).filter(([k]) => !k.startsWith('_') && !['__proto__', 'constructor', 'prototype'].includes(k)));
}
function photoKey(value) {
  const key = String(value || '').replace(/^\//, '');
  if (!/^photos\/[a-zA-Z0-9/_-]+\.(png|jpe?g|webp|gif)$/.test(key) || key.length > 240 || key.includes('//')) fail('PHOTO_KEY_INVALID');
  return key;
}
function imageType(bytes) {
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  const text = new TextDecoder().decode(bytes.slice(0, 12));
  if (text.startsWith('RIFF') && text.slice(8) === 'WEBP') return 'image/webp';
  if (text.startsWith('GIF8')) return 'image/gif';
  fail('PHOTO_FORMAT_INVALID');
}

export class Inventory {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, updated TEXT NOT NULL);
      INSERT OR IGNORE INTO meta VALUES (1,0,'1970-01-01T00:00:00.000Z');
      CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (revision INTEGER, sequence INTEGER, value TEXT NOT NULL, PRIMARY KEY(revision,sequence));
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, hash TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS photos (key TEXT PRIMARY KEY, hash TEXT NOT NULL, type TEXT NOT NULL, bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (key TEXT, seq INTEGER, data BLOB NOT NULL, PRIMARY KEY(key,seq));`);
  }
  rows(q, ...args) { return this.sql.exec(q, ...args).toArray(); }
  meta() { return this.rows('SELECT revision,updated FROM meta WHERE id=1')[0]; }
  snapshot() {
    const m = this.meta();
    const sequence = this.rows('SELECT MAX(sequence) AS sequence FROM events WHERE revision=?', m.revision)[0]?.sequence ?? null;
    return { app: 'TEK STOCK', version: 'independent-v1', revision: m.revision, changeSequence: sequence,
      updatedAt: m.updated, imageSetVersion: 'independent-v1', items: this.rows('SELECT value FROM items ORDER BY id').map(r => JSON.parse(r.value)) };
  }
  commit(body, id, hash) {
    return this.ctx.storage.transactionSync(() => {
      const prior = id && this.rows('SELECT hash,result FROM requests WHERE id=?', id)[0];
      if (prior) { if (prior.hash !== hash) fail('IDEMPOTENCY_CONFLICT', 409); return JSON.parse(prior.result); }
      const m = this.meta();
      if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision !== m.revision) fail('REVISION_CONFLICT', 409);
      if (!Array.isArray(body.operations) || body.operations.length > 1000) fail('OPERATIONS_INVALID');
      if (!body.operations.length) return { ok: true, revision: m.revision, updatedAt: m.updated };
      const revision = m.revision + 1, updatedAt = new Date().toISOString(); let sequence = 0;
      for (const operation of body.operations) {
        if (!operation || typeof operation !== 'object') fail('OPERATION_INVALID');
        let event;
        if (operation.type === 'upsert') {
          const record = item(operation.item);
          this.sql.exec('INSERT INTO items VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', record.id, JSON.stringify(record));
          event = { operation: 'upsert', itemId: record.id, item: record };
        } else if (operation.type === 'delete' && typeof operation.itemId === 'string' && operation.itemId) {
          this.sql.exec('DELETE FROM items WHERE id=?', operation.itemId); event = { operation: 'delete', itemId: operation.itemId };
        } else fail('OPERATION_INVALID');
        this.sql.exec('INSERT INTO events VALUES (?,?,?)', revision, sequence, JSON.stringify({ ...event, revision, sequence, createdAt: updatedAt })); sequence++;
      }
      this.sql.exec('UPDATE meta SET revision=?,updated=? WHERE id=1', revision, updatedAt);
      const result = { ok: true, revision, updatedAt, changeSequence: sequence - 1 };
      if (id) this.sql.exec('INSERT INTO requests VALUES (?,?,?)', id, hash, JSON.stringify(result));
      return result;
    });
  }
  async putPhoto(key, req, expectedHash = '') {
    const bytes = await bounded(req, PHOTO_LIMIT); if (!bytes.length) fail('PHOTO_EMPTY');
    const type = imageType(bytes), hash = await digest(bytes);
    if (mimeTypes[key.split('.').at(-1)] !== type) fail('PHOTO_TYPE_MISMATCH');
    if (expectedHash && hash !== expectedHash) fail('PHOTO_HASH_MISMATCH');
    this.ctx.storage.transactionSync(() => {
      const prior = this.rows('SELECT hash FROM photos WHERE key=?', key)[0];
      if (prior) { if (prior.hash !== hash) fail('PHOTO_IMMUTABLE', 409); return; }
      for (let i = 0, seq = 0; i < bytes.length; i += 64000, seq++) this.sql.exec('INSERT INTO chunks VALUES (?,?,?)', key, seq, bytes.slice(i, i + 64000).buffer);
      this.sql.exec('INSERT INTO photos VALUES (?,?,?,?)', key, hash, type, bytes.length);
    });
    return { ok: true, objectKey: key, sha256: hash, bytes: bytes.length };
  }
  async fetch(req) {
    try {
      const url = new URL(req.url), p = url.pathname;
      if (req.method === 'OPTIONS') return response({}, 200, { 'access-control-allow-methods': 'GET,POST,PUT,OPTIONS', 'access-control-allow-headers': 'authorization,content-type,idempotency-key,x-sync-token,x-tek-stock-authority-id' });
      if (req.method === 'GET' && p === '/health') return response({ ok: true, service: 'tek-stock-independent', schema: 1 });
      if (req.method === 'GET' && p === '/v1/snapshot') return response(this.snapshot());
      if (req.method === 'GET' && p === '/v1/changes') {
        const revision = Math.max(0, Number(url.searchParams.get('after_revision')) || 0);
        const rawSequence = url.searchParams.get('after_sequence');
        const sequence = rawSequence == null ? Number.MAX_SAFE_INTEGER : Number(rawSequence);
        const events = this.rows('SELECT value FROM events WHERE revision>? OR (revision=? AND sequence>?) ORDER BY revision,sequence LIMIT 501', revision, revision, sequence).map(r => JSON.parse(r.value));
        const hasMore = events.length > 500; if (hasMore) events.pop(); const last = events.at(-1);
        return response({ events, toRevision: last?.revision ?? revision, toSequence: last?.sequence ?? (rawSequence == null ? null : sequence), currentRevision: this.meta().revision, hasMore });
      }
      if (req.method === 'GET' && p.startsWith('/photos/')) {
        const key = photoKey(p), info = this.rows('SELECT * FROM photos WHERE key=?', key)[0]; if (!info) fail('PHOTO_NOT_FOUND', 404);
        const bytes = new Uint8Array(info.bytes); let offset = 0;
        for (const row of this.rows('SELECT data FROM chunks WHERE key=? ORDER BY seq', key)) { const b = new Uint8Array(row.data); bytes.set(b, offset); offset += b.length; }
        return new Response(bytes, { headers: { 'content-type': info.type, 'content-length': String(info.bytes), etag: '"' + info.hash + '"', 'cache-control': 'public,max-age=31536000,immutable', 'access-control-allow-origin': '*', 'x-tek-stock-authority-id': AUTHORITY } });
      }
      if (p.startsWith('/admin/')) {
        if (!authorized(req, this.env.ADMIN_TOKEN)) fail('UNAUTHORIZED', 401);
        if (req.method === 'PUT' && p.startsWith('/admin/photos/')) return response(await this.putPhoto(photoKey(p.slice('/admin/'.length)), req));
        if (req.method === 'POST' && p === '/admin/import') {
          const body = await jsonBody(req);
          return response(this.ctx.storage.transactionSync(() => {
            if (this.meta().revision !== 0 || this.rows('SELECT id FROM items LIMIT 1').length) fail('ALREADY_INITIALIZED', 409);
            if (!Array.isArray(body.items) || !body.items.length || body.items.length > 10000 || !Number.isSafeInteger(body.revision) || body.revision < 1) fail('IMPORT_INVALID');
            for (const source of body.items) {
              const record = item(source);
              if (record.image && !this.rows('SELECT key FROM photos WHERE key=?', photoKey(record.image)).length) fail('IMPORT_PHOTO_MISSING');
              this.sql.exec('INSERT INTO items VALUES (?,?)', record.id, JSON.stringify(record));
            }
            this.sql.exec('UPDATE meta SET revision=?,updated=? WHERE id=1', body.revision, String(body.updatedAt || new Date().toISOString()));
            return { ok: true, revision: body.revision, imported: body.items.length };
          }));
        }
        fail('NOT_FOUND', 404);
      }
      if (req.method === 'PUT' && p.startsWith('/v1/photos/upload/')) {
        const id = p.slice('/v1/photos/upload/'.length), row = this.rows('SELECT value,expires FROM uploads WHERE id=?', id)[0];
        if (!row || row.expires < Date.now()) fail('UPLOAD_EXPIRED', 404);
        const pending = JSON.parse(row.value); return response(await this.putPhoto(pending.objectKey, req, pending.sha256));
      }
      if (!authorized(req, this.env.SYNC_TOKEN)) fail('UNAUTHORIZED', 401);
      if (req.method === 'POST' && p === '/v1/items/batch') {
        const body = await jsonBody(req); const id = req.headers.get('idempotency-key') || '';
        if (id.length > 200) fail('IDEMPOTENCY_KEY_INVALID');
        return response(this.commit(body, id, await digest(new TextEncoder().encode(JSON.stringify(body)))));
      }
      if (req.method === 'POST' && p === '/v1/photos/presign') {
        const body = await jsonBody(req), record = this.rows('SELECT id FROM items WHERE id=?', String(body.itemId || ''))[0]; if (!record) fail('ITEM_NOT_FOUND', 404);
        if (!/^[a-f0-9]{64}$/.test(body.sha256 || '')) fail('PHOTO_HASH_INVALID');
        const type = String(body.mimeType || body.contentType || '').split(';')[0], ext = Object.keys(mimeTypes).find(k => mimeTypes[k] === type); if (!ext) fail('PHOTO_TYPE_INVALID');
        const size = body.bytes ?? body.size;
        if (!Number.isSafeInteger(size) || !(size > 0 && size <= PHOTO_LIMIT)) fail('PHOTO_SIZE_INVALID');
        const id = crypto.randomUUID(), objectKey = 'photos/' + body.sha256 + '.' + ext;
        this.sql.exec('DELETE FROM uploads WHERE expires<?', Date.now());
        this.sql.exec('INSERT INTO uploads VALUES (?,?,?)', id, JSON.stringify({ itemId: record.id, objectKey, sha256: body.sha256 }), Date.now() + 1800000);
        return response({ uploadId: id, objectKey, uploadUrl: url.origin + '/v1/photos/upload/' + id, headers: { 'content-type': type } });
      }
      if (req.method === 'POST' && p === '/v1/photos/commit') {
        const body = await jsonBody(req), key = photoKey(body.objectKey), photo = this.rows('SELECT * FROM photos WHERE key=?', key)[0]; if (!photo) fail('PHOTO_NOT_UPLOADED');
        if (body.sha256 !== photo.hash || body.bytes !== photo.bytes || body.mimeType !== photo.type) fail('PHOTO_METADATA_MISMATCH');
        const row = this.rows('SELECT value FROM items WHERE id=?', String(body.itemId || ''))[0]; if (!row) fail('ITEM_NOT_FOUND', 404);
        const record = { ...JSON.parse(row.value), image: key, imageSha256: photo.hash, imageVersion: String(body.imageVersion || photo.hash) };
        const request = { expectedRevision: body.expectedRevision, operations: [{ type: 'upsert', item: record }] };
        return response(this.commit(request, req.headers.get('idempotency-key') || '', await digest(new TextEncoder().encode(JSON.stringify(request)))));
      }
      fail('NOT_FOUND', 404);
    } catch (e) { return response({ ok: false, code: e.status ? e.message : 'INTERNAL_ERROR', currentRevision: this.meta().revision }, e.status || 500); }
  }
}

export default {
  async fetch(req, env) { return env.INVENTORY.get(env.INVENTORY.idFromName('singapore')).fetch(req); },
};
