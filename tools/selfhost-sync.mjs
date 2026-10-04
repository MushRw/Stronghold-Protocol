#!/usr/bin/env node
// Lay this project's game content on top of an upstream revision, driven by selfhost/manifest.json.
//
// Why this exists: this repo is BBleae's Cloudflare Workers port of the game; upstream sgangss publishes
// a plain Node server and has said (PR #34) that each fork maintains itself. Our history and theirs share
// no ancestor (0 common commits), so `git merge` is meaningless and "N commits behind" is a false number.
// What differs is small and enumerable, and the manifest enumerates it:
//
//   policy.keep    ours, never overwritten        (the Workers layer, our client modules, our tests)
//   policy.follow  three-way merged from upstream (engine, data, client UI, shared modules)
//   policy.ignore  left exactly as it is          (Node runtime, upstream tests/tools/docs)
//   upstreamBase   the upstream commit to merge against - NOT our snapshot; see the note in the manifest.
//
// The order matters and cost two rounds to get right:
//   1. export the upstream tree
//   2. copy EVERY file of ours that we own or changed on top of it (the upstream tree simply does not
//      contain the Workers layer, and it ships a version of public/js/audio.js with the voice feature
//      removed) - without this step the result is missing our files
//   3. three-way merge the files upstream changed inside `follow`, reading `ours` from our working tree
//      (never from the export - that was a bug: comparing our file to itself reported false success)
//
// All subprocess calls are async: spawnSync fails with EBUSY in this project's tool sandbox.
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, mkdtempSync, statSync, renameSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const OPTS = { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 };

