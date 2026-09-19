import { DatabaseSync } from 'node:sqlite';
import { Inventory } from './worker.mjs';
export function fixture() {
  const db = new DatabaseSync(':memory:');
  const storage = {
    sql: { exec(query, ...params) {
      if (query.includes('CREATE TABLE')) { db.exec(query); return { toArray: () => [] }; }
      params = params.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
      const statement = db.prepare(query);
      const rows = statement.columns().length ? statement.all(...params) : (statement.run(...params), []);
      return { toArray: () => rows };
    } },
    transactionSync(fn) {
      db.exec('BEGIN');
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
  const env = { SYNC_TOKEN: 's'.repeat(40), ADMIN_TOKEN: 'a'.repeat(40) };
  const service = new Inventory({ storage }, env);
  const call = (path, body, options = {}) => service.fetch(new Request('https://test.invalid' + path, {
    method: options.method || (body === undefined ? 'GET' : 'POST'),
    headers: { authorization: 'Bearer ' + env.SYNC_TOKEN, ...options.headers },
    ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
  }));
  const batch = (revision, operations, key = '') => call('/v1/items/batch', { expectedRevision: revision, operations }, { headers: { 'idempotency-key': key } });
  return { service, call, batch, env, close: () => db.close() };
}
