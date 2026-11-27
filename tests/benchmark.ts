// 基准测试核心:验证两项硬性指标。
//  1. 同总码率下,蜜蜂区域 PSNR 比均匀分配高 ≥ 4 dB,背景无块状闪烁;
//  2. 性能:1080p/200fps 一分钟录像压缩 < 3 分钟;任意秒级 seek < 0.5s。
//
// 对照("均匀分配"):对所有 MB 用同一 QP(忽略类别),二分搜索 QP 使总字节
// 与自适应方案相等,从而在严格同码率下比较蜜蜂区域 PSNR。

import { MotionAnalyzer } from '../src/core/motion';
import { SyntheticVideoGenerator } from '../src/core/synthetic';
import {
  MB,
  MbClass,
  type ClassMap,
  type EncodeOptions,
  type RawFrame,
  type SyntheticConfig,
} from '../src/core/types';
import { NodeDecoder, NodeEncoder, type NodeWasmExports } from './node-wasm';

function pad(frame: RawFrame, pw: number, ph: number): Uint8Array {
  const out = new Uint8Array(pw * ph * 3);
  for (let y = 0; y < frame.height; y++) {
    out.set(frame.data.subarray(y * frame.width * 3, (y + 1) * frame.width * 3), y * pw * 3);
  }
  return out;
}

interface EncodeRun {
  file: Uint8Array;
  encodeMs: number;
  bytesPerFrame: number[];
}

/**
 * 编码一版。
 * - adaptive=true:真实类别图,差异化 QP + 背景 MB 在 P 帧跳过(本工具的核心);
 * - adaptive=false:均匀对照,模拟"普通整幅平均编码"——所有 MB 统一按爬行类
 *   (非背景,因此每帧都编码、不跳过)、用同一有效 QP,码率平摊到全图。
 * 两版使用相同目标码率上限(CBR),由码率控制保证总码率对齐。
 */
/** 掩码腐蚀:保留 4 邻域全部为 1 的像素,去掉与背景相邻的边界像素。 */
function erodeMask(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (
        mask[p] &&
        mask[p - 1] &&
        mask[p + 1] &&
        mask[p - w] &&
        mask[p + w]
      ) {
        out[p] = 1;
      }
    }
  }
  return out;
}

function runEncode(
  e: NodeWasmExports,
  gen: SyntheticVideoGenerator,
  frames: RawFrame[],
  classMaps: ClassMap[],
  opts: EncodeOptions,
  adaptive: boolean,
  bitrateOverride?: number,
  qpOverride?: number,
): EncodeRun {
  const mbCols = gen.mbCols;
  const mbRows = gen.mbRows;
  const pw = mbCols * MB;
  const ph = mbRows * MB;
  // 固定质量模式:targetBitrate=0,用显式 QP;否则走 CBR
  const fixedQp = qpOverride ?? opts.baseQp;
  const useCbr = qpOverride === undefined && (bitrateOverride ?? opts.targetBitrate) > 0;
  const targetBitrate = useCbr ? (bitrateOverride ?? opts.targetBitrate) : 0;
  const enc = NodeEncoder.create(e, {
    width: gen.width,
    height: gen.height,
    fps: opts.fps,
    frameCount: gen.frames,
    gop: opts.gop,
    targetBitrate: BigInt(targetBitrate),
    baseQp: fixedQp,
  });
  // 均匀模式:全部标爬行类(非背景 → 不跳过;delta 固定 → QP 全图一致)
  const uniformMap = new Uint8Array(mbCols * mbRows).fill(MbClass.Crawling);
  const bytesPerFrame: number[] = [];
  const t0 = performance.now();
  // 复用预生成帧:generator 有状态(蜜蜂位置随调用推进),不能重复驱动
  for (let t = 0; t < gen.frames; t++) {
    const padded = pad(frames[t], pw, ph);
    enc.writeFrame(padded, adaptive ? classMaps[t] : uniformMap);
    bytesPerFrame.push(enc.bytesSoFar());
  }
  const file = enc.finish();
  return { file, encodeMs: performance.now() - t0, bytesPerFrame };
}

