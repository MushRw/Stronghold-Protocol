#!/usr/bin/env node
// Lay this project's self-hosted layer over an upstream revision, so syncing upstream stops being an
// archaeology exercise.
//
// Why this exists: our history and upstream's share no ancestor (0 common commits), so `git merge` is
// meaningless here and "N commits behind" is a false number. What actually differs is small and
// enumerable — selfhost/manifest.json lists it:
//
//   owner/    files that exist only here. Syncing = copying them over upstream's tree, verbatim.
//   patched/  upstream files we edited. Syncing = re-applying our edit onto upstream's copy.
//
// For patched files the script runs a three-way merge using our snapshot commit as the base. When
// upstream never touched the file, base and theirs are identical and our edit applies cleanly; when
// upstream did touch it, you get a conflict to resolve by hand. That is why the manifest separates
// `hotspots`: after a sync, only the hotspot conflicts need real thought.
//
// Usage:
//   node tools/selfhost-sync.mjs                      # against upstream/master, into a temp dir
//   node tools/selfhost-sync.mjs v0.1.2               # against a tag
//   node tools/selfhost-sync.mjs upstream/master --out E:/sp-sync --fetch
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const outIndex = argv.indexOf('--out');
const ref = argv.find((a) => !a.startsWith('--') && argv[outIndex + 1] !== a) || 'upstream/master';

const run = (cmd, args, opts = {}) => {
  const out = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });
  return out;
};
const gitOut = (...args) => {
  const out = run('git', args);
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr?.trim()}`);
  return out.stdout;
};
const gitOk = (...args) => run('git', args, { stdio: 'ignore' }).status === 0;

if (flags.has('--fetch')) {
  console.log('fetch upstream…');
  run('git', ['-c', 'http.sslVerify=false', 'fetch', 'upstream']);
}
if (!gitOk('cat-file', '-e', ref)) {
  console.error(`找不到 ref: ${ref}。先跑 node tools/selfhost-sync.mjs --fetch`);
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(path.join(root, 'selfhost/manifest.json'), 'utf8'));
const snapshot = manifest.snapshot?.commit;
if (!snapshot || !gitOk('cat-file', '-e', snapshot)) {
  console.error(`manifest.snapshot.commit 无效: ${snapshot}`);
  process.exit(2);
}

const slug = ref.replace(/[^A-Za-z0-9._-]/g, '_');
const outDir = outIndex >= 0 ? path.resolve(argv[outIndex + 1]) : path.join(os.tmpdir(), 'sp-sync', slug);
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Export upstream's tree. `git archive` keeps this repository's own state untouched, unlike a worktree.
const tarball = path.join(outDir, '.upstream.tar');
const arc = run('git', ['archive', '--format=tar', '-o', tarball, ref]);
if (arc.status !== 0) { console.error(`git archive 失败: ${arc.stderr?.trim()}`); process.exit(2); }
const untar = run('tar', ['-xf', tarball, '-C', outDir]);
if (untar.status !== 0) { console.error(`解包失败（需要 tar）: ${untar.stderr?.trim()}`); process.exit(2); }
rmSync(tarball, { force: true });
console.log(`上游 ${ref} 已导出到 ${outDir}`);

const report = { copied: 0, merged: [], conflicts: [], missing: [] };

// owner: purely ours, so just install the file. Includes binaries (replay-versions/*.gz).
for (const rel of manifest.owner || []) {
  const from = path.join(root, rel);
  if (!existsSync(from)) { report.missing.push(rel); continue; }
  const to = path.join(outDir, rel);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
  report.copied += 1;
}

// patched: replay our edit on top of upstream's copy with our snapshot as the merge base.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'sp-sync-base-'));
try {
  for (const rel of manifest.patched || []) {
    const theirs = path.join(outDir, rel);
    const ours = path.join(root, rel);
    if (!existsSync(theirs)) { report.missing.push(`(上游已无此文件) ${rel}`); continue; }
    if (!existsSync(ours)) { report.missing.push(rel); continue; }
    const base = path.join(tmp, 'base');
    const baseBlob = run('git', ['show', `${snapshot}:${rel}`]);
    if (baseBlob.status !== 0) { report.missing.push(`(快照里没有) ${rel}`); continue; }
    writeFileSync(base, baseBlob.stdout);

    const result = run('git', ['merge-file', '-p', '--diff3',
      '-L', 'ours(selfhost)', '-L', `base(${snapshot.slice(0, 8)})`, '-L', 'theirs(upstream)',
      ours, base, theirs]);
    // Exit status is the number of conflicts (0 = clean, negative/>=128 = error).
    const conflicts = result.status;
    if (conflicts > 0) {
      writeFileSync(theirs + '.conflict', result.stdout);
      report.conflicts.push({ path: rel, hunks: conflicts });
    } else if (conflicts === 0) {
      writeFileSync(theirs, result.stdout);
      report.merged.push(rel);
    } else {
      report.missing.push(`${rel} (merge-file 出错: ${result.stderr?.trim()})`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const hotspots = new Set(manifest.hotspots || []);
console.log('');
console.log(`owner 复制      ${report.copied} 个文件`);
console.log(`patched 自动合并  ${report.merged.length} 个`);
console.log(`patched 有冲突    ${report.conflicts.length} 个`);
if (report.conflicts.length) {
  for (const c of report.conflicts) {
    const hot = hotspots.has(c.path) ? '  ← 热点（预期）' : '  ← 上游也改过，需人工看';
    console.log(`      ${c.path}  ${c.hunks} 处冲突${hot}`);
    console.log(`        ours(selfhost) / base / theirs(upstream) 三方标记写在: ${path.join(outDir, c.path)}.conflict`);
  }
}
if (report.missing.length) {
  console.log(`\n需要人工确认 ${report.missing.length} 项:`);
  for (const m of report.missing) console.log(`      ${m}`);
}

console.log(`
下一步
  1. 处理上面的冲突：打开对应的 .conflict 文件（已含 ours/base/theirs 三方标记），把结果写回原文件名。
  2. 在 ${outDir} 里构建并测试。注意这一步会改动 RULES_VERSION（上游动过 server/ shared/ data/），
     所以部署必须挑没有对局在进行的时候——先用 DO 请求速率确认。
  3. 对照 selfhost/manifest.json 复查：有没有新文件该进 owner、有没有文件上游新增后该改成 patched
     （届时 git merge 不存在，这一步只能靠人）。`);
