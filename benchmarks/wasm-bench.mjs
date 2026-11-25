// End-to-end WASM smoke + throughput probe (no browser required).
// Usage: npm run bench:wasm
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = resolve(root, 'src/wasm/hive_codec.wasm');
const bytes = readFileSync(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes, {});
const ex = instance.exports;

if (ex.hc_ping() !== 0x48433130) throw new Error('ping mismatch');
const mem = () => new Uint8Array(ex.memory.buffer);

function writeString(str) {
  const enc = new TextEncoder().encode(str);
  const ptr = ex.hc_alloc(enc.length);
  mem().set(enc, ptr);
  return { ptr, len: enc.length };
}
function jsonFrom(lastLenFn, ptrFn) {
  const n = ex[lastLenFn]();
  const p = ex[ptrFn]();
  return JSON.parse(Buffer.from(ex.memory.buffer, p, n).toString('utf8'));
}

// 1) Full objective matrix at a small size.
{
  const s = writeString('w=640;h=360;frames=2;warmup=6;q=46');
  ex.hc_benchmark(s.ptr, s.len);
  const report = jsonFrom('hc_json_len', 'hc_json_ptr');
  console.log(`[benchmark] presets=${report.presets.length} min=${report.min_delta_bee_db?.toFixed?.(2)} pass=${report.pass_4db}`);
}

// 2) hc_process_frame marshalling with a synthetic RGBA + weights + mask.
{
  const W = 320, H = 180, npx = W * H;
  const rgba = new Uint8Array(npx * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const wood = 120 + 30 * Math.sin(y * 0.4) + ((x * 13 + y * 7) % 17);
    rgba[i] = wood + 30; rgba[i + 1] = wood * 0.72; rgba[i + 2] = wood * 0.45; rgba[i + 3] = 255;
  }
  // A bright "bee/pollen" blob.
  for (let y = 60; y < 110; y++) for (let x = 120; x < 190; x++) {
    const i = (y * W + x) * 4; rgba[i] = 245; rgba[i + 1] = 190; rgba[i + 2] = 30;
  }
  const mask = new Uint8Array(npx);
  for (let y = 56; y < 114; y++) for (let x = 116; x < 194; x++) mask[y * W + x] = 255;

  const gw = Math.ceil(W / 16), gh = Math.ceil(H / 16), nW = gw * gh;
  const rgbaPtr = ex.hc_alloc(rgba.length); mem().set(rgba, rgbaPtr);
  const maskPtr = ex.hc_alloc(npx); mem().set(mask, maskPtr);
  const wPtr = ex.hc_alloc(nW * 4);
  const f32 = new Float32Array(ex.memory.buffer, wPtr, nW);
  f32.fill(0.3);
  for (let by = 3; by < 7; by++) for (let bx = 7; bx < 12; bx++) f32[by * gw + bx] = 5;

  const status = ex.hc_process_frame(rgbaPtr, maskPtr, W, H, 46, wPtr, nW);
  if (status !== 0) throw new Error('hc_process_frame status ' + status);
  const stats = jsonFrom('hc_json_len', 'hc_json_ptr');
  console.log('[process] status=0 stats=', {
    uniformBytes: stats.uniformBytes, roiBytes: stats.roiBytes,
    delta: stats.deltaBeeDb?.toFixed?.(2), beeRoi: stats.beeRoiPsnr?.toFixed?.(2),
  });
  ex.hc_dealloc(rgbaPtr, rgba.length); ex.hc_dealloc(maskPtr, npx); ex.hc_dealloc(wPtr, nW * 4);
}

// 3) Throughput probe (WASM, single thread).
function runThroughput(spec, frames) {
  const s = writeString(spec);
  const t0 = performance.now();
  ex.hc_throughput(s.ptr, s.len);
  const wallMs = performance.now() - t0;
  const report = jsonFrom('hc_json_len', 'hc_json_ptr');
  ex.hc_dealloc(s.ptr, s.len);
  return { ...report, wallMs, msPerFrame: wallMs / frames };
}

const FRAMES = 120;
const probe = runThroughput(`w=1920;h=1080;q=60;frames=${FRAMES}`, FRAMES);
const projectedSec = probe.msPerFrame * 12000 / 1000;
const result = {
  runtime: 'wasm32-unknown-unknown / node',
  ...probe,
  projected_single_worker_60s_200fps_seconds: Math.round(projectedSec),
  projected_8_worker_pool_seconds: Math.round(projectedSec / 8),
  seek_decode_target_ms: 500,
};
mkdirSync(resolve(root, 'benchmarks/results'), { recursive: true });
writeFileSync(resolve(root, 'benchmarks/results/wasm-speed.json'), JSON.stringify(result, null, 2));
console.log('[throughput]', {
  frames: probe.frames, wallMs: Math.round(probe.wallMs),
  msPerFrame: probe.msPerFrame.toFixed(2),
  singleWorkerMin: (projectedSec / 60).toFixed(1),
  eightWorkerSec: Math.round(projectedSec / 8),
});
