// 码率分配:VBV 虚拟缓冲区反馈 + 块类别指数模型前馈。
// 在研究员设定的总码率上限内,把码率向快速飞行/携粉块倾斜,爬行块省码率。

import {
  CLASS_BG,
  CLASS_CRAWL,
  CLASS_FAST,
  CLASS_POLLEN,
  type BlockClass,
  type RateConfig,
} from './types.ts';

const REF_QP = 26;
// 参考 QP 下每块每帧的经验字节初值(背景块不参与前景编码,置 0)
const INIT_BPS = [0, 42, 95, 130];
// 关键帧在参考 QP 下每个 8x8 亮度块的经验字节(已含该块对应的色度与头部开销)
// 由 1080p 木板噪声背景实测反推校准。
const INIT_KEY_BPS = 76.5;

export type RateMode = 'adaptive' | 'uniform';

export class RateController {
  readonly cfg: RateConfig;
  readonly fps: number;
  readonly mode: RateMode;
  readonly budgetPerFrame: number;
  readonly gopLength: number;

  private qpBase = 26;
  private fullness = 0; // 虚拟缓冲占用(字节)
  private classBps: number[];
  private keyBps = INIT_KEY_BPS;
  private lastQpMap: Uint8Array = new Uint8Array(0);
  private lastActive = 0;

  constructor(cfg: RateConfig, fps: number, mode: RateMode = 'adaptive') {
    this.cfg = cfg;
    this.fps = fps;
    this.mode = mode;
    this.budgetPerFrame = (cfg.maxBitrateKbps * 1000) / 8 / fps;
    this.gopLength = Math.max(8, Math.round(cfg.gopSeconds * fps));
    this.classBps = [...INIT_BPS];
  }

  /** 关键帧 QP:严格按总码率预算反推,目标为单帧预算的一个可控倍数 */
  keyframeQp(totalBlocks: number): number {
    // 关键帧目标字节:允许占用 N 个普通帧预算。封顶 QP44 以保护背景模型:
    // 更高 QP 的量化噪声会让绝大多数块误判为活动块,导致码率失控。
    const allowance = Math.min(this.gopLength * 0.15, 10) * this.budgetPerFrame;
    const estAtRef = totalBlocks * this.keyBps;
    let qp = REF_QP + 6 * Math.log2(estAtRef / Math.max(1, allowance));
    qp += 0.5 * (this.fullness / Math.max(1, this.budgetPerFrame));
    return Math.round(clamp(qp, this.cfg.qpMin + 4, 44));
  }

  private offsetFor(c: BlockClass): number {
    if (this.mode === 'uniform') return 0;
    switch (c) {
      case CLASS_POLLEN: return this.cfg.offsetPollen;
      case CLASS_FAST: return this.cfg.offsetFast;
      case CLASS_CRAWL: return this.cfg.offsetCrawl;
      default: return 0;
    }
  }

  /** 用指数模型估计给定 qpBase 下本帧总字节 */
  estimate(classes: ArrayLike<number>, qpBase: number): number {
    let total = 0;
    for (let i = 0; i < classes.length; i++) {
      const c = classes[i] as BlockClass;
      if (c === CLASS_BG) continue;
      const qp = qpBase + this.offsetFor(c);
      total += this.classBps[c] * Math.pow(2, (REF_QP - qp) / 6);
    }
    return total;
  }

  /** 计算下一帧的块 QP 图(背景块给 qpMax 占位,不会被编码) */
  nextQpMap(classes: Uint8Array): { qpMap: Uint8Array; qpBase: number; estimated: number } {
    const { qpMin } = this.cfg;

    // 1) VBV 反馈:缓冲超支 -> 抬 QP,欠支 -> 降 QP
    const vbvAdj = 0.8 * (this.fullness / Math.max(1, this.budgetPerFrame));
    let qp = this.qpBase + vbvAdj;

    // 2) 前馈:按指数模型把整帧拉回预算(含类别偏移的真实估计)
    const est0 = this.estimate(classes, qp);
    if (est0 > 0) {
      qp += 6 * Math.log2(est0 / this.budgetPerFrame);
    }
    qp = Math.round(clamp(qp, qpMin, 48));

    const qpMap = new Uint8Array(classes.length);
    let active = 0;
    for (let i = 0; i < classes.length; i++) {
      const c = classes[i] as BlockClass;
      if (c === CLASS_BG) {
        qpMap[i] = 48;
      } else {
        qpMap[i] = clamp(Math.round(qp + this.offsetFor(c)), qpMin, 48);
        active++;
      }
    }
    this.lastQpMap = qpMap;
    this.lastActive = active;
    return { qpMap, qpBase: qp, estimated: this.estimate(classes, qp) };
  }

  /** 帧编码完成后更新模型与虚拟缓冲 */
  update(actualBytes: number, classes: Uint8Array): void {
    this.fullness = clamp(
      this.fullness + actualBytes - this.budgetPerFrame,
      -this.budgetPerFrame * this.gopLength,
      this.budgetPerFrame * this.gopLength,
    );
    // 平滑趋近目标满度(中点)
    this.fullness *= 0.95;

    if (this.lastActive > 0) {
      const perBlock = actualBytes / this.lastActive;
      const counts = [0, 0, 0, 0];
      for (let i = 0; i < classes.length; i++) {
        if (classes[i] !== CLASS_BG) counts[classes[i]]++;
      }
      for (let c = 1; c <= 3; c++) {
        if (counts[c] === 0) continue;
        const qpUsed = this.qpBase + this.offsetFor(c as BlockClass);
        // 折算回参考 QP 的每块字节
        const refBps = perBlock * Math.pow(2, (qpUsed - REF_QP) / 6);
        this.classBps[c] = 0.75 * this.classBps[c] + 0.25 * refBps;
      }
    }
    this.qpBase = this.lastQpMap.length
      ? averageActiveQp(this.lastQpMap, classes)
      : this.qpBase;
  }

  /** 关键帧计入虚拟缓冲,并按实测更新关键帧字节模型 */
  updateKeyframe(actualBytes: number, totalBlocks: number, qpUsed: number): void {
    this.fullness = clamp(
      this.fullness + actualBytes - this.budgetPerFrame,
      -this.budgetPerFrame * this.gopLength,
      this.budgetPerFrame * this.gopLength,
    );
    this.fullness *= 0.95;
    if (totalBlocks > 0) {
      const refBps = (actualBytes / totalBlocks) * Math.pow(2, (qpUsed - REF_QP) / 6);
      this.keyBps = 0.7 * this.keyBps + 0.3 * refBps;
    }
  }

  get currentQpBase(): number {
    return this.qpBase;
  }
}

function averageActiveQp(qpMap: Uint8Array, classes: ArrayLike<number>): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < qpMap.length; i++) {
    if (classes[i] !== CLASS_BG) {
      sum += qpMap[i];
      n++;
    }
  }
  return n ? sum / n : 26;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
