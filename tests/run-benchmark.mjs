// 基准测试入口:覆盖几种光照 × 蜂流量,输出指标并断言硬性需求。
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../.bench-build');
mkdirSync(outDir, { recursive: true });
const entry = resolve(here, 'benchmark-run.ts');
const outfile = resolve(outDir, 'benchmark-run.mjs');

process.env.HVC_WASM_PATH = resolve(here, '../public/wasm/hive_codec.wasm');

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'warning',
});

await import(pathToFileURL(outfile).href);
