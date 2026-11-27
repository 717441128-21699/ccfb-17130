// 分块运动分析(运行在 Web Worker 中)。
//
// 职责:
//  1. 维护逐像素背景模型(时间指数滑动平均),仅在光照变化时更新;
//  2. 按 16x16 宏块计算前景 SAD,区分静止/运动;
//  3. 用速度(块在相邻帧的位移)与饱和度区分爬行/飞行/花粉团;
//  4. 输出类别图与每类统计,供码率分配与可视化使用。

import { MB, MbClass, type AnalysisResult, type ClassMap, type RawFrame } from './types';

/** 背景更新的学习率(指数滑动平均)。 */
const BG_ALPHA = 0.04;
/** 触发"光照变化"的全局平均亮度差阈值。 */
const LIGHTING_CHANGE_LUMA = 6;
/** MB 前景判定的平均每像素 SAD 阈值。 */
const FG_SAD_PER_PIXEL = 14;
/** 高饱和度阈值(花粉团为高饱和橙黄色)。 */
const POLLEN_SAT = 90;
/** 爬行(慢速)与飞行(快速)的块速度阈值,像素/帧。 */
const FAST_SPEED = 1.2;

interface TrackedBlock {
  cx: number;
  cy: number;
  speed: number;
}

export class MotionAnalyzer {
  readonly mbCols: number;
  readonly mbRows: number;
  // 浮点背景模型:V8 对 Float32Array 的乘加优化优于整数除法。
  private bg: Float32Array;
  private bgReady = false;
  private tracks: TrackedBlock[];
  private frameCount = 0;

  constructor(
    private width: number,
    private height: number,
  ) {
    this.mbCols = Math.ceil(width / MB);
    this.mbRows = Math.ceil(height / MB);
    const n = width * height;
    this.bg = new Float32Array(n);
    this.tracks = Array.from({ length: this.mbCols * this.mbRows }, () => ({
      cx: 0,
      cy: 0,
      speed: 0,
    }));
  }

  /** BT.601 full-range 亮度。 */
  static luma(r: number, g: number, b: number): number {
    return (19595 * r + 38470 * g + 7471 * b + 32768) >> 16;
  }

  /** 分析一帧,返回类别图与统计。luma 单遍预计算,MB 处理复用。 */
  analyze(frame: RawFrame): AnalysisResult {
    const { width: w, height: h, data } = frame;
    const n = w * h;

    // 单遍预计算亮度(整数),后续 MB 的 SAD 与背景更新复用,避免重复乘法
    const luma = new Uint8Array(n);
    let lumaSum = 0;
    for (let p = 0; p < n; p++) {
      const y = MotionAnalyzer.luma(data[p * 3], data[p * 3 + 1], data[p * 3 + 2]);
      luma[p] = y;
      lumaSum += y;
    }
    const meanLuma = lumaSum / n;

    let lightingChanged = false;
    if (this.bgReady) {
      let bgSum = 0;
      for (let p = 0; p < n; p += 16) bgSum += this.bg[p];
      const bgMean = (bgSum * 16) / n;
      lightingChanged = Math.abs(meanLuma - bgMean) > LIGHTING_CHANGE_LUMA;
    } else {
      for (let p = 0; p < n; p++) this.bg[p] = luma[p];
      this.bgReady = true;
    }

    const classMap: ClassMap = new Uint8Array(this.mbCols * this.mbRows);
    const counts: Record<MbClass, number> = [0, 0, 0, 0];
    const keep = 1 - (lightingChanged ? BG_ALPHA * 4 : BG_ALPHA);
    const emaAlpha = lightingChanged ? BG_ALPHA * 4 : BG_ALPHA;

    for (let my = 0; my < this.mbRows; my++) {
      for (let mx = 0; mx < this.mbCols; mx++) {
        const m = my * this.mbCols + mx;
        const stats = this.blockStats(luma, data, mx, my);
        const isForeground = stats.sad / stats.samples > FG_SAD_PER_PIXEL;

        if (!isForeground) {
          classMap[m] = MbClass.Background;
          // 全像素背景 EMA:保证背景模型充分更新、分类稳定(降采样会损及精度)。
          const x0 = mx * MB;
          const y0 = my * MB;
          for (let dy = 0; dy < MB; dy++) {
            const y = y0 + dy < h ? y0 + dy : h - 1;
            const rowBase = y * w;
            for (let dx = 0; dx < MB; dx++) {
              const x = x0 + dx < w ? x0 + dx : w - 1;
              const p = rowBase + x;
              this.bg[p] = this.bg[p] * keep + luma[p] * emaAlpha;
            }
          }
        } else {
          const track = this.tracks[m];
          track.speed = this.estimateSpeed(track, stats.cx, stats.cy);
          track.cx = stats.cx;
          track.cy = stats.cy;
          if (stats.sat > POLLEN_SAT) {
            classMap[m] = MbClass.Pollen;
          } else if (track.speed >= FAST_SPEED) {
            classMap[m] = MbClass.Flying;
          } else {
            classMap[m] = MbClass.Crawling;
          }
        }
        counts[classMap[m] as MbClass]++;
      }
    }

    this.frameCount++;
    return {
      classMap,
      mbCols: this.mbCols,
      mbRows: this.mbRows,
      counts,
      meanLuma,
    };
  }

  /** 计算一个 MB 的前景 SAD、最大饱和度与质心。 */
  private blockStats(
    luma: Uint8Array,
    data: Uint8Array,
    mx: number,
    my: number,
  ): { sad: number; sat: number; cx: number; cy: number; samples: number } {
    const { width: w, height: h } = this;
    const x0 = mx * MB;
    const y0 = my * MB;
    let sad = 0;
    let satMax = 0;
    let wx = 0;
    let wy = 0;
    let weight = 0;
    for (let dy = 0; dy < MB; dy++) {
      const y = y0 + dy < h ? y0 + dy : h - 1;
      const rowBase = y * w;
      for (let dx = 0; dx < MB; dx++) {
        const x = x0 + dx < w ? x0 + dx : w - 1;
        const p = rowBase + x;
        const diff = Math.abs(luma[p] - this.bg[p]);
        sad += diff;
        const i = p * 3;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const s = Math.max(r, g, b) - Math.min(r, g, b);
        if (s > satMax) satMax = s;
        wx += dx * diff;
        wy += dy * diff;
        weight += diff;
      }
    }
    const samples = MB * MB;
    const cx = weight > 0 ? x0 + wx / weight : x0 + MB / 2;
    const cy = weight > 0 ? y0 + wy / weight : y0 + MB / 2;
    return { sad, sat: satMax, cx, cy, samples };
  }

  /** 基于质心位移估计块速度(指数平滑)。 */
  private estimateSpeed(track: TrackedBlock, cx: number, cy: number): number {
    if (this.frameCount === 0) return 0;
    const inst = Math.hypot(cx - track.cx, cy - track.cy);
    return track.speed * 0.6 + inst * 0.4;
  }
}
