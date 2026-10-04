#!/usr/bin/env node
// Check that selfhost/manifest.json still describes reality.
//
// Our repository and upstream have no common git ancestor, so a merge cannot tell us that our
// self-maintained files have drifted. This script is the replacement: it recomputes the boundary from
// the snapshot commit and fails when reality no longer matches what the manifest claims, which is the
// moment someone has to decide whether a file is still ours to own or has become an upstream file we
// now patch. Run it after touching server/, public/ or shared/, and after syncing upstream.
//
// Every git call is async (execFile) rather than spawnSync on purpose: spawnSync fails with EBUSY
// inside this project's tool sandbox - the async path works in the sandbox and on a normal terminal,
// so async is the only form that can be run from both. Same reason tools/build-worker.mjs reads the
// commit from .git instead of shelling out.
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const OPTS = { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };

const git = async (...args) => (await execFileAsync('git', args, OPTS)).stdout;
const gitOk = async (...args) => {
  try { await execFileAsync('git', args, OPTS); return true; } catch { return false; }
};

const manifest = JSON.parse(readFileSync(path.join(root, 'selfhost/manifest.json'), 'utf8'));
// Declared before first use - the previous revision referenced it three lines early, which threw
// "Cannot access 'UPSTREAM_REF' before initialization" on every machine.
const UPSTREAM_REF = (manifest.upstream?.remote || 'sgangss') + '/master';
const snapshot = manifest.snapshot?.commit;

if (!snapshot || !(await gitOk('cat-file', '-e', snapshot))) {
  console.error(`manifest.snapshot.commit 无效或不存在: ${snapshot}`);
  process.exit(2);
}
if (!(await gitOk('cat-file', '-e', UPSTREAM_REF))) {
  console.error(`找不到上游 ref ${UPSTREAM_REF}。先跑: git -c http.sslVerify=false fetch ${UPSTREAM_REF.split('/')[0]}`);
  process.exit(2);
}

const upstreamFiles = new Set((await git('ls-tree', '-r', '--name-only', UPSTREAM_REF)).split('\n').filter(Boolean));
const changed = (await git('diff', '--name-only', snapshot, 'HEAD')).split('\n').filter(Boolean);
const owner = new Set(manifest.owner || []);
const patched = new Set(manifest.patched || []);
const hotspots = [...new Set(manifest.hotspots || [])];

const problems = [];

// 1. Anything we changed that the manifest does not classify is a boundary that moved silently.
const unclassified = changed.filter((f) => !owner.has(f) && !patched.has(f));
if (unclassified.length) {
  problems.push(`未登记改动 ${unclassified.length} 个（改了就要分类，否则同步时会漏掉）:\n` +
    unclassified.map((f) => `      ${f}`).join('\n'));
}

// 2. An "owner" file that upstream also has means upstream added a file of the same name. It is no
//    longer purely ours: our copy will silently overwrite theirs on the next sync.
const collides = [...owner].filter((f) => upstreamFiles.has(f));
if (collides.length) {
  problems.push(`owner 里的文件上游已存在 ${collides.length} 个（需重新分类为 patched）:\n` +
    collides.map((f) => `      ${f}`).join('\n'));
}

// 3. A "patched" file upstream deleted cannot be patched any more.
const gone = [...patched].filter((f) => !upstreamFiles.has(f));
if (gone.length) {
  problems.push(`patched 里的文件上游已删除 ${gone.length} 个（上游已移除该文件）:\n` +
    gone.map((f) => `      ${f}`).join('\n'));
}

// 4. Hotspots are the files both sides edit. Report when upstream last touched each one, so a sync
//    starts from the real conflict list instead of from a guess.
const hotspotLines = await Promise.all(hotspots.map(async (f) => {
  const last = (await git('log', '-1', '--format=%h %ad %s', '--date=short', UPSTREAM_REF, '--', f)).trim();
  return `      ${f}\n        ${last ? last.slice(0, 110) : '(上游从未改动)'}`;
}));

const upstreamHead = (await git('log', '-1', '--format=%h %ad %s', '--date=short', UPSTREAM_REF)).trim();
console.log('selfhost 边界校验');
console.log(`  上游 HEAD      ${upstreamHead.slice(0, 100)}`);
console.log(`  快照           ${snapshot.slice(0, 8)}`);
console.log(`  改动文件       ${changed.length} 个（owner ${owner.size} / patched ${patched.size}）`);
console.log(`  热点文件       ${hotspots.length} 个（双方都在改，同步时优先人工核对）`);
console.log('');
for (const line of hotspotLines) console.log(`    ${line}`);
console.log('');

if (problems.length) {
  console.log('问题:');
  for (const p of problems) console.log(`  ✗ ${p}`);
  console.log('\n按上面的提示更新 selfhost/manifest.json（或把"我们的文件"收进 owner、把改上游的收进 patched）。');
  process.exit(1);
}
console.log('✓ 清单与现实一致。');
