// Read only the isolated output of CleanTests; never use a live profile.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
process.env.TEK_STOCK_TEST = '1';
const main = require('../../main.cjs');
const { createCentralSync, sha256 } = require('../../central-sync.cjs');
(async () => {
  const [profile, workbook] = process.argv.slice(2).map(value => path.resolve(value));
  for (const file of [profile, workbook]) {
    assert.match(file, /[\\/]TEK-STOCK-clean-tests-[a-f0-9]{32}[\\/]actual[\\/]/);
  }
  const syncRoot = path.join(profile, 'central-sync');
  const source = JSON.parse(fs.readFileSync(path.join(syncRoot, 'last-good-snapshot.json'), 'utf8'));
  const parsed = await main.readWorkbookFile(workbook);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.hasUnacknowledgedChanges, false);
  assert.equal(parsed.integrity.itemIdsDuplicateFree, true);
  assert.equal(parsed.sync.revision, source.revision);
  assert.deepEqual(parsed.items.map(item => item.id).sort(), source.items.map(item => item.id).sort());
  assert.equal(parsed.sha256, sha256(fs.readFileSync(workbook)));
  let requests = 0;
  const sync = createCentralSync({
    storageDirectory: syncRoot, readOnly: true,
    getToken: () => '', getApiBaseUrl: () => '',
    fetchImpl: async () => { requests++; throw new Error('Offline test: network disabled'); }
  });
  const photos = source.items.filter(item => item.image);
  const urls = await Promise.all(photos.map(item => sync.cachePhoto(item)));
  assert.equal(urls.filter(url => url.startsWith('file:')).length, photos.length);
  assert.equal(requests, 0);
  const offline = await sync.snapshot(true);
  assert.equal(offline.cloudState, 'cached');
  assert.equal(offline.items.length, source.items.length);
  assert.equal(offline.items.filter(item => item.image.startsWith('file:')).length, photos.length);
  assert.equal(sync.outbox.snapshot().entries.length, 0);
  console.log(JSON.stringify({
    ok: true, items: parsed.items.length, photos: urls.length,
    revision: parsed.sync.revision, workbookSha256: parsed.sha256,
    offline: true, pendingOperations: 0
  }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
