#!/usr/bin/env node
// Deploy without dropping anyone's match.
//
// A deploy evicts every Durable Object, and an evicted room closes its WebSockets with 1012 - so everyone
// in a match reconnects. That is the "it sometimes asks me to reconnect" report, and it is not a bug in
// the room: it is what a deploy does. The fix is ordering, and ordering is easy to forget, so it is a
// script:
//
//   preflight    report the deployed build, the rules-version guard, and who is playing
//   drain        wait until nobody is in a match
//   maintenance  put the maintenance page up so nobody starts a match into the deploy
//   deploy       npx wrangler deploy
//   verify       poll /healthz until it reports the new build
//   record       npm run rules:record
//   restore      take the maintenance page down
//
// Putting maintenance up *before* draining would be better still - new arrivals are blocked while a match
// finishes - but the guard answers 503 for everything except /admin, its API and /healthz, so once it is
// on there is no way to watch a match end. Draining first and blocking immediately after leaves only a
// few seconds of exposure, and the public directory is the signal.
//
// KNOWN BLIND SPOT: the directory only lists public co-op rooms (`publicRoom && mode === 'coop'`), so a
// solo or unlisted room is invisible here. The script says so rather than implying the site is empty.
//
// Enabling maintenance needs ADMIN_TOKEN, which lives in the Worker's secrets and not on this machine.
// Pass it as SP_ADMIN_TOKEN for the run and the script flips the switch itself (it is never written to
// disk); without it the script prints what to click and waits for the switch to appear.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const runAsync = promisify(execFile);

export const PHASES = ['preflight', 'drain', 'maintenance', 'deploy', 'verify', 'record', 'restore'];
// Exit codes, so a caller (or a wrapper script) can tell "refused, nobody was hurt" from "it broke".
export const EXIT = { OK: 0, USAGE: 1, BUSY: 2, MAINTENANCE: 3, VERIFY: 4, DEPLOY: 5 };

const DEFAULT_MESSAGE = '服务器正在维护，请稍后再来。';
const HELP = `用法: node tools/deploy-safe.mjs [选项]

  --base <url>         站点地址（默认 https://protocol.cc.cd）
  --message <文本>     维护页公告
  --timeout <分钟>     等待排空/维护生效的上限，0 表示只查一次（默认 15）
  --stop-after <阶段>  做到某个阶段就停（${PHASES.join(' | ')}）
  --allow-rules-change 规则版本已变时仍继续（会传给 wrangler 的守卫）
  --maintenance-off    只关闭维护页（脚本中途挂了之后用来收尾），不做别的
  --force              目录里有人在对局时也继续（默认拒绝）
  --dry-run            只做 preflight，打印后续计划，不改动任何东西
  --yes                跳过部署前的交互确认（非交互环境必须显式给出）
  --help

环境变量:
  SP_ADMIN_TOKEN       管理令牌；给出则脚本自己开关维护，否则提示你手动开关并等待
`;

export function parseArgs(argv) {
  const opts = { base: 'https://protocol.cc.cd', message: DEFAULT_MESSAGE, timeout: 15,
    stopAfter: null, allowRulesChange: false, maintenanceOff: false, force: false, dryRun: false, yes: false, help: false };
  const value = (name, i) => {
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) throw new Error(`${name} 需要一个值`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--yes') opts.yes = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--allow-rules-change') opts.allowRulesChange = true;
    else if (arg === '--maintenance-off') opts.maintenanceOff = true;
    else if (arg === '--base') opts.base = value(arg, i++);
    else if (arg === '--message') opts.message = value(arg, i++);
    else if (arg === '--timeout') {
      const minutes = Number(value(arg, i++));
      if (!Number.isFinite(minutes) || minutes < 0) throw new Error('--timeout 必须是不小于 0 的数字');
      opts.timeout = minutes;
    } else if (arg === '--stop-after') {
      const phase = value(arg, i++);
      if (!PHASES.includes(phase)) throw new Error(`--stop-after 只能是: ${PHASES.join(' | ')}`);
      opts.stopAfter = phase;
    } else throw new Error(`未知参数: ${arg}`);
  }
  opts.base = opts.base.replace(/\/+$/, '');
  return opts;
}

/** Rooms with someone in them. The directory's own listing shape, so this stays a pure filter. */
export function occupiedRooms(items) {
  return (items || []).filter((room) => (room?.connectedHumans || 0) > 0 || !!room?.inMatch);
}

