export type LightingId =
  | 'warm-morning'
  | 'neutral-day'
  | 'cool-overcast'
  | 'harsh-sun'
  | 'dim-evening';

export type FlowId = 'low' | 'medium' | 'high';

export interface SynthSettings {
  source: 'synthetic' | 'video';
  lighting: LightingId;
  flow: FlowId;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  seed: number;
}

export interface BeeAnnotation {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  speedPxS: number;
  pollen: number;
  crawling: boolean;
}

export interface RenderedFrame {
  index: number;
  rgba: Uint8ClampedArray;
  mask: Uint8Array;
  bees: BeeAnnotation[];
}

export interface BlockInfo {
  bx: number;
  by: number;
  motion: number;
  foreground: number;
  pollen: number;
  persistence: number;
  cls: 0 | 1 | 2 | 3;
  weight: number;
}

export interface AnalysisResult {
  width: number;
  height: number;
  block: number;
  gridW: number;
  gridH: number;
  blocks: BlockInfo[];
  weights: Float32Array;
  classes: Uint8Array;
}

export const LIGHTINGS: { id: LightingId; label: string; grade: [number, number, number, number]; overlay: string }[] = [
  { id: 'warm-morning', label: '暖色晨光', grade: [1.1, 1.0, 0.8, 1.05], overlay: 'rgba(255,196,120,0.10)' },
  { id: 'neutral-day', label: '中性日光', grade: [1, 1, 1, 1], overlay: 'rgba(255,255,255,0)' },
  { id: 'cool-overcast', label: '冷色阴天', grade: [0.88, 0.96, 1.1, 0.94], overlay: 'rgba(150,190,255,0.12)' },
  { id: 'harsh-sun', label: '烈日高对比', grade: [1.06, 1.01, 0.88, 1.08], overlay: 'rgba(255,236,180,0.08)' },
  { id: 'dim-evening', label: '昏暗傍晚', grade: [1.12, 0.92, 0.7, 0.72], overlay: 'rgba(40,20,60,0.28)' },
];

export const FLOWS: { id: FlowId; label: string; count: number }[] = [
  { id: 'low', label: '低蜂流', count: 7 },
  { id: 'medium', label: '中蜂流', count: 20 },
  { id: 'high', label: '高蜂流', count: 46 },
];

export const CLASS_LABELS = ['静止背景', '爬行', '快速飞行', '带花粉'];
export const CLASS_COLORS = ['#2f425c', '#8d99ae', '#41d6ff', '#ff7a3d'];