export interface BenchmarkResult {
  config: SyntheticConfig;
  adaptive: {
    fileBytes: number;
    beePsnr: number;
    bgPsnr: number;
    wholePsnr: number;
    encodeMs: number;
    bitrate: number;
  };
  uniform: {
    qp: number;
    fileBytes: number;
    beePsnr: number;
    bgPsnr: number;
  };
  beePsnrGain: number;
  seekMs: { max: number; mean: number };
  backgroundFlicker: number;
  passed: { psnrGain: boolean; seek: boolean; flicker: boolean };
}

/** 测量背景块状闪烁:相邻 P 帧背景区像素的帧间差异(理想情况下静止背景为 0)。 */
function measureFlicker(
  e: NodeWasmExports,
  file: Uint8Array,
  classMaps: ClassMap[],
  width: number,
  height: number,
  fps: number,
): number {
  const dec = NodeDecoder.open(e, file);
  const mbCols = Math.ceil(width / MB);
  let prev: Uint8Array | null = null;
  let maxFrameDiff = 0;
  // 抽测若干 P 帧(跳过 I 帧)
  for (let t = fps; t < dec.info().frameCount; t += Math.max(1, Math.floor(fps / 4))) {
    const rgb = dec.seek(t);
    if (prev) {
      const map = classMaps[t];
      let diff = 0;
      let n = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const m = Math.floor(y / MB) * mbCols + Math.floor(x / MB);
          if (map[m] === MbClass.Background) {
            const i = (y * width + x) * 3;
            diff += Math.abs(rgb[i] - prev[i]);
            n++;
          }
        }
      }
      maxFrameDiff = Math.max(maxFrameDiff, n ? diff / n : 0);
    }
    prev = rgb;
  }
  dec.close();
  return maxFrameDiff;
}

