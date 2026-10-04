// Worker-specific patches, re-applied to an upstream export after the three-way merge.
//
// Upstream publishes a plain Node server. A few of its choices are not just different but actively wrong
// for a Durable Object, and keeping our whole file is not an option either, because upstream's own changes
// to those files do matter. So they are re-applied as patches.
//
// Each patch checks a condition that proves it is already in place before touching anything, and a patch
// that can neither find its anchor nor prove itself applied is reported as `failed` rather than skipped
// silently - a missed patch here means a Worker that never hibernates, which costs duration and blocks
// eviction on every deploy.
//
// Verified against sgangss/master (2026-10-04): without the net.js guard, miniflare cannot evict the room
// object ("still has active references") and two lobby/hibernation tests fail.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const AUTO_TIMERS_COMMENT = 'Workers use platform alarms instead of keeping an idle object awake';

export const WORKER_PATCHES = [
  {
    id: 'net.autoTimers-default',
    file: 'server/net.js',
    why: 'NET_DEFAULTS must carry the autoTimers switch the room runtime sets to false',
    done: (text) => /autoTimers:\s*true/.test(text),
    apply: (text) => text.replace(
      /const NET_DEFAULTS = Object\.freeze\(\{/,
      `const NET_DEFAULTS = Object.freeze({\n  autoTimers: true,             // ${AUTO_TIMERS_COMMENT}`,
    ),
  },
  {
    id: 'net.autoTimers-guard',
    file: 'server/net.js',
    why: 'the heartbeat/sweep intervals must be skipped when the platform owns the schedule',
    done: (text) => /if \(this\.opts\.autoTimers\)/.test(text),
    apply: (text) => text.replace(
      /^( *)this\.heartbeatTimer = setInterval\(\(\) => this\.heartbeat\(\), this\.opts\.heartbeatMs\);\n( *)this\.heartbeatTimer\.unref\?\.\(\);\n( *)const sweepMs = ([^\n]*)\n( *)this\.sweepTimer = setInterval\(\(\) => this\.sweep\(\), sweepMs\);\n( *)this\.sweepTimer\.unref\?\.\(\);/m,
      (match, i1, i2, i3, sweep, i5, i6) => [
        `${i1}if (this.opts.autoTimers) {`,
        `${i1}  this.heartbeatTimer = setInterval(() => this.heartbeat(), this.opts.heartbeatMs);`,
        `${i1}  this.heartbeatTimer.unref?.();`,
        `${i3}  const sweepMs = ${sweep}`,
        `${i1}  this.sweepTimer = setInterval(() => this.sweep(), sweepMs);`,
        `${i1}  this.sweepTimer.unref?.();`,
        `${i1}}`,
      ].join('\n'),
    ),
  },
];

/**
 * Apply every patch to an exported upstream tree.
 * @param {string} outDir export directory (mutated in place)
 * @returns {{results: {id: string, status: string}[], failed: {id: string, status: string, why: string}[]}}
 */
export function applyWorkerPatches(outDir) {
  const results = [];
  for (const patch of WORKER_PATCHES) {
    const file = path.join(outDir, patch.file);
    let text;
    try { text = readFileSync(file, 'utf8'); }
    catch { results.push({ id: patch.id, status: 'missing', why: patch.why }); continue; }
    if (patch.done(text)) { results.push({ id: patch.id, status: 'already' }); continue; }
    const next = patch.apply(text);
    if (next === text) { results.push({ id: patch.id, status: 'failed', why: patch.why }); continue; }
    writeFileSync(file, next);
    results.push({ id: patch.id, status: 'applied' });
  }
  return { results, failed: results.filter((r) => r.status === 'failed' || r.status === 'missing') };
}
