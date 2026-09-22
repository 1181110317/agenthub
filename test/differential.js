// 差分测试（外壳）：把上游 t3code 的原始 TS 源码与我们的移植版逐条比对。
// 原版 .ts 需要 --experimental-strip-types（Node ≥22.6）；本文件用一行 plain node
// 运行，内部再决定：找不到上游源码 → SKIP；Node 不支持该 flag → SKIP；否则透传结果。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UPSTREAM = process.env.AGENTHUB_T3CODE_DIR || path.join(ROOT, '..', '_ref', 't3code');
const needed = [
  path.join(UPSTREAM, 'packages', 'shared', 'src', 'searchRanking.ts'),
  path.join(UPSTREAM, 'apps', 'web', 'src', 'lib', 'imageCompression.ts'),
];

if (!needed.every(f => fs.existsSync(f))) {
  console.log('[differential] skipped：未找到上游 t3code 源码（设置 AGENTHUB_T3CODE_DIR 可指定）');
  process.exit(0);
}

const inner = path.join(__dirname, 'differential-inner.mjs');
const probe = spawnSync(process.execPath, ['--experimental-strip-types', '-e', 'process.exit(0)'], { encoding: 'utf8' });
if (probe.status !== 0 && /bad option|not allowed|Unknown option/i.test(String(probe.stderr || ''))) {
  console.log('[differential] skipped：当前 Node 不支持 --experimental-strip-types');
  process.exit(0);
}

const run = spawnSync(process.execPath, ['--experimental-strip-types', inner], {
  stdio: 'inherit',
  env: { ...process.env, AGENTHUB_T3CODE_DIR: UPSTREAM },
});
process.exit(run.status == null ? 1 : run.status);
