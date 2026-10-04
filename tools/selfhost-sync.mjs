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
// Usage:
//   node tools/selfhost-sync.mjs                      # sgangss/master, into a temp dir
//   node tools/selfhost-sync.mjs v0.1.2 --out E:/sp-sync --fetch
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });
const gitOut = (...args) => {
  const out = run('git', args);
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr?.trim()}`);
  return out.stdout;
};
const gitOk = (...args) => run('git', args, { stdio: 'ignore' }).status === 0;

const manifest = JSON.parse(readFileSync(path.join(root, 'selfhost/manifest.json'), 'utf8'));
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const outIndex = argv.indexOf('--out');
const ref = argv.find((a) => !a.startsWith('--') && argv[outIndex + 1] !== a)
  || (manifest.upstream?.remote || 'sgangss') + '/master';

if (flags.has('--fetch')) {
  const remote = ref.split('/')[0];
  console.log(`fetch ${remote}...`);
  run('git', ['-c', 'http.sslVerify=false', 'fetch', remote]);
}
if (!gitOk('cat-file', '-e', ref)) { console.error(`找不到 ref: ${ref}`); process.exit(2); }
const BASE = manifest.upstreamBase?.commit;
if (!BASE || !gitOk('cat-file', '-e', BASE)) { console.error(`找不到合并基线: ${BASE}`); process.exit(2); }

const policy = manifest.policy || {};
const inList = (list, p) => (list || []).some((x) => p === x || p.startsWith(x));
// keep beats follow beats ignore: an upstream directory rule must never overwrite the Workers layer
// (server/match/ is followed, but server/match/checkpoint.js is ours).
const classify = (p) => (inList(policy.keep, p) ? 'keep' : inList(policy.follow, p) ? 'follow' : 'ignore');

const slug = ref.replace(/[^A-Za-z0-9._-]/g, '_');
const outDir = outIndex >= 0 ? path.resolve(argv[outIndex + 1]) : path.join(os.tmpdir(), 'sp-sync', slug);
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const tarball = path.join(outDir, '.upstream.tar');
const arc = run('git', ['archive', '--format=tar', '-o', tarball, ref]);
if (arc.status !== 0) { console.error(`git archive 失败: ${arc.stderr?.trim()}`); process.exit(2); }
const untar = run('tar', ['-xf', tarball, '-C', outDir]);
if (untar.status !== 0) { console.error(`解包失败（需要 tar）: ${untar.stderr?.trim()}`); process.exit(2); }
rmSync(tarball, { force: true });
console.log(`上游 ${ref} 已导出到 ${outDir}`);

const installOurs = (rel) => {
  const from = path.join(root, rel);
  if (!existsSync(from)) return false;
  const to = path.join(outDir, rel);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
  return true;
};

const stats = { kept: 0, merged: [], conflicts: [], upstreamOnly: 0, missing: [] };

// Only files upstream actually changed since the base are in scope; everything else is already right.
const changed = gitOut('diff', '--name-only', BASE, ref).split('\n').filter(Boolean);
const tmp = mkdtempSync(path.join(os.tmpdir(), 'sp-sync-base-'));
try {
  for (const rel of changed) {
    const kind = classify(rel);
    if (kind === 'keep' || kind === 'ignore') {
      // Both mean "our copy stays". Upstream-only files in an ignored path (a new upstream test, say)
      // are simply left in place - deleting them would be a guess, and they cost nothing.
      if (installOurs(rel)) stats.kept += 1;
      else stats.upstreamOnly += 1;
      continue;
    }
    const theirs = path.join(outDir, rel);
    const ours = path.join(root, rel);
    if (!existsSync(theirs)) { stats.upstreamOnly += 1; continue; }
    if (!existsSync(ours)) { stats.missing.push(rel); continue; }
    const blob = run('git', ['show', `${BASE}:${rel}`]);
    if (blob.status !== 0) { stats.missing.push(`${rel}（基线无此文件，保留上游版本）`); continue; }
    const baseFile = path.join(tmp, 'base');
    writeFileSync(baseFile, blob.stdout);
    const result = run('git', ['merge-file', '-p', '--diff3',
      '-L', 'ours(selfhost)', '-L', `base(${BASE.slice(0, 8)})`, '-L', 'theirs(upstream)',
      ours, baseFile, theirs]);
    if (result.status > 0) {
      writeFileSync(theirs + '.conflict', result.stdout);
      stats.conflicts.push({ path: rel, hunks: result.status });
    } else if (result.status === 0) {
      writeFileSync(theirs, result.stdout);
      stats.merged.push(rel);
    } else {
      stats.missing.push(`${rel}（merge-file 出错: ${result.stderr?.trim()}）`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log('');
console.log(`基线              ${BASE.slice(0, 8)}（上游 ${ref} 相对它改了 ${changed.length} 个文件）`);
console.log(`follow 自动合并    ${stats.merged.length} 个`);
console.log(`keep/ignore 保留   ${stats.kept} 个`);
console.log(`上游独有（未覆盖） ${stats.upstreamOnly} 个`);
console.log(`需人工冲突         ${stats.conflicts.length} 个`);
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
