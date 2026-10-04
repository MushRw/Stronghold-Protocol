#!/usr/bin/env node
// Check that selfhost/manifest.json still describes reality.
//
// Our repository and upstream have no common git ancestor, so a merge cannot tell us that our
// self-maintained files have drifted. This script is the replacement: it recomputes the boundary from
// the snapshot commit and fails when reality no longer matches what the manifest claims, which is the
// moment someone has to decide whether a file is still ours to own or has become an upstream file we
// now patch. Run it after touching server/, public/ or shared/, and after syncing upstream.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, 'selfhost/manifest.json'), 'utf8'));

const git = (...args) => {
  const out = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr?.trim()}`);
  return out.stdout;
};
const gitOk = (...args) => spawnSync('git', args, { cwd: root, stdio: 'ignore' }).status === 0;

const snapshot = manifest.snapshot?.commit;
if (!snapshot || !gitOk('cat-file', '-e', snapshot)) {
  console.error(`manifest.snapshot.commit 无效或不存在: ${snapshot}`);
  process.exit(2);
}
if (!gitOk('cat-file', '-e', 'upstream/master')) {
  console.error('找不到 upstream/master。先跑: git -c http.sslVerify=false fetch upstream');
  process.exit(2);
}

const upstreamFiles = new Set(git('ls-tree', '-r', '--name-only', 'upstream/master').split('\n').filter(Boolean));
const changed = git('diff', '--name-only', snapshot, 'HEAD').split('\n').filter(Boolean);
const owner = new Set(manifest.owner || []);
const patched = new Set(manifest.patched || []);
const hotspots = new Set(manifest.hotspots || []);

const problems = [];
const warnings = [];

// 1. Anything we changed that the manifest does not classify is a boundary that moved silently.
const unclassified = changed.filter((f) => !owner.has(f) && !patched.has(f));
if (unclassified.length) {
  problems.push(`未登记改动 ${unclassified.length} 个（改了就要分类，否则同步时会漏掉）:\n` +
    unclassified.map((f) => `      ${f}`).join('\n'));
}

// 2. An "owner" file that upstream also has means upstream added a file of the same name. It is no
//    longer purely ours: our copy will silently overwrite theirs on the next sync.
const collides = (manifest.owner || []).filter((f) => upstreamFiles.has(f));
if (collides.length) {
  problems.push(`owner 里的文件上游已存在 ${collides.length} 个（需重新分类为 patched）:\n` +
    collides.map((f) => `      ${f}`).join('\n'));
}

// 3. A "patched" file upstream deleted cannot be patched any more.
const gone = (manifest.patched || []).filter((f) => !upstreamFiles.has(f));
if (gone.length) {
  problems.push(`patched 里的文件上游已删除 ${gone.length} 个（上游已移除该文件）:\n` +
    gone.map((f) => `      ${f}`).join('\n'));
}

// 4. Hotspots are the files both sides edit. Report when upstream last touched each one, so a sync
//    starts from the real conflict list instead of from a guess.
const hotspotLines = [...hotspots].map((f) => {
  const last = git('log', '-1', '--format=%h %ad %s', '--date=short', 'upstream/master', '--', f).trim();
  return `      ${f}\n        ${last ? last.slice(0, 110) : '(上游从未改动)'}`;
});

const upstreamHead = git('log', '-1', '--format=%h %ad %s', '--date=short', 'upstream/master').trim();
console.log('selfhost 边界校验');
console.log(`  上游 HEAD      ${upstreamHead.slice(0, 100)}`);
console.log(`  快照           ${snapshot.slice(0, 8)}`);
console.log(`  改动文件       ${changed.length} 个（owner ${owner.size} / patched ${patched.size}）`);
console.log(`  热点文件       ${hotspots.size} 个（双方都在改，同步时优先人工核对）`);
console.log('');
for (const line of hotspotLines) console.log(`    ${line}`);
console.log('');

if (warnings.length) { console.log('警告:'); for (const w of warnings) console.log(`  ⚠ ${w}`); console.log(''); }
if (problems.length) {
  console.log('问题:');
  for (const p of problems) console.log(`  ✗ ${p}`);
  console.log('\n按上面的提示更新 selfhost/manifest.json（或把"我们的文件"收进 owner、把改上游的收进 patched）。');
  process.exit(1);
}
console.log('✓ 清单与现实一致。');