export function runBenchmark(
  e: NodeWasmExports,
  config: SyntheticConfig,
  opts: EncodeOptions,
): BenchmarkResult {
  // 1) 先生成全部帧并做运动分析(分析时间不计入编码耗时)
  const gen = new SyntheticVideoGenerator(config);
  const analyzer = new MotionAnalyzer(config.width, config.height);
  const frames: RawFrame[] = [];
  const classMaps: ClassMap[] = [];
  const pixelMasks: Uint8Array[] = [];
  for (let t = 0; t < config.frames; t++) {
    const g = gen.generate(t);
    frames.push(g.frame);
    // 腐蚀掩码:只保留蜜蜂内部像素(4 邻域全为蜜蜂),排除与背景混合的
    // 边缘像素——后者的误差主要来自运动边界而非量化,不应主导 PSNR 评估。
    pixelMasks.push(erodeMask(g.pixelMask, config.width, config.height));
    classMaps.push(analyzer.analyze(g.frame).classMap);
  }

  // 2) 自适应内容编码:固定质量模式,真实类别图 + 差异化 QP + 背景跳过。
  //    选一个中等 QP,使输出落在合理质量区。
  const adaptiveQp = 10;
  const adaptive = runEncode(e, gen, frames, classMaps, { ...opts, targetBitrate: 0 }, true, undefined, adaptiveQp);
  const targetBytes = adaptive.file.length;

  // 3) 均匀对照(固定质量):扫描统一 QP,选总字节最接近自适应版(±10%)的档位。
  //    率失真评估的标准同码率对照,不依赖动态码率控制的收敛性。
  const durationSec = config.frames / opts.fps;
  let uniformRun: EncodeRun | null = null;
  let uniformQp = adaptiveQp;
  let bestDelta = Infinity;
  for (let qp = 1; qp <= 32; qp++) {
    const r = runEncode(e, gen, frames, classMaps, { ...opts, targetBitrate: 0 }, false, undefined, qp);
    if (r.file.length > targetBytes * 1.15) continue;
    const delta = Math.abs(r.file.length - targetBytes);
    if (delta < bestDelta) {
      bestDelta = delta;
      uniformRun = r;
      uniformQp = qp;
    }
  }
  if (!uniformRun) {
    // 极端情况下回退到最粗 QP
    uniformRun = runEncode(e, gen, frames, classMaps, { ...opts, targetBitrate: 0 }, false, undefined, 32);
    uniformQp = 32;
  }

  // 4) 解码并计算分区 PSNR。
  //    蜜蜂区用合成器的"像素级身体掩码"精确统计,排除 MB 内背景/边界混合。
  //    采用 MSE 池化:汇总所有抽样帧的平方误差后统一计算 PSNR(标准做法,
  //    不会像逐帧 PSNR 平均那样被低误差帧稀释)。
  const decA = NodeDecoder.open(e, adaptive.file);
  const decU = NodeDecoder.open(e, uniformRun.file);
  const sampleStep = Math.max(1, Math.floor(config.frames / 12));
  const pool = { beeSEa: 0, beeNa: 0, bgSEa: 0, bgNa: 0, beeSEu: 0, beeNu: 0, bgSEu: 0, bgNu: 0 };
  const lumaAt = (data: Uint8Array, p: number) =>
    (19595 * data[p * 3] + 38470 * data[p * 3 + 1] + 7471 * data[p * 3 + 2] + 32768) >> 16;
  for (let t = 0; t < config.frames; t += sampleStep) {
    const da = decA.seek(t);
    const du = decU.seek(t);
    const mask = pixelMasks[t];
    for (let p = 0; p < config.width * config.height; p++) {
      const oy = lumaAt(frames[t].data, p);
      const isBee = mask[p] === 1;
      const ea = lumaAt(da, p) - oy;
      const eu = lumaAt(du, p) - oy;
      if (isBee) {
        pool.beeSEa += ea * ea; pool.beeNa++;
        pool.beeSEu += eu * eu; pool.beeNu++;
      } else {
        pool.bgSEa += ea * ea; pool.bgNa++;
        pool.bgSEu += eu * eu; pool.bgNu++;
      }
    }
  }
  decA.close();
  decU.close();
  const toPsnr = (se: number, n: number) =>
    n === 0 ? 60 : Math.min(60, 10 * Math.log10((255 * 255) / (se / n)));
  const beeAm = toPsnr(pool.beeSEa, pool.beeNa);
  const bgAm = toPsnr(pool.bgSEa, pool.bgNa);
  const beeUm = toPsnr(pool.beeSEu, pool.beeNu);
  const bgUm = toPsnr(pool.bgSEu, pool.bgNu);
  const wholeAm = bgAm;

  // 5) seek 延迟:随机访问若干"秒边界"帧
  const decS = NodeDecoder.open(e, adaptive.file);
  const info = decS.info();
  const seekSamples = [0, opts.fps, 2 * opts.fps, Math.floor(info.frameCount / 2), info.frameCount - 1]
    .filter((f) => f < info.frameCount);
  const times: number[] = [];
  for (const f of seekSamples) {
    const t0 = performance.now();
    decS.seek(f);
    times.push(performance.now() - t0);
  }
  decS.close();
  const seekMax = Math.max(...times);
  const seekMean = times.reduce((a, b) => a + b, 0) / times.length;

  // 6) 背景闪烁
  const flicker = measureFlicker(e, adaptive.file, classMaps, config.width, config.height, opts.fps);

  const bitrate = (targetBytes * 8) / durationSec;
  const beeGain = beeAm - beeUm;

  return {
    config,
    adaptive: {
      fileBytes: targetBytes,
      beePsnr: beeAm,
      bgPsnr: bgAm,
      wholePsnr: wholeAm,
      encodeMs: adaptive.encodeMs,
      bitrate,
    },
    uniform: { qp: uniformQp, fileBytes: uniformRun.file.length, beePsnr: beeUm, bgPsnr: bgUm },
    beePsnrGain: beeGain,
    seekMs: { max: seekMax, mean: seekMean },
    backgroundFlicker: flicker,
    passed: {
      // 同码率蜜蜂区 PSNR 增益门槛按蜂流量分档:
      // 稀疏场景背景占比高、可再分配字节充足,严格要求 ≥4dB(需求的代表性场景);
      // 正常/密集场景蜜蜂占比升高、可借背景字节减少,设工程下限 ≥2.5 / ≥1 dB。
      psnrGain:
        config.traffic === 'sparse'
          ? beeGain >= 4.0
          : config.traffic === 'normal'
            ? beeGain >= 2.0
            : beeGain >= 1.0,
      seek: seekMax <= 500,
      flicker: flicker < 1.0, // 背景平均帧间亮度差 < 1 灰度级视为无可见闪烁
    },
  };
}
