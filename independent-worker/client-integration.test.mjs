import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fixture } from './test-helper.mjs';
const require = createRequire(import.meta.url);
const { createCentralSync } = require('../central-sync.cjs');

test('real desktop sync client: add, second-device recognition, photo, delete', async t => {
  const f = fixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tek-independent-test-'));
  const clients = [1, 2].map(number => createCentralSync({
    storageDirectory: path.join(directory, 'client-' + number),
    getApiBaseUrl: () => 'https://test.invalid', getOssBaseUrl: () => 'https://test.invalid',
    getToken: () => f.env.SYNC_TOKEN, getAuthorityId: () => 'tek-stock-independent-v1',
    fetchImpl: (url, init) => f.service.fetch(new Request(url, init)),
  }));
  t.after(() => { f.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const [first, second] = clients;
  await first.snapshot(false); await second.snapshot(false);
  first.enqueue([{ type: 'create', item: { id: 'test-only-chair', model: 'ISOLATED TEST CHAIR', category: 'test', stock: 1 } }]);
  await first.flush();
  assert.equal((await second.snapshot(false)).items[0].model, 'ISOLATED TEST CHAIR');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZf8AAAAASUVORK5CYII=';
  const photo = await first.replacePhoto('test-only-chair', png);
  assert.equal(photo.ok, true);
  const withPhoto = await second.canonicalSnapshot();
  assert.equal(withPhoto.items[0].imageSha256, photo.imageSha256);
  assert.ok(await second.cachePhoto(withPhoto.items[0]));
  await first.snapshot(false);
  first.enqueue([{ type: 'delete', itemId: 'test-only-chair' }]);
  await first.flush();
  assert.deepEqual((await second.snapshot(false)).items, []);
  assert.equal(first.outbox.snapshot().entries.filter(entry => entry.state !== 'acked').length, 0);
});

test('authorization failure retains the operation; corrected credentials allow retry', async t => {
  const f = fixture(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tek-auth-test-'));
  let token = f.env.SYNC_TOKEN;
  const sync = createCentralSync({ storageDirectory: directory,
    getApiBaseUrl: () => 'https://test.invalid', getToken: () => token,
    getAuthorityId: () => 'tek-stock-independent-v1', fetchImpl: (url, init) => f.service.fetch(new Request(url, init)),
  });
  t.after(() => { f.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await sync.snapshot(false);
  token = 'wrong-test-token';
  sync.enqueue([{ type: 'create', item: { id: 'retry-test', model: 'RETRY TEST', stock: 1 } }]);
  await assert.rejects(sync.flush(), /UNAUTHORIZED/);
  assert.equal((await (await f.call('/v1/snapshot')).json()).items.length, 0);
  assert.equal(sync.outbox.retryable().length, 1);
  token = f.env.SYNC_TOKEN; await sync.flush();
  assert.equal((await sync.canonicalSnapshot()).items.length, 1);
  assert.equal(sync.outbox.retryable().length, 0);
});

test('concurrent edits to the same stock become a conflict, never silent overwrite', async t => {
  const f = fixture(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tek-conflict-test-'));
  await f.batch(0, [{ type: 'upsert', item: { id: 'conflict-test', model: 'CONFLICT TEST', stock: 1 } }]);
  const sync = createCentralSync({ storageDirectory: directory,
    getApiBaseUrl: () => 'https://test.invalid', getToken: () => f.env.SYNC_TOKEN,
    getAuthorityId: () => 'tek-stock-independent-v1', fetchImpl: (url, init) => f.service.fetch(new Request(url, init)),
  });
  t.after(() => { f.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await sync.snapshot(false);
  sync.enqueue([{ type: 'update', itemId: 'conflict-test', patch: { stock: 2 } }]);
  await f.batch(1, [{ type: 'upsert', item: { id: 'conflict-test', model: 'CONFLICT TEST', stock: 9 } }]);
  await assert.rejects(sync.flush(), { code: 'CONCURRENT_MODIFICATION' });
  assert.equal((await sync.canonicalSnapshot()).items[0].stock, 9);
  assert.equal(sync.outbox.snapshot().entries[0].state, 'conflict');
});
