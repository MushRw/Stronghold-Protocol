import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountHarness } from './helpers/account-harness.js';
import { bundleWorker } from '../../tools/build-worker.mjs';
import { ACCOUNT_ERRORS } from '../../public/js/account.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Seats, resuming and the way out of a seat the room will not let go of. The reported symptom was a player
// who started a solo simulation, was told "ALREADY_SEATED" when they pressed start again, and then could not
// resume either - with nothing in the interface to try. These walk the same calls the console makes.
const ACTORS = { a: 'a'.repeat(64), b: 'b'.repeat(64), c: 'c'.repeat(64) };

async function seatHarness(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-seat-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await bundleWorker({ outfile: path.join(dir, 'worker.mjs') });
  const file = path.join(dir, 'worker.mjs').replaceAll('\\', '/');
  const session = (actor) => ACTORS[actor] || ACTORS.a;
  const source = `
    import worker,{SiteDirectory,AccountDurableObject as ProductionAccount,RoomDurableObject,AdmissionDurableObject,MatchArchive} from ${JSON.stringify(file)};
    import {hash} from './worker/accounts/auth.js';
    // Ageing a claim needs storage access, and the production object exposes no such route.
    export class AccountDurableObject extends ProductionAccount {
      async expireSeat(){const seat=await this.getActiveSeat();if(seat)await this.ctx.storage.put('activeSeat',{...seat,expiresAt:Date.now()-1});return seat||null;}
    }
    export {SiteDirectory,RoomDurableObject,AdmissionDurableObject,MatchArchive};
    const TOKENS = ${JSON.stringify(ACTORS)};
    export default {async fetch(request, env) {
      const url = new URL(request.url);
      if (request.headers.get('Upgrade') === 'websocket') {
        const token = TOKENS[url.searchParams.get('actor')] || TOKENS.a;
        return worker.fetch(new Request('https://game.example' + url.pathname + url.search, { headers: {
          Upgrade: 'websocket', Origin: 'https://game.example', cookie: '__Host-sp_session=' + token } }), env);
      }
      const input = await request.json();
      const token = TOKENS[input.actor] || TOKENS.a;
      if (input.expireSeat) {
        const site = env.SITES.get(env.SITES.idFromName('directory'));
        const who = input.actor || 'a';
        const user = await site.resolveGithubUser({ id: String(who).charCodeAt(0), login: 'Player ' + who, avatarUrl: null });
        return Response.json(await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(user.accountId)).expireSeat());
      }
      if (input.seed) {
        const site = env.SITES.get(env.SITES.idFromName('directory'));
        const user = await site.resolveGithubUser({ id: String(input.actor || 'a').charCodeAt(0), login: 'Player ' + (input.actor || 'a'), avatarUrl: null });
        await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(user.accountId)).setProfile(user);
        await site.saveSession(await hash(token), { accountId: user.accountId, expiresAt: Date.now() + 600000 });
        return Response.json(user);
      }
      return worker.fetch(new Request('https://game.example' + input.path, { method: input.method || 'GET',
        headers: { Origin: 'https://game.example', cookie: '__Host-sp_session=' + token, ...(input.headers || {}) },
        body: input.body === undefined ? undefined : JSON.stringify(input.body) }), env);
    }};`;
  const durableObjects = Object.fromEntries([['SITES', 'SiteDirectory'], ['ACCOUNTS', 'AccountDurableObject'],
    ['ROOMS', 'RoomDurableObject'], ['ADMISSION', 'AdmissionDurableObject'], ['MATCH_ARCHIVES', 'MatchArchive']]
    .map(([key, className]) => [key, { className, useSQLite: true }]));
  const h = await createAccountHarness(source, { durableObjects });
  t.after(() => h.dispose());
  for (const actor of Object.keys(ACTORS)) await h.fetch({ seed: true, actor });

  const connect = async (route, actor = 'a') => {
    const query = 'room=' + route.code + (route.ticket ? '&ticket=' + route.ticket : '') + '&actor=' + actor;
    const response = await h.request('https://test.example/ws?' + query, { headers: { Upgrade: 'websocket' } });
    if (response.status !== 101) return { status: response.status, body: await response.text() };
    const ws = response.webSocket;
    const frames = [];
    ws.addEventListener('message', (e) => frames.push(JSON.parse(e.data)));
    ws.accept();
    const wait = async (type, rid) => {
      for (let i = 0; i < 200; i++) {
        const frame = frames.find((f) => f.t === type && (rid === undefined || f.rid === rid));
        if (frame) return frame;
        await new Promise((r) => setTimeout(r, 20));
      }
      return null;
    };
    ws.send(JSON.stringify({ t: 'hello', name: 'Alice', rid: 1 }));
    return { ws, frames, wait, welcome: await wait('welcome') };
  };
  const send = async (c, t, fields = {}, rid = 10) => {
    c.ws.send(JSON.stringify({ t, ...fields, rid, commandId: 'command-' + rid }));
    return c.wait('ok', rid);
  };
  const open = async (actor = 'a', mode = 'solo') => {
    const reserve = await h.fetch({ actor, path: '/api/rooms', method: 'POST' });
    assert.equal(reserve.status, 201, await reserve.clone().text());
    const route = await reserve.json();
    const c = await connect(route, actor);
    await send(c, 'room.create', { mode, difficulty: 'FUNNY' }, 2);
    return { c, route, code: route.code };
  };
  return { h, connect, send, open, session };
}

