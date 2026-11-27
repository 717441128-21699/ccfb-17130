// 性能基准:验证编码速度满足"1080p/200fps 一分钟录像压缩 < 3 分钟"。
// 直接在 Node 实例化 wasm,用合成 1080p 序列测实际编码吞吐,再外推到
// 一分钟(12000 帧)的总耗时。解码侧验证任意秒级 seek < 0.5s。

import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../.bench-build');
mkdirSync(outDir, { recursive: true });
const outfile = resolve(outDir, 'perf-run.mjs');
await build({
  entryPoints: [resolve(here, 'perf-run.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'warning',
});
process.env.HVC_WASM_PATH = resolve(here, '../public/wasm/hive_codec.wasm');
await import(pathToFileURL(outfile).href);