export function describeRooms(items) {
  const rooms = items || [];
  if (!rooms.length) return '公开房间：无';
  return '公开房间：' + rooms.map((room) => {
    const humans = room.connectedHumans || 0;
    const flag = room.inMatch ? '对局中' : (humans ? `${humans} 人在座` : '空闲');
    return `${room.roomId || '?'}(${flag})`;
  }).join(' ');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text = '') => process.stdout.write(text + '\n');
const phase = (name) => log(`\n=== ${name} ===`);

async function getJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: response.status, body, text };
}

async function deployedBuild(base) {
  try {
    const { status, body } = await getJson(base + '/healthz');
    return status === 200 && body?.build ? body.build : null;
  } catch { return null; }
}

async function publicRooms(base) {
  const { status, body } = await getJson(base + '/api/rooms?limit=50');
  if (status !== 200 || !Array.isArray(body?.items)) return { unknown: true, status, items: [] };
  return { unknown: false, items: body.items };
}

/** Maintenance state. With a token the admin route answers directly; without one, 503 on `/` means on.
 *  Never throws: callers need "could not tell" to be its own answer, not an abort. */
async function maintenanceState(base, token) {
  if (token) {
    try {
      const { status, body } = await getJson(base + '/api/admin/maintenance', { headers: { 'X-Admin-Token': token } });
      if (status === 200 && body?.maintenance) return { ok: true, enabled: !!body.maintenance.enabled };
      return { ok: false, reason: `管理接口返回 ${status}` };
    } catch (error) { return { ok: false, reason: String(error?.message || error) }; }
  }
  try {
    const response = await fetch(base + '/', { signal: AbortSignal.timeout(15_000) });
    return { ok: true, enabled: response.status === 503 };
  } catch (error) { return { ok: false, reason: String(error?.message || error) }; }
}

async function setMaintenance(base, token, enabled, message) {
  const response = await fetch(base + '/api/admin/maintenance', {
    method: 'POST',
    headers: { 'X-Admin-Token': token, 'Content-Type': 'application/json', Origin: new URL(base).origin },
    body: JSON.stringify({ enabled, ...(enabled ? { message } : {}) }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`切换维护失败 ${response.status}: ${text.slice(0, 200)}`);
  return true;
}

/** Poll until `check()` returns true, or the deadline passes. `minutes === 0` means a single attempt. */
async function waitFor(check, minutes) {
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    if (await check()) return true;
    if (minutes === 0 || Date.now() >= deadline) return false;
    await sleep(15_000);
  }
}

async function confirm(question, yes) {
  if (yes) return true;
  if (!process.stdin.isTTY) throw new Error('非交互环境：确认部署请显式加 --yes');
  process.stdout.write(question + ' [y/N] ');
  return await new Promise((resolve) => {
    process.stdin.once('data', (data) => resolve(/^y(es)?$/i.test(String(data).trim())));
  });
}

async function shortHead() {
  const { stdout } = await runAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root });
  return stdout.trim();
}