test('a seated solo player is told to resume, and resuming actually works', { timeout: 90000 }, async (t) => {
  const { h, open, connect, send } = await seatHarness(t);
  const { c, code } = await open('a', 'solo');
  await send(c, 'room.start', {}, 3);
  assert.ok(c.frames.some((f) => f.t === 'm.public'), 'the match must be running before we resume into it');

  // Starting again is refused because the account still holds a seat. Correct - and it must be legible.
  const again = await h.fetch({ path: '/api/rooms', method: 'POST' });
  assert.equal(again.status, 409);
  const refusal = await again.json();
  assert.equal(refusal.error, 'ALREADY_SEATED');
  assert.ok(ACCOUNT_ERRORS[refusal.error], 'a player must never be shown a raw error code: ' + refusal.error);

  const resume = await h.fetch({ path: '/api/me/resume', method: 'POST' });
  assert.equal(resume.status, 200, await resume.clone().text());
  const back = await connect(await resume.json());
  assert.ok(back.welcome, 'the resumed socket must be welcomed: ' + JSON.stringify(back.frames));
  assert.equal(back.welcome.playerId, c.welcome.playerId, 'resume must rejoin the same player');
  assert.ok(await back.wait('room.state'), 'the resumed client must receive room state');
  back.ws.send(JSON.stringify({ t: 'room.leave', rid: 9 }));
  await back.wait('ok', 9);
  back.ws.close();
  c.ws.close();
  assert.equal(code.length, 4);
});

test('the same works after the tab was closed and reopened', { timeout: 90000 }, async (t) => {
  const { h, open, connect, send } = await seatHarness(t);
  const { c } = await open('a', 'solo');
  await send(c, 'room.start', {}, 3);

  // The tab goes away without leaving: seat and match must both survive it.
  c.ws.close();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await h.fetch({ path: '/api/rooms', method: 'POST' })).status, 409,
    'a disconnected player still holds the seat');

  const resume = await h.fetch({ path: '/api/me/resume', method: 'POST' });
  assert.equal(resume.status, 200, await resume.clone().text());
  const back = await connect(await resume.json());
  assert.ok(back.welcome, 'a reopened tab must be welcomed back: ' + JSON.stringify(back.frames));
  assert.equal(back.welcome.playerId, c.welcome.playerId);
  assert.ok(back.welcome.resumed, 'the server must recognise this as a resume, not a new player');
  back.ws.close();
});