const runAsync = (cmd, args, opts = {}) => execFileAsync(cmd, args, { ...OPTS, ...opts });
/** Git with the exit code preserved instead of thrown - `git merge-file` reports conflict count that way. */
const gitRaw = async (...args) => {
  try {
    const { stdout, stderr } = await runAsync('git', args);
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code === 'number') return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    throw error;
  }
};
const git = async (...args) => {
  const out = await gitRaw(...args);
  if (out.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr.trim()}`);
  return out.stdout;
};
const gitOk = async (...args) => (await gitRaw(...args)).code === 0;

const manifest = JSON.parse(readFileSync(path.join(root, 'selfhost/manifest.json'), 'utf8'));
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const outIndex = argv.indexOf('--out');
const ref = argv.find((a) => !a.startsWith('--') && argv[outIndex + 1] !== a)
  || (manifest.upstream?.remote || 'sgangss') + '/master';

if (flags.has('--fetch')) {
  const remote = ref.split('/')[0];
  console.log(`fetch ${remote}...`);
  await runAsync('git', ['-c', 'http.sslVerify=false', 'fetch', remote]);
}
if (!(await gitOk('cat-file', '-e', ref))) { console.error(`找不到 ref: ${ref}`); process.exit(2); }
const BASE = manifest.upstreamBase?.commit;
if (!BASE || !(await gitOk('cat-file', '-e', BASE))) { console.error(`找不到合并基线: ${BASE}`); process.exit(2); }

const policy = manifest.policy || {};
const inList = (list, p) => (list || []).some((x) => p === x || p.startsWith(x));
// keep beats follow beats ignore: an upstream directory rule must never overwrite the Workers layer
// (server/match/ is followed, but server/match/checkpoint.js is ours).
const classify = (p) => (inList(policy.keep, p) ? 'keep' : inList(policy.follow, p) ? 'follow' : 'ignore');

const outDir = outIndex >= 0 ? path.resolve(argv[outIndex + 1]) : path.join(os.tmpdir(), 'sp-sync', ref.replace(/[^A-Za-z0-9._-]/g, '_'));
if (existsSync(outDir)) {
  // Rename, do not delete. A recursive delete from Node is intercepted on Windows by the tool sandbox's
  // safe-delete shim, which shells out to a trash helper that cannot spawn here, so rmSync throws.
  // Keeping the previous run next to the new one is useful anyway.
  const stale = `${outDir}.old-${Date.now()}`;
  renameSync(outDir, stale);
  console.log(`已有目录改名保留: ${stale}`);
}
mkdirSync(outDir, { recursive: true });

// 1. upstream tree
const tarball = path.join(outDir, '.upstream.tar');
const arc = await gitRaw('archive', '--format=tar', '-o', tarball, ref);
if (arc.code !== 0) { console.error(`git archive 失败: ${arc.stderr.trim()}`); process.exit(2); }
try {
  // Run tar *inside* the output directory with a relative archive name. Passing `-C <absolute path>`
  // fails on Windows: GNU tar reads "E:/..." as host:path and stops with "Cannot connect to E:".
  await runAsync('tar', ['-xf', '.upstream.tar'], { cwd: outDir });
} catch (error) {
  console.error(`解包失败（需要 tar）: ${(error.stderr || error.message || '').trim()}`);
  process.exit(2);
}
try { rmSync(tarball, { force: true }); } catch { /* safe-delete shim refuses deletes here; scratch file */ }
console.log(`上游 ${ref} 已导出到 ${outDir}`);

// 2. everything of ours that upstream does not own: our modules, our tests, our build layer.
//    Also the files we patched, so a `follow` file we edited but upstream did not keeps our edit.
const wanted = new Set([...(manifest.owner || []), ...(manifest.patched || [])]);
const tracked = (await git('ls-files', '-z')).split('\0').filter(Boolean);
// Copy every file of ours that upstream does not have at all - BBleae's client modules and history
// screens predate anything we ever touched, so "did we change it" is the wrong test - plus anything
// we own or have patched. Without the first clause the export silently lost files such as
// public/js/screens/history.js, which nothing else copies.
const upstreamFiles = new Set((await git('ls-tree', '-r', '--name-only', ref)).split('\n').filter(Boolean));
const ours = tracked.filter((f) => !upstreamFiles.has(f) || wanted.has(f) || inList(policy.keep, f));
let copied = 0;
let copyBytes = 0;
const BATCH = 64;
for (let i = 0; i < ours.length; i += BATCH) {
  await Promise.all(ours.slice(i, i + BATCH).map(async (rel) => {
    const from = path.join(root, rel);
    if (!existsSync(from) || !statSync(from).isFile()) return;
    const to = path.join(outDir, rel);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied += 1;
    copyBytes += statSync(from).size;
  }));
}
console.log(`铺上我方文件 ${copied} 个（${(copyBytes / 1048576).toFixed(1)} MB）`);

const stats = { merged: [], conflicts: [], upstreamOnly: 0, missing: [] };

// 3. three-way merge for what upstream changed inside `follow`.
const changed = (await git('diff', '--name-only', BASE, ref)).split('\n').filter(Boolean);
const tmp = mkdtempSync(path.join(os.tmpdir(), 'sp-sync-base-'));
try {
  for (const rel of changed) {
    const kind = classify(rel);
    if (kind === 'keep') continue; // our copy was just laid down and wins outright
    if (kind === 'ignore') { if (!existsSync(path.join(root, rel))) stats.upstreamOnly += 1; continue; }
    const theirs = path.join(outDir, rel);
    const oursFile = path.join(root, rel); // read from the working tree, not the export
    if (!existsSync(theirs)) { stats.upstreamOnly += 1; continue; }
    if (!existsSync(oursFile)) { continue; } // upstream-only file inside a followed path: keep theirs
    const blob = await gitRaw('show', `${BASE}:${rel}`);
    if (blob.code !== 0) { stats.missing.push(`${rel}（基线无此文件，保留上游版本）`); continue; }
    const baseFile = path.join(tmp, 'base');
    writeFileSync(baseFile, blob.stdout);
    const result = await gitRaw('merge-file', '-p', '--diff3',
      '-L', 'ours(selfhost)', '-L', `base(${BASE.slice(0, 8)})`, '-L', 'theirs(upstream)',
      oursFile, baseFile, theirs);
    if (result.code > 0) {
      writeFileSync(theirs + '.conflict', result.stdout);
      stats.conflicts.push({ path: rel, hunks: result.code });
    } else if (result.code === 0) {
      writeFileSync(theirs, result.stdout);
      stats.merged.push(rel);
    } else {
      stats.missing.push(`${rel}（merge-file 出错: ${result.stderr.trim()}）`);
    }
  }
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* see above: harmless in the OS temp dir */ }
}

console.log('');
console.log(`基线              ${BASE.slice(0, 8)}（上游 ${ref} 相对它改了 ${changed.length} 个文件）`);
console.log(`follow 自动合并    ${stats.merged.length} 个`);
console.log(`follow 需人工      ${stats.conflicts.length} 个`);
console.log(`上游独有（未覆盖） ${stats.upstreamOnly} 个`);
for (const c of stats.conflicts) {
  console.log(`      ${c.path}  ${c.hunks} 处冲突  ->  ${path.join(outDir, c.path)}.conflict`);
}
if (stats.missing.length) {
  console.log(`\n需要人工确认 ${stats.missing.length} 项:`);
  for (const m of stats.missing) console.log(`      ${m}`);
}
console.log(`
下一步
  1. 手工解决上面 .conflict 里的冲突，把结果写回原文件名。
  2. 在 ${outDir} 构建并测试。RULES_VERSION 会变（上游动过 server/ shared/ data/），
     部署必须挑没有对局在进行的时候。
  3. 跑 npm run selfhost:check 确认 manifest 与现实仍然一致。`);
