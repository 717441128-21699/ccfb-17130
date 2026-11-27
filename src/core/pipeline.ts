// 编码/解码流水线:串联 WASM 核心、运动分析、码率控制与 .hvc 容器。

import { WasmCodec } from './codec-wasm.ts';
import { RateController, type RateMode } from './rate-control.ts';
import { HvcReader, HvcWriter } from './container.ts';
import {
  CLASS_BG,
  CLASS_CRAWL,
  CLASS_FAST,
  CLASS_POLLEN,
  type AnalyzeParams,
  type EncodeFrameResult,
  type RateConfig,
} from './types.ts';

export const TRIGGER_FIRST = 0;
export const TRIGGER_LIGHT = 1;
export const TRIGGER_GOP = 2;
export const TRIGGER_NONE = 0;

export interface PsnrSample {
  frame: number;
  full: number;
  bee: number;
  bg: number;
}

export class EncodeSession {
  readonly codec: WasmCodec;
  readonly rate: RateController;
  readonly writer: HvcWriter;
  private analyzeParams: AnalyzeParams;
  private rateCfg: RateConfig;
  private gop: number;
  private fps: number;
  private lastKey = -1;
  private frameNo = 0;
  private lightDriftAccum = 0; // 扣除量化偏置后的真实光照漂移累积(亮度级数)
  private lightBias = 0; // 关键帧量化引入的稳态每帧 DC 偏置(慢 EMA 估计)
  totalBytes = 0;
  keyframes = 0;
  psnrSamples: PsnrSample[] = [];
  psnrEvery = 25;
  onFrame?: (r: EncodeFrameResult) => void;

  constructor(
    wasm: WasmCodec,
    fps: number,
    rateCfg: RateConfig,
    analyzeParams: AnalyzeParams,
    mode: RateMode = 'adaptive',
  ) {
    this.codec = wasm;
    this.rate = new RateController(rateCfg, fps, mode);
    this.writer = new HvcWriter(wasm.w, wasm.h, fps);
    this.analyzeParams = analyzeParams;
    this.rateCfg = rateCfg;
    this.fps = fps;
    this.gop = Math.max(8, Math.round(rateCfg.gopSeconds * fps));
  }

  pushFrame(rgba: Uint8Array | Uint8ClampedArray): EncodeFrameResult {
    const t0 = performance.now();
    const c = this.codec;
    c.rgbaToYuv(rgba);

    let type: 0 | 1;
    let trigger: 'first' | 'light' | 'gop' | null = null;
    let payload: Uint8Array;
    let classes: Uint8Array;
    let lightDelta = 0;
    let qpBase = this.rate.currentQpBase;
    let activeBlocks = 0;

    const isFirst = this.frameNo === 0;
    if (!isFirst) {
      const a = c.analyze(this.analyzeParams);
      classes = a.classes;
      activeBlocks = countActive(classes);
      // 关键帧量化会引入近似恒定的每帧 DC 偏置(与真实光照无关),直接累积会被误判为光照变化。
      // 用慢 EMA 跟踪该稳态偏置,只把偏离偏置基线的"创新量"当作真实光照信号累积。
      const rawDelta = a.delta;
      // 快速跟踪关键帧量化引入的稳态 DC 偏置(关键帧后偏置会变,需尽快收敛)
      const biasAlpha = 0.1;
      this.lightBias += (rawDelta - this.lightBias) * biasAlpha;
      // 创新量 = 偏离偏置基线的部分;小于死区的视为量化噪声,不累积
      const innovation = rawDelta - this.lightBias;
      lightDelta = Math.abs(innovation) > 0.15 ? innovation : 0;
      this.lightDriftAccum += lightDelta;
      // 关键帧后设宽限期,让偏置估计先收敛,避免重建残余差立刻再次触发。
      const inGrace = this.frameNo - this.lastKey < Math.round(this.fps * 0.5);
      const lightChange =
        !inGrace && Math.abs(this.lightDriftAccum) >= this.rateCfg.lightDeltaThr;
      const gopDue = this.frameNo - this.lastKey >= this.gop;
      if (lightChange || gopDue) {
        trigger = lightChange ? 'light' : 'gop';
      }
    } else {
      classes = new Uint8Array(c.nblk);
      trigger = 'first';
    }

    if (trigger !== null) {
      // 关键帧:整帧绝对编码。QP 按 GOP 预算反推,使其受总码率约束。
      // 编码器背景必须用解码端的量化重建结果,否则后续前景帧残差基准
      // 与解码端不一致,误差会沿链累积。
      const qp = this.rate.keyframeQp(c.nblk);
      payload = c.encodeKeyframe(qp);
      c.decodeKeyframe(payload);
      c.copyDecToBackground();
      this.rate.updateKeyframe(payload.length, c.nblk, qp);
      this.lastKey = this.frameNo;
      this.lightDriftAccum = 0;
      this.lightBias = 0; // 新关键帧的量化偏置需要重新估计
      this.keyframes += 1;
      type = 0;
      qpBase = qp;
    } else {
      // 前景帧:只编码活动块,块级 QP 按类别分配
      const { qpMap, qpBase: base } = this.rate.nextQpMap(classes);
      qpBase = base;
      payload = c.encodeForeground(classes, qpMap);
      this.rate.update(payload.length, classes);
      type = 1;
    }

    this.writer.addFrame(
      type, payload, classes, lightDelta,
      trigger === 'first' ? TRIGGER_FIRST
        : trigger === 'light' ? TRIGGER_LIGHT
          : trigger === 'gop' ? TRIGGER_GOP : TRIGGER_NONE,
    );
    this.totalBytes += payload.length;

    // 抽样解码并计算分区 PSNR(只占用 dec 平面,不影响编码状态)
    if (this.frameNo % this.psnrEvery === 0) {
      this.measurePsnr(payload, type, classes);
    }

    const ms = performance.now() - t0;
    const result: EncodeFrameResult = {
      frame: this.frameNo,
      type,
      payload,
      classes,
      sads: new Uint32Array(0),
      bytes: payload.length,
      qpBase,
      lightDelta,
      keyTrigger: trigger,
      activeBlocks,
      ms,
    };
    this.frameNo += 1;
    this.onFrame?.(result);
    return result;
  }