test('a seat can be given up, which is the only way out of a room that will not let go', { timeout: 90000 }, async (t) => {
  const { h, open, send } = await seatHarness(t);
  const { c } = await open('a', 'solo');
  await send(c, 'room.start', {}, 3);

  // Reading it over GET must not work: it changes state.
  assert.equal((await h.fetch({ path: '/api/me/release-seat' })).status, 405);

  const released = await h.fetch({ path: '/api/me/release-seat', method: 'POST' });
  assert.equal(released.status, 200, await released.clone().text());
  const body = await released.json();
  assert.equal(body.activeSeat, null);
  assert.equal(body.left, true, 'the room must have dropped the player, not just the claim');
  assert.equal((await (await h.fetch({ path: '/api/me/active-match' })).json()).activeSeat, null);

  // The whole point: a new match is startable again straight away.
  const next = await h.fetch({ path: '/api/rooms', method: 'POST' });
  assert.equal(next.status, 201, await next.clone().text());

  // Idempotent, and safe to press twice.
  assert.equal((await (await h.fetch({ path: '/api/me/release-seat', method: 'POST' })).json()).left, false);
  c.ws.close();
});

test('giving up the seat also withdraws a join request the room already approved', { timeout: 90000 }, async (t) => {
  const { h, open, connect, send } = await seatHarness(t);
  const { c, code } = await open('a', 'coop');

  const applied = await h.fetch({ actor: 'b', path: '/api/rooms/' + code + '/applications', method: 'POST', body: { action: 'apply' } });
  assert.equal(applied.status, 201, await applied.clone().text());
  const item = await applied.json();
  const approved = await h.fetch({ path: '/api/rooms/' + code + '/applications', method: 'POST', body: { action: 'approve', id: item.id } });
  assert.equal(approved.status, 200, await approved.clone().text());

  // An approval the guest never took up still holds the seat, so the guest cannot start anything either.
  assert.equal((await h.fetch({ actor: 'b', path: '/api/rooms', method: 'POST' })).status, 409);

  const released = await h.fetch({ actor: 'b', path: '/api/me/release-seat', method: 'POST' });
  assert.equal(released.status, 200, await released.clone().text());
  // The room must forget the approval too, or it would still count the account as present.
  const list = await (await h.fetch({ path: '/api/rooms/' + code + '/applications' })).json();
  assert.equal(list.items.filter((x) => x.status === 'approved').length, 0,
    'a withdrawn approval must not keep counting as a seat: ' + JSON.stringify(list.items));
  assert.equal((await h.fetch({ actor: 'b', path: '/api/rooms', method: 'POST' })).status, 201,
    'the guest must be able to start a match of their own');
  c.ws.close();
  void connect;
});

// What a dropped connection between reserving a room and connecting to it leaves behind: the claim exists,
// the room does not. The account is not playing anything, so it must not be told it has a match, and once
// the claim's own lease is up the next attempt has to go through instead of being refused.
test('a room that was reserved but never connected to is not a seat', { timeout: 90000 }, async (t) => {
  const { h } = await seatHarness(t);
  const reserved = await h.fetch({ path: '/api/rooms', method: 'POST' });
  assert.equal(reserved.status, 201, await reserved.clone().text());
  const route = await reserved.json();
  // No socket is ever opened: this is the network dying between the two calls.

  const pending = await h.fetch({ path: '/api/rooms', method: 'POST' });
  assert.equal(pending.status, 409, 'inside the lease the attempt is still live');
  const body = await pending.json();
  assert.equal(body.error, 'SEAT_PENDING', 'a reservation must not be reported as a running match');
  assert.ok(ACCOUNT_ERRORS[body.error], 'and it must be readable: ' + body.error);

  // The claim lease is the client's deadline to finish connecting. Once it passes, the attempt is over.
  await h.fetch({ expireSeat: true });
  const next = await h.fetch({ path: '/api/rooms', method: 'POST' });
  assert.equal(next.status, 201, 'an expired attempt must not keep refusing new starts: ' + await next.clone().text());
  const nextRoute = await next.json();
  assert.notEqual(nextRoute.code, route.code, 'a fresh room is a fresh code');
  assert.equal((await (await h.fetch({ path: '/api/me/active-match' })).json()).activeSeat.roomId, nextRoute.code);
});