async function rulesGuard() {
  try {
    const { stdout } = await runAsync(process.execPath, ['tools/rules-version-guard.mjs', 'check'], { cwd: root });
    return { ok: true, detail: stdout.trim().split('\n').filter(Boolean).at(-1) || 'ok' };
  } catch (error) {
    const output = String(error.stdout || '') + String(error.stderr || '');
    return { ok: false, changed: output.includes('REFUSING TO DEPLOY'), detail: output.trim().split('\n')[0] || 'guard failed' };
  }
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try { opts = parseArgs(argv); }
  catch (error) { log(String(error.message)); log(HELP); return EXIT.USAGE; }
  if (opts.help) { log(HELP); return EXIT.OK; }

  const token = process.env.SP_ADMIN_TOKEN || '';

  // A run that dies between "maintenance on" and "maintenance off" leaves the site dark, so taking it down
  // again has to be its own action rather than something the operator has to reconstruct.
  if (opts.maintenanceOff) {
    phase('maintenance off');
    if (!token) { log('--maintenance-off 需要 SP_ADMIN_TOKEN。'); return EXIT.USAGE; }
    const state = await maintenanceState(opts.base, token);
    if (!state.ok) { log(`无法确认维护状态：${state.reason}`); return EXIT.MAINTENANCE; }
    if (!state.enabled) { log('维护页本来就是关着的。'); return EXIT.OK; }
    try { await setMaintenance(opts.base, token, false); }
    catch (error) { log(`关闭维护失败：${error?.message || error}`); return EXIT.MAINTENANCE; }
    const off = await waitFor(async () => { const now = await maintenanceState(opts.base, token); return now.ok && !now.enabled; }, 1);
    log(off ? '维护已结束，站点恢复。' : '已请求结束维护，但状态仍是开启 —— 请到 /admin 确认。');
    return off ? EXIT.OK : EXIT.MAINTENANCE;
  }

  const reached = async (name) => {
    if (opts.stopAfter !== name) return true;
    log(`\n--stop-after=${name}：到此为止。`);
    return false;
  };

  // ---- preflight -------------------------------------------------------------------------------
  phase('preflight');
  const build = await deployedBuild(opts.base);
  const head = await shortHead().catch(() => '?');
  const rooms = await publicRooms(opts.base).catch((error) => ({ unknown: true, status: 0, items: [], error: String(error?.message) }));
  const guard = await rulesGuard();
  log(`站点          ${opts.base}`);
  log(`线上 build    ${build || '（查不到：站点不可达或未部署）'}`);
  log(`本地 HEAD     ${head}`);
  log(`规则版本      ${guard.ok ? '一致' : (guard.changed ? '已变化（守卫会拦，需要 --allow-rules-change）' : '守卫执行失败：' + guard.detail)}`);
  log(rooms.unknown ? `房间          ${describeRooms([])}（列表不可用，视为未知）` : describeRooms(rooms.items));
  const busy = rooms.unknown ? [] : occupiedRooms(rooms.items);
  if (rooms.unknown) log('              注意：列表不可用，无法确认是否有人在玩。');

  if (opts.dryRun) {
    log('\n--dry-run：后续计划如下，未做任何改动。');
    log(rooms.unknown
      ? '  1 drain       房间列表不可用 → 会拒绝部署（除非 --force）'
      : `  1 drain       等待 ${opts.timeout} 分钟内公开房间清空${opts.force ? '（已加 --force，会跳过）' : ''}`);
    log('  2 maintenance ' + (token ? '用 SP_ADMIN_TOKEN 打开维护页' : '提示你打开维护页并等待生效'));
    log('  3 deploy      npx wrangler deploy' + (guard.changed && !opts.allowRulesChange ? '（会被守卫拦下，需要 --allow-rules-change）' : ''));
    log(`  4 verify      轮询 /healthz 直到 build == ${head}`);
    log('  5 record      npm run rules:record');
    log('  6 restore     关闭维护页');
    return EXIT.OK;
  }
  if (!await reached('preflight')) return EXIT.OK;

  // ---- drain -----------------------------------------------------------------------------------
  phase('drain');
  if (busy.length && !opts.force) {
    log(`${busy.length} 个房间有人：${describeRooms(busy)}`);
    log(`最多等 ${opts.timeout} 分钟（每 15 秒复查一次）…`);
  } else {
    log(opts.force ? '已加 --force，跳过排空检查。' : '公开房间为空。');
  }
  const clear = opts.force || await waitFor(async () => {
    const current = await publicRooms(opts.base).catch(() => ({ unknown: true, items: [] }));
    // An unreadable list is not an empty one: treat it as busy so a broken probe cannot green-light a deploy.
    if (current.unknown) return false;
    const remaining = occupiedRooms(current.items);
    if (remaining.length) log(`  仍有 ${remaining.length} 个房间有人：${describeRooms(remaining)}`);
    return remaining.length === 0;
  }, opts.timeout);
  if (!clear) {
    log('\n拒绝部署：还有人可能在玩（或房间列表不可用）。');
    log('  · 等他们结束，或加 --timeout <分钟> 多等一会儿');
    log('  · 确定没有人在玩（例如只有你自己在单机）时，加 --force');
    log('  · solo / 未公开的房间不在这份列表里，脚本看不到它们');
    return EXIT.BUSY;
  }
  log('排空完成。');
  if (!await reached('drain')) return EXIT.OK;

  // ---- maintenance -----------------------------------------------------------------------------
  phase('maintenance');
  let enabledByUs = false;
  if (!token) {
    log('未提供 SP_ADMIN_TOKEN，无法自动开关维护。请手动打开：');
    log(`  1. 打开 ${opts.base}/admin ，填入管理令牌`);
    log('  2. 点「进入维护」');
    log(`（最长等 ${opts.timeout} 分钟；也可以带上 SP_ADMIN_TOKEN 让脚本自己切）`);
  } else {
    const before = await maintenanceState(opts.base, token);
    if (!before.ok) {
      log(`无法确认维护状态：${before.reason}`);
      log('站点未被改动，部署已取消。');
      return EXIT.MAINTENANCE;
    }
    if (before.enabled) {
      log('维护页本来就是开着的。');
    } else {
      try {
        await setMaintenance(opts.base, token, true, opts.message);
        enabledByUs = true;
        log('已请求打开维护页。');
      } catch (error) {
        log(`切换维护失败：${error?.message || error}`);
        log('站点未被改动，部署已取消。');
        return EXIT.MAINTENANCE;
      }
    }
  }
  const on = await waitFor(async () => { const state = await maintenanceState(opts.base, token); return state.ok && state.enabled; }, opts.timeout);
  if (!on) {
    log('\n维护页未生效，已停止（不确定时不动线上）。');
    return EXIT.MAINTENANCE;
  }
  log('维护页已生效：新连接会被挡在门外。');
  await sleep(2_000);   // let the per-isolate cache (10 s) settle before pulling the rug
  if (!await reached('maintenance')) {
    if (enabledByUs) log('提醒：维护页仍开着（部署还没做）。关闭：/admin 点「结束维护」，或带 SP_ADMIN_TOKEN 跑 --maintenance-off');
    return EXIT.OK;
  }

  // ---- deploy ----------------------------------------------------------------------------------
  phase('deploy');
  if (guard.changed && !opts.allowRulesChange) {
    log('规则版本已变，守卫会拒绝部署。确认现在没有进行中的对局后，加 --allow-rules-change 重跑。');
    return EXIT.DEPLOY;
  }
  if (!await confirm(`现在部署 ${head} 到 ${opts.base}？`, opts.yes)) {
    log('已取消。维护页仍然开着。');
    return EXIT.OK;
  }
  const deploy = spawn('npx', ['wrangler', 'deploy'], {
    cwd: root, stdio: 'inherit', shell: true,
    env: { ...process.env, ...(opts.allowRulesChange ? { SP_ALLOW_RULES_CHANGE: '1' } : {}) },
  });
  const code = await new Promise((resolve) => deploy.on('close', resolve));
  if (code !== 0) {
    log(`\n部署失败（退出码 ${code}）。维护页仍然开着，线上还是旧版本 —— 修好后可以只重跑 deploy 之后的步骤。`);
    return EXIT.DEPLOY;
  }
  if (!await reached('deploy')) return EXIT.OK;

  // ---- verify ----------------------------------------------------------------------------------
  phase('verify');
  const live = await waitFor(async () => (await deployedBuild(opts.base)) === head, 2);
  const nowBuild = await deployedBuild(opts.base);
  log(`线上 build    ${nowBuild || '（查不到）'}`);
  if (!live) {
    log(`\n新版本没有在 /healthz 上报出来（期望 ${head}）。等一两分钟再查一次；`);
    log('若仍是旧值，检查 wrangler 的输出，并且别忘了关闭维护页。');
    return EXIT.VERIFY;
  }
  log('新版本已生效。');
  if (!await reached('verify')) return EXIT.OK;

  // ---- record + restore ------------------------------------------------------------------------
  phase('record');
  const record = spawn('npm', ['run', 'rules:record'], { cwd: root, stdio: 'inherit', shell: true });
  const recordCode = await new Promise((resolve) => record.on('close', resolve));
  if (recordCode !== 0) log('记录规则版本失败 —— 下次部署的守卫会拿旧值比对，请手动跑 npm run rules:record。');

  phase('restore');
  if (token) {
    try {
      await setMaintenance(opts.base, token, false);
      const off = await waitFor(async () => { const state = await maintenanceState(opts.base, token); return state.ok && !state.enabled; }, 1);
      log(off ? '维护已结束，站点恢复。' : '已请求结束维护，但状态仍是开启 —— 请到 /admin 确认。');
    } catch (error) {
      log(`关闭维护失败：${error?.message || error}`);
      log(`部署已完成，但站点仍显示维护页 —— 到 ${opts.base}/admin 手动关掉。`);
    }
  } else {
    log(`请手动关闭维护：${opts.base}/admin → 「结束维护」。`);
  }
  log('\n完成。');
  return EXIT.OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    log(`\n意外错误: ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
