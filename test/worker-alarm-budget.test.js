import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, Lobby } from '../server/lobby.js';
import { RoomRuntime, AlarmMatch, ALARM, ROOM_LIMITS } from '../worker/room-runtime.js';
import { RoomDurableObject } from '../worker/index.js';
import { DATA } from './match/harness.js';
import { FakeBattle } from './match/fakeBattle.js';

const DAY_MS = 86_400_000;

const buildAlarmMatch = (now = () => Date.now()) => {
  const logs = { error: [], warn: [] };
  const log = { info() {}, debug() {}, warn: (...a) => logs.warn.push(a.map(String).join(' ')), error: (...a) => logs.error.push(a.map(String).join(' ')) };
  FakeBattle.reset();
  return new AlarmMatch({
    roomCode: 'ABCD', mode: 'solo', difficulty: 'NORMAL', now,
    seats: [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: true, connected: true }],
    seed: 7, data: DATA, log, registry: null, botRehearsal: 0,
    send: () => true, broadcast: () => {}, onEnd: () => {},
    BattleClass: FakeBattle,
  });
};

// The Workers free plan only bills Durable Object duration while the object is awake, and it only
// lets an object hibernate once it holds no live JS timer. A match used to be advanced by
// setInterval(), which kept the object awake — and billed — for the entire match. These tests lock
// the alarm cadence to a coarse grid instead.

const makeRoom = (now, match) => {
  const runtime = new RoomRuntime({ now: () => now });
  const room = new Room('ABCD', 'coop', 'normal', now);
  room.match = match;
  runtime.lobby.rooms.set(room.code, room);
  runtime.code = room.code;
  return runtime;
};

test('a match in progress schedules a coarse alarm, grid-aligned and never below the floor', () => {
  const now = Date.UTC(2026, 9, 3, 12, 0, 0, 250);
  const runtime = makeRoom(now, { recording: null, sched: { nextAt: () => null } });
  const at = runtime.nextAlarm();
  assert.equal(at % ALARM.gridMs, 0, 'alarm must land on the 1s grid so objects sleep in phase');
  assert.ok(at >= now + ALARM.matchTickMs, `expected >= ${now + ALARM.matchTickMs}, got ${at}`);
  assert.ok(at <= now + ALARM.matchTickMs + ALARM.gridMs, `expected <= ${now + ALARM.matchTickMs + ALARM.gridMs}, got ${at}`);
});

test('an idle room has no alarm and the object can hibernate at zero cost', () => {
  const now = Date.UTC(2026, 9, 3, 12, 0, 0, 0);
  const runtime = new RoomRuntime({ now: () => now });
  assert.equal(runtime.nextAlarm(), null, 'an empty room must not keep the object awake');
});

test('a recorded match keeps its own timer deadline but still respects the minimum spacing', () => {
  const now = Date.UTC(2026, 9, 3, 12, 0, 0, 0);
  const runtime = makeRoom(now, { recording: {}, sched: { nextAt: () => now + 250 } });
  const at = runtime.nextAlarm();
  assert.ok(at >= now + ALARM.floorMs);
  assert.ok(at % ALARM.gridMs === 0);
});

test('deadlines closer than the floor are pushed out instead of waking the object needlessly', () => {
  const now = Date.UTC(2026, 9, 3, 12, 0, 0, 0);
  const runtime = makeRoom(now, { recording: null, sched: { nextAt: () => null } });
  runtime.lobby.deadlines.set('player-1', now + 50);
  const at = runtime.nextAlarm();
  assert.ok(at >= now + ALARM.floorMs);
  assert.equal(at % ALARM.gridMs, 0);
});

test('the alarm grid leaves the DO request budget for many rooms a day', () => {
  assert.ok(DAY_MS / ALARM.gridMs <= 20_000, `a ${ALARM.gridMs}ms grid costs ${DAY_MS / ALARM.gridMs} requests/day per room`);
  assert.ok(ALARM.matchTickMs >= ALARM.floorMs);
  assert.ok(ALARM.gridMs >= ALARM.matchTickMs, 'the safety tick must land on the grid, not trigger an early wake');
});

test('the worker holds no real JS timer, so the object can hibernate between alarms', () => {
  const realInterval = globalThis.setInterval;
  const realTimeout = globalThis.setTimeout;
  const scheduled = [];
  globalThis.setInterval = (...a) => { scheduled.push('interval'); return realInterval(...a); };
  globalThis.setTimeout = (...a) => { scheduled.push('timeout'); return realTimeout(...a); };
  try {
    const match = buildAlarmMatch();
    assert.equal(match.sched.virtual, true, 'the match must run on a pumpable clock');
    assert.equal(match.sched.instant, false, 'paced, not instant, so the alarm window keeps real dt');
    match.start();
    assert.deepEqual(scheduled, [], `no real timer may be scheduled, got ${scheduled.join()}`);
  } finally {
    globalThis.setInterval = realInterval;
    globalThis.setTimeout = realTimeout;
  }
});

test('one alarm window pumps the whole interval in order, so the match keeps real-time pacing', () => {
  const t0 = Date.UTC(2026, 9, 3, 12, 0, 0, 0);
  const match = buildAlarmMatch(() => t0);
  match.start();
  // One alarm window must replay every 1/30s pacing callback that fell due, not just the first one.
  const perWindow = Math.floor(ALARM.gridMs / (1000 / 30));
  match.sched.setInterval(() => {}, 1000 / 30); // the field pacer of a live battle
  const n = match.pump(t0 + ALARM.gridMs);
  assert.ok(n >= perWindow, `expected >= ${perWindow} callbacks per window, pumped ${n}`);
  assert.equal(match.sched.now(), t0 + ALARM.gridMs, 'the clock catches up to the alarm window');
  for (let w = 2; w <= 4; w++) match.pump(t0 + ALARM.gridMs * w);
  assert.equal(match.sched.now(), t0 + ALARM.gridMs * 4);
});

test('persist() stays argument-free so a subclass override cannot swallow the force flag', () => {
  // The Durable Object is subclassed in tests (and could be by an operator) to inject storage
  // failures. A `persist({force})` signature would silently lose the flag in such an override and
  // let the MATCH_PERSIST_MS throttle swallow a match start, so the intent travels on the instance.
  assert.equal(RoomDurableObject.prototype.persist.length, 0, 'persist() must declare no parameters');
  assert.equal(typeof RoomDurableObject.prototype.persistNow, 'function');
  const calls = [];
  const probe = { persist() { calls.push(this.persistForced); } };
  RoomDurableObject.prototype.persistNow.call(probe);
  assert.deepEqual(calls, [true], 'persistNow must reach persist() with the force flag set');
});

test('the idle-socket sweep window stays well above the alarm grid', () => {
  assert.ok(ROOM_LIMITS.idleSocketMs >= ALARM.gridMs * 10, 'a 90s idle window must not force sub-second alarms');
  assert.ok(ALARM.matchTickMs >= ALARM.floorMs, 'the match tick cannot be finer than the alarm floor');
});
