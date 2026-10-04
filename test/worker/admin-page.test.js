import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountHarness } from './helpers/account-harness.js';
import { bundleWorker } from '../../tools/build-worker.mjs';
import { ADMIN_PAGE } from '../../worker/accounts/admin-page.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The console is a single hand-written page with no build step, so a typo in it is a blank page rather
// than a failed build. Parsing the inline script is the cheapest way to catch that before a browser does.
test('the console script parses and wires every panel it renders', () => {
  const script = ADMIN_PAGE.split('<script>')[1].split('</script>')[0];
  assert.doesNotThrow(() => new Function(script), 'the inline script must parse');

  // Each panel renders into an element that must exist, and every panel needs a loader that is called on
  // load - a section that never loads is the failure this catches.
  for (const id of ['token', 'filter', 'list', 'reload', 'mstate', 'mmsg', 'muntil', 'mtoggle',
    'dstate', 'dlist', 'dreload', 'wstate', 'wlist', 'wreload']) {
    assert.ok(ADMIN_PAGE.includes('id="' + id + '"'), `missing #${id}`);
  }
  for (const endpoint of ['/api/admin/accounts', '/api/admin/review', '/api/admin/maintenance',
    '/api/admin/diag', '/api/admin/write-stats']) {
    assert.ok(script.includes(endpoint), `the script never calls ${endpoint}`);
  }
  for (const loader of ['load()', 'loadMaint()', 'loadDiag()', 'loadWrites()']) {
    assert.ok(script.includes(loader), `${loader} is never invoked`);
  }
  assert.ok(!script.includes('${'), 'the page is a String.raw template: an interpolation would run at import time');
});

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
