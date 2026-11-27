// 全局共享类型与常量(编解码核心、Worker、各页面共用)。

/** 块类别,数值与 Rust 端 MbClass 严格一致。 */
export enum MbClass {
  Background = 0,
  Crawling = 1,
  Flying = 2,
  Pollen = 3,
}

export const MB = 16;
export const BLOCK = 8;

/** 类别展示名(中文)与配色(运动区域页/对比页叠加用)。 */
export const CLASS_META: Record<
  MbClass,
  { label: string; color: string; qpDelta: number }
> = {
  [MbClass.Background]: { label: '静止背景', color: 'rgba(120,120,120,0.0)', qpDelta: 6 },
  [MbClass.Crawling]: { label: '爬行蜜蜂', color: 'rgba(80,160,255,0.45)', qpDelta: -2 },
  [MbClass.Flying]: { label: '飞行蜜蜂', color: 'rgba(255,170,40,0.5)', qpDelta: -6 },
  [MbClass.Pollen]: { label: '花粉团', color: 'rgba(255,80,180,0.6)', qpDelta: -9 },
};

/** 一帧 8-bit RGB 图像(RGB 交错,长度 width*height*3)。 */
export interface RawFrame {
  width: number;
  height: number;
  data: Uint8Array; // RGBRGB...
}

/** 16x16 宏块网格的类别图,长度 ceil(w/16)*ceil(h/16)。 */
export type ClassMap = Uint8Array;

/** 运动分析输出:类别图 + 每类 MB 统计 + 背景模型信息。 */
export interface AnalysisResult {
  classMap: ClassMap;
  mbCols: number;
  mbRows: number;
  counts: Record<MbClass, number>;
  meanLuma: number;
}

/** 编码参数(码率分配页)。 */
export interface EncodeOptions {
  fps: number;
  gop: number;
  /** 目标总码率上限(bps);0 表示固定质量模式。 */
  targetBitrate: number;
  /** 固定质量模式下的帧基准 QP(1..32,越小越精细)。 */
  baseQp: number;
}

/** 单帧编码统计。 */
export interface FrameStat {
  index: number;
  bytes: number;
  codedMBs: number;
  frameQp: number;
  isKey: boolean;
}

/** 整个编码任务的汇总。 */
export interface EncodeSummary {
  width: number;
  height: number;
  paddedWidth: number;
  paddedHeight: number;
  fps: number;
  frameCount: number;
  totalBytes: number;
  targetBitrate: number;
  achievedBitrate: number;
  frameStats: FrameStat[];
  classCounts: Record<MbClass, number>;
  encodeMs: number;
}

/** 合成录像的光照条件。 */
export type Lighting = 'bright' | 'overcast' | 'dusk';

/** 合成录像的蜂流量档位。 */
export type BeeTraffic = 'sparse' | 'normal' | 'dense';

export interface SyntheticConfig {
  width: number;
  height: number;
  frames: number;
  fps: number;
  lighting: Lighting;
  traffic: BeeTraffic;
  seed: number;
}

/** PSNR 测量结果(分区域)。 */
export interface PsnrResult {
  beeRegion: number;
  background: number;
  wholeFrame: number;
}
