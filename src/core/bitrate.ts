// 码率分配:把研究员设定的总码率上限换算为逐帧目标字节,
// 并根据实际产出做闭环 QP 调整(滑窗,约 1 秒一个反馈窗口)。
//
// 与 WASM 编码器内部的码率控制互补:这里在 TS 侧做"全局预算 + 分类权重"
// 的规划,编码器内部做逐帧兜底,两者共同保证不超总码率。

import { MB, MbClass } from './types';

export interface AllocatorConfig {
  fps: number;
  targetBitrate: number; // bps
  width: number;
  height: number;
}

/** 各类别相对帧基准的码率权重(越重要权重越高)。 */
export const CLASS_WEIGHT: Record<MbClass, number> = {
  [MbClass.Background]: 0.25,
  [MbClass.Crawling]: 0.7,
  [MbClass.Flying]: 1.4,
  [MbClass.Pollen]: 2.0,
};

export class BitrateAllocator {
  readonly bytesPerFrameBudget: number;
  private windowBytes = 0;
  private windowFrames = 0;
  private readonly windowSize: number;
  private qp: number;
  readonly mbCount: number;

  constructor(cfg: AllocatorConfig, startQp = 12) {
    this.bytesPerFrameBudget = cfg.targetBitrate / 8 / cfg.fps;
    this.windowSize = Math.max(1, Math.round(cfg.fps)); // 1 秒窗口
    this.qp = startQp;
    this.mbCols = Math.ceil(cfg.width / MB);
    this.mbRows = Math.ceil(cfg.height / MB);
    this.mbCount = this.mbCols * this.mbRows;
  }

  private mbCols: number;
  private mbRows: number;

  /** 当前建议的帧基准 QP。 */
  currentQp(): number {
    return this.qp;
  }

  /**
   * 依据类别图估算该帧的"复杂度权重",用于在多帧间动态再分配:
   * 高权重帧(花粉/飞行蜂多)可从低权重帧借预算。
   */
  frameWeight(classMap: Uint8Array): number {
    let w = 0;
    for (let m = 0; m < classMap.length; m++) {
      w += CLASS_WEIGHT[classMap[m] as MbClass] ?? 1;
    }
    return w / classMap.length;
  }

  /** 记录一帧实际产出字节,并在窗口结束时调整 QP。 */
  recordFrame(bytes: number): void {
    this.windowBytes += bytes;
    this.windowFrames++;
    if (this.windowFrames >= this.windowSize) {
      const target = this.bytesPerFrameBudget * this.windowFrames;
      const ratio = this.windowBytes / Math.max(1, target);
      if (ratio > 1.2) this.qp = Math.min(30, this.qp + 1);
      else if (ratio > 1.6) this.qp = Math.min(30, this.qp + 2);
      else if (ratio < 0.6) this.qp = Math.max(2, this.qp - 1);
      else if (ratio < 0.35) this.qp = Math.max(2, this.qp - 2);
      this.windowBytes = 0;
      this.windowFrames = 0;
    }
  }

  /** 截至目前的平均每帧字节(用于 UI 展示预算消耗)。 */
  get averageBytes(): number {
    return this.bytesPerFrameBudget;
  }
}
