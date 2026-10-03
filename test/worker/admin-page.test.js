import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountHarness } from './helpers/account-harness.js';
import { bundleWorker } from '../../tools/build-worker.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('GET /admin is served as HTML with a token gate', { timeout: 180000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-admin-page-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bundlePath = path.join(dir, 'worker.mjs');
  await bundleWorker({ outfile: bundlePath });
  const source = `
    import worker,{SiteDirectory,AccountDurableObject,RoomDurableObject,AdmissionDurableObject,MatchArchive}
      from ${JSON.stringify(bundlePath.replaceAll('\\', '/'))};
    export {SiteDirectory as TestObject,AccountDurableObject,RoomDurableObject,AdmissionDurableObject,MatchArchive};
    export default { fetch: (request, env) => worker.fetch(request, env) };
  `;
  const h = await createAccountHarness(source, {
    durableObjects: Object.fromEntries([['SITES', 'TestObject'], ['ACCOUNTS', 'AccountDurableObject'], ['ROOMS', 'RoomDurableObject'],
      ['ADMISSION', 'AdmissionDurableObject'], ['MATCH_ARCHIVES', 'MatchArchive']].map(([key, className]) => [key, { className, useSQLite: true }])),
    bindings: { ADMIN_TOKEN: 'local-auth-admin-token-0123456789abcdef' },
  });
  t.after(() => h.dispose());

  const page = await h.request('https://game.example/admin');
  const body = await page.text();
  // A text/plain content type makes the browser show the page source instead of rendering it.
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') || '', /^text\/html/);
  assert.match(page.headers.get('cache-control') || '', /no-store/);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(body, /^<!doctype html>/i);
  assert.match(body, /X-Admin-Token/, 'the page must ask for the operator token');
  assert.ok(!body.includes('ADMIN_TOKEN='), 'the page must never embed a token');

  // The operator surface must not exist at all without a token.
  const bare = await createAccountHarness(source, {
    durableObjects: Object.fromEntries([['SITES', 'TestObject'], ['ACCOUNTS', 'AccountDurableObject'], ['ROOMS', 'RoomDurableObject'],
      ['ADMISSION', 'AdmissionDurableObject'], ['MATCH_ARCHIVES', 'MatchArchive']].map(([key, className]) => [key, { className, useSQLite: true }])),
  });
  t.after(() => bare.dispose());
  assert.equal((await bare.request('https://game.example/admin')).status, 404);
});
