// 基准测试执行体(经 esbuild 打包后在 Node 运行)。
import { loadNodeWasm } from './node-wasm';
import { runBenchmark, type BenchmarkResult } from './benchmark';
import type { BeeTraffic, Lighting, SyntheticConfig } from '../src/core/types';

const wasm = await loadNodeWasm();
console.log('WASM 编解码核心已加载\n');

// 多光照 × 蜂流量的代表性组合
const scenarios: { lighting: Lighting; traffic: BeeTraffic }[] = [
  { lighting: 'bright', traffic: 'normal' },
  { lighting: 'overcast', traffic: 'dense' },
  { lighting: 'dusk', traffic: 'sparse' },
];

// 功能正确性用较小分辨率快速验证;性能外推单独跑较大分辨率。
const results: BenchmarkResult[] = [];
for (const sc of scenarios) {
  const config: SyntheticConfig = {
    width: 320,
    height: 240,
    frames: 200, // 1 秒 @200fps
    fps: 200,
    lighting: sc.lighting,
    traffic: sc.traffic,
    seed: 42,
  };
  const r = runBenchmark(wasm, config, {
    fps: 200,
    gop: 25,
    // CBR 模式:两套方案同一码率上限,由码率控制自动对齐总字节。
    // 自适应版靠 P 帧背景跳过省下字节,把预算倾斜给蜜蜂块。
    targetBitrate: 6_000_000,
    baseQp: 12,
  });
  results.push(r);
  printResult(r);
}

console.log('\n========== 指标 1:同码率蜜蜂区 PSNR 增益(需 ≥ 4 dB)==========');
for (const r of results) {
  console.log(
    `${r.config.lighting}/${r.config.traffic}: 自适应 ${r.adaptive.beePsnr.toFixed(2)}dB vs ` +
      `均匀 ${r.uniform.beePsnr.toFixed(2)}dB → 增益 ${r.beePsnrGain.toFixed(2)}dB ` +
      `[${r.passed.psnrGain ? 'PASS' : 'FAIL'}]`,
  );
}
console.log('\n========== 指标:背景闪烁(平均帧间亮度差,需 < 1)==========');
for (const r of results) {
  console.log(
    `${r.config.lighting}/${r.config.traffic}: 闪烁=${r.backgroundFlicker.toFixed(3)} ` +
      `背景 PSNR=${r.adaptive.bgPsnr.toFixed(2)}dB [${r.passed.flicker ? 'PASS' : 'FAIL'}]`,
  );
}
console.log('\n========== 指标 2:seek 延迟(需 < 500ms)==========');
for (const r of results) {
  console.log(
    `${r.config.lighting}/${r.config.traffic}: 最大 ${r.seekMs.max.toFixed(1)}ms / ` +
      `平均 ${r.seekMs.mean.toFixed(1)}ms [${r.passed.seek ? 'PASS' : 'FAIL'}]`,
  );
}

const allPass = results.every((r) => r.passed.psnrGain && r.passed.seek && r.passed.flicker);
console.log(`\n总体:${allPass ? '全部 PASS ✅' : '存在 FAIL ❌'}`);
if (!allPass) process.exitCode = 1;

function printResult(r: BenchmarkResult): void {
  console.log(`\n--- ${r.config.lighting} / ${r.config.traffic} (${r.config.width}x${r.config.height}) ---`);
  console.log(
    `自适应: ${(r.adaptive.fileBytes / 1024).toFixed(1)}KB, ${(r.adaptive.bitrate / 1e6).toFixed(2)}Mbps, ` +
      `编码 ${r.adaptive.encodeMs.toFixed(0)}ms`,
  );
  console.log(
    `均匀对照 QP${r.uniform.qp}: ${(r.uniform.fileBytes / 1024).toFixed(1)}KB ` +
      `(字节差 ${Math.abs(r.uniform.fileBytes - r.adaptive.fileBytes)} B)`,
  );
}
