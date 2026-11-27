// 验证 WorkerPool(worker_threads 适配)分块分析可端到端工作
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerPool } from '../src/core/worker-pool.ts';
import { SynthVideo } from '../src/core/synth.ts';
import { DEFAULT_ANALYZE } from '../src/core/types.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wasmBytes = new Uint8Array(readFileSync(resolve(root, 'public/wasm/hive_codec.wasm')));

const w = 128; const h = 96;
const video = new SynthVideo({ width: w, height: h, fps: 50, frames: 4, light: 'clouds', traffic: 'high', seed: 1 });

// 构造背景(帧0)与当前帧(帧2)的 YUV 平面(复用 WASM 主线程实例)
const { instantiateWasm, WasmCodec } = await import('../src/core/codec-wasm.ts');
const wasm = await instantiateWasm(wasmBytes);
const main = new WasmCodec(wasm, w, h);
main.rgbaToYuv(video.renderFrame(0).rgba);
const bgY = main.u8(main.curY, w * h * 2).slice();
const bgU = main.u8(main.curU, (w / 2) * (h / 2) * 2).slice();
const bgV = main.u8(main.curV, (w / 2) * (h / 2) * 2).slice();
main.rgbaToYuv(video.renderFrame(2).rgba);
const curY = main.u8(main.curY, w * h * 2).slice();
const curU = main.u8(main.curU, (w / 2) * (h / 2) * 2).slice();
const curV = main.u8(main.curV, (w / 2) * (h / 2) * 2).slice();

const pool = await WorkerPool.create(wasmBytes, 2);
const nbRows = h / 8;
const half = nbRows / 2;
const tasks = [0, 1].map((k) => ({
  kind: 'analyze' as const,
  width: w, height: h,
  rowStart: k * half, rowEnd: (k + 1) * half,
  bgY: bgY.buffer, curY: curY.buffer, curU: curU.buffer, curV: curV.buffer,
  params: DEFAULT_ANALYZE,
}));
const t0 = performance.now();
const results = await Promise.all(tasks.map((t) => pool.submitAnalyze(t)));
const ms = performance.now() - t0;
const merged = new Uint8Array((w / 8) * (h / 8));
results.sort((a, b) => a.rowStart - b.rowStart).forEach((r) => {
  merged.set(new Uint8Array(r.classes), r.rowStart * (w / 8));
});
const counts = [0, 0, 0, 0];
for (const c of merged) counts[c]++;
console.log('Worker 分块分析完成, 耗时', ms.toFixed(1), 'ms, 块分类计数', counts);
pool.terminate();
if (counts.slice(1).reduce((a, b) => a + b, 0) === 0) {
  console.error('FAIL: 未检测到任何活动块');
  process.exit(1);
}
console.log('PASS: Worker 池分块运动分析正常');