  private measurePsnr(payload: Uint8Array, type: 0 | 1, classes: Uint8Array): void {
    const c = this.codec;
    if (type === 0) {
      c.decodeKeyframe(payload);
    } else {
      c.decodeForeground(payload, c.bgY, c.bgU, c.bgV);
    }
    this.psnrSamples.push({
      frame: this.frameNo,
      full: c.psnrFull(),
      // 蜜蜂区 PSNR 聚焦高速飞行 + 携粉块(研究员关注的清晰度热点);
      // 爬行块按需求刻意省码率,不计入热点口径,单独由 crawl 指标体现。
      bee: c.psnrRegion(classes, [CLASS_FAST, CLASS_POLLEN]),
      bg: c.psnrRegion(classes, [CLASS_BG]),
    });
  }

  finish(): Uint8Array {
    return this.writer.toUint8Array();
  }

  get frameCount(): number {
    return this.frameNo;
  }

  avgPsnr(): { full: number; bee: number; bg: number } {
    const s = this.psnrSamples;
    if (!s.length) return { full: 0, bee: 0, bg: 0 };
    return {
      full: avg(s.map((x) => x.full)),
      bee: avg(s.map((x) => x.bee)),
      bg: avg(s.map((x) => x.bg)),
    };
  }
}

export class DecodeSession {
  readonly codec: WasmCodec;
  readonly reader: HvcReader;

  constructor(codec: WasmCodec, hvcBytes: Uint8Array) {
    this.codec = codec;
    this.reader = new HvcReader(hvcBytes);
    if (this.reader.width !== codec.w || this.reader.height !== codec.h) {
      throw new Error('文件分辨率与解码器不匹配');
    }
  }

  /** 顺序解码指定帧并物化为 RGBA(调用方负责计时) */
  decode(frameNo: number): { rgba: Uint8Array; classes: Uint8Array; type: number } {
    const r = this.decodeYuv(frameNo);
    return { rgba: this.codec.decodedRgba, classes: r.classes, type: r.type };
  }

  /**
   * 仅解码到 YUV 平面,不做昂贵的 YUV->RGB 转换。
   * seek 链上的中间帧只需推进参考状态,无需 RGBA。
   */
  decodeYuv(frameNo: number): { classes: Uint8Array; type: number } {
    const f = this.reader.readFrame(frameNo);
    const c = this.codec;
    if (f.type === 0) {
      c.decodeKeyframe(f.payload);
      // 关键帧重建结果固化为冻结背景,供整个 GOP 的前景帧参考
      c.setRefFromDecoded();
    } else {
      c.decodeForeground(f.payload, c.refY, c.refU, c.refV);
    }
    return { classes: f.classes, type: f.type };
  }

  /** 把当前解码平面物化为 RGBA(仅在需要显示的最终帧调用) */
  materializeRgba(): Uint8Array {
    return this.codec.decodedRgba;
  }

  /**
   * 随机访问:定位到目标秒附近的帧,从最近关键帧链式解码。
   * 链上中间帧只做 YUV 解码(跳过 RGB 转换),仅最终目标帧物化 RGBA。
   * 返回解码画面与实际链长(关键帧到目标帧的距离)。
   */
  seek(second: number): {
    rgba: Uint8Array;
    frameNo: number;
    chainLength: number;
    classes: Uint8Array;
  } {
    const target = Math.min(
      this.reader.frameCount - 1,
      Math.max(0, Math.round(second * this.reader.fps)),
    );
    const key = this.reader.nearestKeyframe(target);
    let classes: Uint8Array = new Uint8Array(0);
    for (let n = key; n <= target; n++) {
      const r = this.decodeYuv(n);
      classes = r.classes as Uint8Array;
    }
    return {
      rgba: this.materializeRgba(),
      frameNo: target,
      chainLength: target - key + 1,
      classes,
    };
  }
}

function countActive(classes: Uint8Array): number {
  let n = 0;
  for (const c of classes) if (c !== CLASS_BG) n++;
  return n;
}

function avg(xs: number[]): number {
  const valid = xs.filter((x) => Number.isFinite(x) && x < 90);
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 99;
}

// 保持类别常量被引用(供外部按位合并统计)
export const BEE_CLASSES = [CLASS_CRAWL, CLASS_FAST, CLASS_POLLEN] as const;
