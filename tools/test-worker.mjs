#!/usr/bin/env node
// Run the worker test suite.
//
// The two flags are not optional. Without them the suite does not finish — the run used to be stopped
// by hand after 30 minutes — and `--test-timeout` *overrides* a test's own `{ timeout }` rather than
// taking the larger of the two, so it has to be at least as large as the biggest declared timeout in the
// suite (300000ms, in local-auth.test.js, which deliberately waits 125 s for a seat lease to lapse).
//
// The file list comes from the filesystem rather than the shell: `npm run` uses cmd.exe on Windows, which
// does not expand globs, and `node --test <directory>` is not accepted — Node treats the argument as a
// file and tries to require it.
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const optional = process.argv.slice(2).filter((name) => !name.startsWith('-'));
const flags = process.argv.slice(2).filter((name) => name.startsWith('-'));

const dir = path.join(root, 'test', 'worker');
const all = readdirSync(dir).filter((name) => name.endsWith('.test.js')).sort();
// Forward slashes on purpose. The runner treats each argument as a glob pattern, and on Windows a
// backslash is an escape character there — `path.join` produces `test\worker\x.test.js`, which matches
// nothing and is reported as `Could not find '<every basename, comma-joined>'`.
const relative = (name) => `test/worker/${name}`;
const files = optional.length ? optional.map(relative) : all.map(relative);
const args = ['--test', '--test-concurrency=4', '--test-timeout=300000', ...flags, ...files];

console.log(`${files.length} 个测试文件，参数: ${args.slice(0, 3).join(' ')}`);
const started = Date.now();
// spawn with inherited stdio, not execFile: execFile mangles a long argument list on Windows (the file
// list arrived at the runner as one comma-joined string) and it buffers output instead of streaming it.
const code = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', (status, signal) => resolve(signal ? 1 : status ?? 1));
});
console.log(`\n耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exitCode = code;

