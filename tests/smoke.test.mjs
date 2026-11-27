// Node 冒烟测试:经 esbuild 打包后用 node:test 验证 WASM 编解码 ABI 端到端可用。
// 覆盖:编码→解码往返、随机 seek、运动分析器与 TS 一致性、容器完整性。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../.test-build');
mkdirSync(outDir, { recursive: true });
const outfile = resolve(outDir, 'smoke.mjs');
process.env.HVC_WASM_PATH = resolve(here, '../public/wasm/hive_codec.wasm');

await build({
  entryPoints: [resolve(here, 'smoke-run.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'warning',
});

const mod = await import(pathToFileURL(outfile).href);

test('WASM 编码-解码往返与随机 seek', async () => {
  const r = await mod.smokeCodecRoundtrip();
  assert.ok(r.maxSeekMs < 500, `seek 应 <500ms,实际 ${r.maxSeekMs}`);
  assert.ok(r.frameCount >= 24);
  assert.ok(r.backgroundPsnr > 30, `背景 PSNR 应 >30dB,实际 ${r.backgroundPsnr}`);
});

test('WASM 运动分析器与 TS 实现一致率 ≥99%', async () => {
  const r = await mod.smokeAnalyzerParity();
  assert.ok(r.agreement >= 0.99, `一致率应 ≥99%,实际 ${r.agreement}`);
});
