import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture } from './test-helper.mjs';

const record = (id, stock = 1) => ({ id, model: 'TEST-' + id, category: 'test', stock });
const upsert = id => ({ type: 'upsert', item: record(id) });

test('create, identify, delete and persist change events', async () => {
  const f = fixture();
  assert.equal((await f.batch(0, [upsert('test-a')])).status, 200);
  assert.deepEqual((await (await f.call('/v1/snapshot')).json()).items, [record('test-a')]);
  assert.equal((await f.batch(1, [{ type: 'delete', itemId: 'test-a' }])).status, 200);
  assert.deepEqual((await (await f.call('/v1/snapshot')).json()).items, []);
  const feed = await (await f.call('/v1/changes?after_revision=0')).json();
  assert.deepEqual(feed.events.map(e => e.operation), ['upsert', 'delete']);
  f.close();
});

test('unauthorized requests never change inventory', async () => {
  const f = fixture();
  const result = await f.call('/v1/items/batch', { expectedRevision: 0, operations: [upsert('x')] }, { headers: { authorization: 'Bearer invalid' } });
  assert.equal(result.status, 401);
  assert.equal((await (await f.call('/v1/snapshot')).json()).revision, 0);
  f.close();
});

test('competing writes preserve first writer and reject stale revision', async () => {
  const f = fixture();
  const results = await Promise.all([f.batch(0, [upsert('first')]), f.batch(0, [upsert('second')])]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await (await f.call('/v1/snapshot')).json()).items.length, 1);
  f.close();
});

test('invalid second operation rolls back the entire batch', async () => {
  const f = fixture();
  assert.equal((await f.batch(0, [upsert('valid'), { type: 'upsert', item: { id: 'bad', model: 'bad', stock: 'invalid' } }])).status, 400);
  assert.deepEqual((await (await f.call('/v1/snapshot')).json()).items, []);
  assert.equal((await (await f.call('/v1/changes?after_revision=0')).json()).events.length, 0);
  f.close();
});

test('retry is idempotent; different content cannot reuse operation ID', async () => {
  const f = fixture();
  const first = await (await f.batch(0, [upsert('once')], 'operation-1')).json();
  const retry = await (await f.batch(0, [upsert('once')], 'operation-1')).json();
  assert.deepEqual(retry, first);
  assert.equal((await f.batch(1, [upsert('different')], 'operation-1')).status, 409);
  assert.equal((await (await f.call('/v1/snapshot')).json()).items.length, 1);
  f.close();
});

test('change pagination includes every operation and snapshot cursor is complete', async () => {
  const f = fixture();
  assert.equal((await f.batch(0, Array.from({ length: 520 }, (_, i) => upsert('item-' + i)))).status, 200);
  const page1 = await (await f.call('/v1/changes?after_revision=0')).json();
  assert.equal(page1.events.length, 500); assert.equal(page1.hasMore, true);
  const page2 = await (await f.call(`/v1/changes?after_revision=${page1.toRevision}&after_sequence=${page1.toSequence}`)).json();
  assert.equal(page2.events.length, 20); assert.equal(page2.hasMore, false);
  const snap = await (await f.call('/v1/snapshot')).json();
  const after = await (await f.call(`/v1/changes?after_revision=${snap.revision}&after_sequence=${snap.changeSequence}`)).json();
  assert.equal(after.events.length, 0);
  f.close();
});

test('desktop photo protocol preserves binary content and hashes', async () => {
  const f = fixture(); await f.batch(0, [upsert('photo')]);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZf8AAAAASUVORK5CYII=', 'base64');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const signedResponse = await f.call('/v1/photos/presign', { itemId: 'photo', sha256, mimeType: 'image/png', bytes: bytes.length });
  assert.equal(signedResponse.status, 200);
  const signed = await signedResponse.json();
  assert.equal((await f.call(new URL(signed.uploadUrl).pathname, bytes, { method: 'PUT' })).status, 200);
  const commit = { itemId: 'photo', objectKey: signed.objectKey, expectedRevision: 1, sha256, bytes: bytes.length, mimeType: 'image/png' };
  assert.equal((await f.call('/v1/photos/commit', { ...commit, sha256: 'f'.repeat(64) })).status, 400);
  assert.equal((await f.call('/v1/photos/commit', commit)).status, 200);
  const downloaded = await f.call('/' + signed.objectKey);
  assert.equal(downloaded.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  assert.equal((await (await f.call('/v1/snapshot')).json()).items[0].imageSha256, sha256);
  f.close();
});

test('import cannot overwrite inventory and missing photos leave no partial data', async () => {
  const f = fixture(); const options = { headers: { authorization: 'Bearer ' + f.env.ADMIN_TOKEN } };
  assert.equal((await f.call('/admin/import', { revision: 5, items: [record('first'), { ...record('second'), image: 'photos/missing.png' }] }, options)).status, 400);
  assert.equal((await (await f.call('/v1/snapshot')).json()).items.length, 0);
  assert.equal((await f.call('/admin/import', { revision: 5, items: [record('first')] }, options)).status, 200);
  assert.equal((await f.call('/admin/import', { revision: 6, items: [record('replacement')] }, options)).status, 409);
  assert.equal((await (await f.call('/v1/snapshot')).json()).items[0].id, 'first');
  f.close();
});
