// 全局应用状态(轻量发布订阅),在四个页面间共享录像、分析结果与压缩产物。

import type {
  AnalysisResult,
  ClassMap,
  EncodeOptions,
  EncodeSummary,
  RawFrame,
  SyntheticConfig,
} from './core/types';

export interface AppState {
  synthCfg: SyntheticConfig | null;
  frames: RawFrame[];
  groundTruths: Uint8Array[];
  analyses: AnalysisResult[];
  classMaps: ClassMap[];
  encodeOpts: EncodeOptions;
  encodedFile: Uint8Array | null;
  summary: EncodeSummary | null;
  wasmReady: boolean;
}

const initialState: AppState = {
  synthCfg: null,
  frames: [],
  groundTruths: [],
  analyses: [],
  classMaps: [],
  encodeOpts: {
    fps: 200,
    gop: 25, // 200fps 下每 0.125s 一个 I 帧,保证秒级 seek 快速
    targetBitrate: 8_000_000,
    baseQp: 12,
  },
  encodedFile: null,
  summary: null,
  wasmReady: false,
};

type Listener = (state: AppState) => void;

class Store {
  private state: AppState = initialState;
  private listeners = new Set<Listener>();

  get(): AppState {
    return this.state;
  }

  set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l(this.state));
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const store = new Store();
