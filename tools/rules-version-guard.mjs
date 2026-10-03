// Refuses to deploy a build whose rules version differs from what is already live.
//
// server/match/checkpoint.js requires checkpoint.rulesVersion === RULES_VERSION, and a fresh build no
// longer embeds historical engines, so a changed version means every match in progress becomes
// unrestorable the moment its Durable Object restarts. That is indistinguishable from kicking the
// players out, so the default is to stop. The rules hash also covers tools/build-worker.mjs, which makes
// a harmless build-script edit enough to change the version — all the more reason to check mechanically.
//
//   node tools/rules-version-guard.mjs check    # runs inside the deploy (see wrangler.jsonc build.command)
//   node tools/rules-version-guard.mjs record   # run after a deploy succeeds
//
// SP_ALLOW_RULES_CHANGE=1 overrides, for the case where no match is running.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE = join(ROOT, 'dist', 'worker', 'index.mjs');
const RECORD = join(ROOT, '.cache', 'deployed-rules-version');

async function buildVersion() {
  let source;
  try {
    source = await readFile(BUNDLE, 'utf8');
  } catch {
    throw new Error(`no build at ${BUNDLE} — run \`npm run build:worker\` first`);
  }
  // shared/rules-version.js after the esbuild define: RULES_VERSION = typeof "<id>" === 'string' ? ...
  const match = /RULES_VERSION\s*=\s*typeof\s*"([0-9a-f]{20})"/.exec(source) || /"([0-9a-f]{20})"/.exec(source);
  if (!match) throw new Error('could not read the rules version out of the build');
  return match[1];
}

async function record(version) {
  await mkdir(dirname(RECORD), { recursive: true });
  await writeFile(RECORD, version + '\n');
}

const mode = (process.argv[2] || 'check').toLowerCase();
const current = await buildVersion();

if (mode === 'record') {
  await record(current);
  console.log(`[rules] recorded ${current} as the deployed rules version`);
} else if (mode !== 'check') {
  console.error(`[rules] unknown mode "${mode}" (expected check or record)`);
  process.exit(2);
} else if (!existsSync(RECORD)) {
  await record(current);
  console.log(`[rules] no recorded version yet; recording ${current} and continuing`);
} else {
  const deployed = (await readFile(RECORD, 'utf8')).trim();
  if (deployed === current) {
    console.log(`[rules] rules version ${current} unchanged — safe to deploy while matches are running`);
  } else {
    console.error(
      `\n[rules] REFUSING TO DEPLOY: rules version changed ${deployed} -> ${current}.\n` +
      '  Every match in progress holds a checkpoint stamped with the old version, and this build does\n' +
      '  not embed the old engine, so those matches cannot be restored (checkpoint.js: CHECKPOINT_VERSION).\n' +
      '  Deploy when nobody is mid-match, then run `npm run rules:record`.\n' +
      '  If you are certain no match is running: SP_ALLOW_RULES_CHANGE=1 npm run deploy:worker\n');
    if (process.env.SP_ALLOW_RULES_CHANGE !== '1') process.exit(1);
    console.error('[rules] SP_ALLOW_RULES_CHANGE=1 set — continuing anyway\n');
    await record(current);
  }
}
