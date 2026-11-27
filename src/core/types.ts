// 共享类型定义(纯类型 + 常量,可在浏览器 Worker 与 Node 中同时使用)

export const BLOCK = 8;

export const CLASS_BG = 0;
export const CLASS_CRAWL = 1;
export const CLASS_FAST = 2;
export const CLASS_POLLEN = 3;

export type BlockClass = 0 | 1 | 2 | 3;

export const CLASS_NAMES = ['静止背景', '爬行蜜蜂', '快速飞行', '携粉蜂'] as const;
export const CLASS_COLORS = ['#3d4655', '#4cc9f0', '#f77f00', '#e63946'] as const;

export type FrameType = 0 | 1; // 0 = 关键帧(背景帧), 1 = 前景帧

export interface BeeAnnotation {
  x: number;
  y: number;
  w: number;
  h: number;
  mode: 'fly' | 'crawl' | 'pollen';
  vx: number;
  vy: number;
}

export interface FrameAnnotation {
  frame: number;
  bees: BeeAnnotation[];
  lightGain: number; // 该帧全局光照增益(1.0 为基准)
}

export type LightScenario = 'stable' | 'drift' | 'clouds';
export type TrafficScenario = 'low' | 'medium' | 'high';

export interface SynthConfig {
  width: number;
  height: number;
  fps: number;
  frames: number;
  light: LightScenario;
  traffic: TrafficScenario;
  seed: number;
}

export interface AnalyzeParams {
  sadActive: number;
  sadFast: number;
  pollenV: number;
  pollenSat: number;
}

export interface RateConfig {
  maxBitrateKbps: number; // 研究员设定的总码率上限
  qpMin: number;
  qpMax: number;
  offsetPollen: number; // 携粉块 QP 偏移(负 = 更多码率)
  offsetFast: number;
  offsetCrawl: number; // 爬行块 QP 偏移(正 = 省码率)
  gopSeconds: number; // 强制关键帧间隔(秒),保证随机访问
  lightDeltaThr: number; // 光照漂移阈值(亮度级数)
}

export const DEFAULT_RATE: RateConfig = {
  maxBitrateKbps: 4000,
  qpMin: 6,
  qpMax: 51,
  offsetPollen: -10,
  offsetFast: -7,
  offsetCrawl: 7,
  gopSeconds: 2,
  lightDeltaThr: 16,
};

export const DEFAULT_ANALYZE: AnalyzeParams = {
  sadActive: 900,
  sadFast: 3500,
  pollenV: 28,
  pollenSat: 12,
};

export interface EncodeFrameResult {
  frame: number;
  type: FrameType;
  payload: Uint8Array;
  classes: Uint8Array;
  sads: Uint32Array;
  bytes: number;
  qpBase: number;
  lightDelta: number;
  keyTrigger: 'first' | 'light' | 'gop' | null;
  activeBlocks: number;
  ms: number;
}

export interface SessionStats {
  frames: number;
  keyframes: number;
  totalBytes: number;
  bitrateKbps: number;
  beePsnr: number;
  bgPsnr: number;
  fullPsnr: number;
  uniformBeePsnr: number;
  encodeFps: number;
}
