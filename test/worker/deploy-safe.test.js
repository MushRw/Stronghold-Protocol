import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, occupiedRooms, PHASES, EXIT } from '../../tools/deploy-safe.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const CLI = path.join(root, 'tools', 'deploy-safe.mjs');

/** A stand-in for the site: /healthz, the public room list, and the maintenance admin route. */
async function stub({ rooms = [], enabled = false, ignoreMaintenance = false } = {}) {
  const state = { enabled, posts: [], rooms };
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://stub');
    const json = (body, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/healthz') return json({ status: 'ok', build: 'abc1234' });
    if (url.pathname === '/api/rooms') return json({ items: state.rooms, nextCursor: null });
    if (url.pathname === '/api/admin/maintenance') {
      if (request.headers['x-admin-token'] !== 'test-token') return json({ error: 'FORBIDDEN' }, 403);
      if (request.method === 'GET') return json({ maintenance: { enabled: state.enabled } });
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        const body = JSON.parse(raw || '{}');
        state.posts.push({ body, origin: request.headers.origin });
        state.enabled = body.enabled;
        json({ maintenance: { enabled: state.enabled } });
      });
      return;
    }
    // `/` is what the script probes when it has no token: 503 is the maintenance page.
    if (state.enabled && !ignoreMaintenance) { response.writeHead(503); return response.end('维护中'); }
    response.writeHead(200); response.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { state, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

function runCli(args, env = {}) {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: root, env: { ...process.env, ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
}

test('arguments are parsed, and bad ones are refused', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.base, 'https://protocol.cc.cd');
  assert.equal(defaults.timeout, 15);
  assert.equal(defaults.force, false);

  const parsed = parseArgs(['--base', 'http://x/', '--timeout', '0', '--force', '--stop-after', 'drain']);
  assert.equal(parsed.base, 'http://x', 'a trailing slash would double up in every URL');
  assert.equal(parsed.timeout, 0);
  assert.equal(parsed.force, true);
  assert.equal(parsed.stopAfter, 'drain');

  assert.throws(() => parseArgs(['--timeout', '-1']), /不小于 0/);
  assert.throws(() => parseArgs(['--stop-after', 'nope']), /只能是/);
  assert.throws(() => parseArgs(['--base']), /需要一个值/);
  assert.throws(() => parseArgs(['--wat']), /未知参数/);
  assert.deepEqual(PHASES.slice(0, 3), ['preflight', 'drain', 'maintenance']);
});

test('a room counts as occupied only when someone is in it', () => {
  const items = [
    { roomId: 'AAAA', connectedHumans: 0, inMatch: false },
    { roomId: 'BBBB', connectedHumans: 1, inMatch: false },
    { roomId: 'CCCC', connectedHumans: 0, inMatch: true, spectatorCount: 2 },
    { roomId: 'DDDD' },
  ];
  assert.deepEqual(occupiedRooms(items).map((room) => room.roomId), ['BBBB', 'CCCC']);
  assert.deepEqual(occupiedRooms(null), []);
});

test('it refuses to deploy while a room has players', { timeout: 60000 }, async (t) => {
  const site = await stub({ rooms: [{ roomId: 'AAAA', connectedHumans: 1, inMatch: true, public: true }] });
  t.after(() => site.close());

  const { code, stdout } = await runCli(['--base', site.base, '--timeout', '0', '--yes']);
  assert.equal(code, EXIT.BUSY, stdout);
  assert.match(stdout, /AAAA\(对局中\)/);
  assert.match(stdout, /拒绝部署/);
  assert.match(stdout, /solo/, 'the blind spot has to be stated, not implied');
  assert.equal(site.state.posts.length, 0, 'nothing was touched');
});

test('--force goes past a busy directory, and without a token it waits for the switch', { timeout: 60000 }, async (t) => {
  const site = await stub({ rooms: [{ roomId: 'AAAA', connectedHumans: 1, inMatch: true }] });
  t.after(() => site.close());

  // `--timeout 0` means a single check, so the "waiting for maintenance" path fails fast here.
  const { code, stdout } = await runCli(['--base', site.base, '--timeout', '0', '--force', '--yes']);
  assert.equal(code, EXIT.MAINTENANCE, stdout);
  assert.match(stdout, /已加 --force/);
  assert.match(stdout, /未提供 SP_ADMIN_TOKEN/);
  assert.match(stdout, /维护页未生效/);
  assert.equal(site.state.posts.length, 0);
});

test('with a token it enables maintenance and stops before deploying', { timeout: 60000 }, async (t) => {
  const site = await stub({ rooms: [] });
  t.after(() => site.close());

  const { code, stdout } = await runCli(
    ['--base', site.base, '--timeout', '1', '--yes', '--stop-after', 'maintenance', '--message', '维护测试'],
    { SP_ADMIN_TOKEN: 'test-token' },
  );
  assert.equal(code, EXIT.OK, stdout);
  assert.match(stdout, /维护页已生效/);
  assert.match(stdout, /--stop-after=maintenance/);

  assert.equal(site.state.posts.length, 1, 'exactly one toggle');
  assert.deepEqual(site.state.posts[0].body, { enabled: true, message: '维护测试' });
  assert.equal(site.state.posts[0].origin, site.base, 'the admin route requires a same-origin request');
  assert.equal(site.state.enabled, true);
});

test('a wrong token stops the run instead of guessing', { timeout: 60000 }, async (t) => {
  const site = await stub({ rooms: [] });
  t.after(() => site.close());

  const { code, stdout } = await runCli(
    ['--base', site.base, '--timeout', '0', '--yes', '--stop-after', 'maintenance'],
    { SP_ADMIN_TOKEN: 'wrong-token' },
  );
  assert.equal(code, EXIT.MAINTENANCE, stdout);
  assert.match(stdout, /403/);
  assert.equal(site.state.enabled, false);
});

test('--maintenance-off is the way back out of a run that died', { timeout: 60000 }, async (t) => {
  const site = await stub({ rooms: [], enabled: true });
  t.after(() => site.close());

  const { code, stdout } = await runCli(['--base', site.base, '--maintenance-off'], { SP_ADMIN_TOKEN: 'test-token' });
  assert.equal(code, EXIT.OK, stdout);
  assert.match(stdout, /维护已结束/);
  assert.equal(site.state.enabled, false);
  assert.deepEqual(site.state.posts[0].body, { enabled: false });

  // Idempotent: running it again is a no-op, not an error.
  const again = await runCli(['--base', site.base, '--maintenance-off'], { SP_ADMIN_TOKEN: 'test-token' });
  assert.equal(again.code, EXIT.OK, again.stdout);
  assert.match(again.stdout, /本来就是关着的/);
  assert.equal(site.state.posts.length, 1);
});

test('--dry-run reports and changes nothing', { timeout: 60000 }, async (t) => {
  const site = await stub({ rooms: [{ roomId: 'AAAA', connectedHumans: 0, inMatch: false }] });
  t.after(() => site.close());

  const { code, stdout } = await runCli(['--base', site.base, '--dry-run'], { SP_ADMIN_TOKEN: 'test-token' });
  assert.equal(code, EXIT.OK, stdout);
  assert.match(stdout, /--dry-run/);
  assert.match(stdout, /线上 build\s+abc1234/);
  assert.match(stdout, /AAAA\(空闲\)/);
  assert.equal(site.state.posts.length, 0, 'no toggle, no deploy, nothing');
});
