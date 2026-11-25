import { HiveSynth, synthSettings } from './lib/synth';
import type { SynthSettings, RenderedFrame } from './lib/types';
import type { AnalyzeResponse } from './workers/analysis.worker';

type Listener = () => void;

export interface ProcessedFrame {
  stats: any;
  uniformRgba: Uint8ClampedArray;
  roiRgba: Uint8ClampedArray;
  qmap: Uint8Array;
  gridW: number;
  gridH: number;
  roiBits: Uint8Array;
  width: number;
  height: number;
}

export class Studio {
  settings: SynthSettings = synthSettings();
  synth: HiveSynth | null = null;
  frameIndex = 14;
  frame: RenderedFrame | null = null;
  analysis: AnalyzeResponse | null = null;
  analyzing = false;

  qUniform = 46;
  totalKbps = 24000;
  allocationSource: 'gt' | 'worker' = 'gt';
  tuning = { pollen: 1, fast: 1, crawl: 1 };
  processed: ProcessedFrame | null = null;
  processing = false;

  keyframes = new Map<number, Uint8Array>();
  seekLog: { second: number; ms: number; ok: boolean }[] = [];

  videoEl: HTMLVideoElement | null = null;
  videoFileName = '';

  wasmReady = false;

  private listeners = new Set<Listener>();
  private codecReq = 0;
  private codecPending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  codecWorker: Worker | null = null;
  analysisWorker: Worker | null = null;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit() { this.listeners.forEach((l) => l()); }

  ensureSynth() {
    if (!this.synth) this.synth = new HiveSynth(this.settings);
    return this.synth;
  }
  rebuildSynth() {
    this.synth = new HiveSynth(this.settings);
    this.frame = null;
    this.analysis = null;
    this.processed = null;
    this.keyframes.clear();
    this.emit();
  }

  injectExternalFrame(data: Uint8ClampedArray, w: number, h: number) {
    this.frame = {
      index: this.frameIndex,
      rgba: data,
      mask: new Uint8Array(w * h),
      bees: [],
    };
    this.analysis = null;
    this.processed = null;
    this.emit();
  }

  renderCurrent(): RenderedFrame {
    const synth = this.ensureSynth();
    // Keep index inside the virtual clip length.
    const maxFrame = Math.max(0, this.settings.durationSeconds * this.settings.fps - 1);
    this.frameIndex = Math.min(this.frameIndex, maxFrame);
    this.frame = synth.render(this.frameIndex);
    return this.frame;
  }

  // ---- codec worker RPC ----------------------------------------------------
  initCodecWorker() {
    if (this.codecWorker) return;
    this.codecWorker = new Worker(new URL('./workers/codec.worker.ts', import.meta.url), { type: 'module' });
    this.codecWorker.onmessage = (ev: MessageEvent) => {
      const m = ev.data;
      if (m.type === 'ready') { this.wasmReady = true; this.emit(); return; }
      const p = this.codecPending.get(m.id);
      if (!p) return;
      this.codecPending.delete(m.id);
      if (m.type === 'error') p.reject(new Error(m.message));
      else p.resolve(m);
    };
    this.codecWorker.postMessage({ type: 'init' });
  }

  private codecCall<T = any>(msg: any, transfer: Transferable[] = []): Promise<T> {
    this.initCodecWorker();
    const id = ++this.codecReq;
    return new Promise<T>((resolve, reject) => {
      this.codecPending.set(id, { resolve, reject });
      this.codecWorker!.postMessage({ ...msg, id }, transfer);
    });
  }

  runBenchmark(spec: string) { return this.codecCall<{ report: any }>({ type: 'benchmark', spec }); }
  runThroughput(spec: string) { return this.codecCall<{ report: any }>({ type: 'throughput', spec }); }

  async compressToCap(): Promise<ProcessedFrame> {
    const targetBytes = (this.totalKbps * 1000) / 8 / this.settings.fps;
    let q = this.qUniform;
    let out: ProcessedFrame | null = null;
    for (let i = 0; i < 4; i++) {
      this.qUniform = q;
      out = await this.processCurrent();
      const bytes = Math.max(out.stats.uniformBytes, out.stats.roiBytes);
      if (bytes <= targetBytes * 1.05) break;
      // Quant scales roughly linearly with the byte overshoot after DCT.
      q = Math.min(240, Math.max(2, Math.round(q * Math.sqrt(bytes / targetBytes)) + 4));
    }
    this.qUniform = q;
    this.emit();
    return out!;
  }

  async processCurrent(): Promise<ProcessedFrame> {
    if (!this.frame) this.renderCurrent();
    const f = this.frame!;
    this.processing = true; this.emit();
    try {
      let weights: Float32Array | undefined;
      let classes: Uint8Array | undefined;
      if (this.allocationSource === 'gt' && this.synth) {
        const gt = this.synth.gtWeights(f.mask);
        weights = gt.weights; classes = gt.classes;
      } else if (this.analysis) {
        weights = this.analysis.weights; classes = this.analysis.cls;
      } else if (this.synth) {
        const gt = this.synth.gtWeights(f.mask);
        weights = gt.weights; classes = gt.classes;
      }
      // Never tune/mutate the stored analysis weights in place.
      if (weights) weights = weights.slice();
      if (weights && classes) {
        for (let i = 0; i < weights.length; i++) {
          if (classes[i] === 3) weights[i] *= this.tuning.pollen;
          else if (classes[i] === 2) weights[i] *= this.tuning.fast;
          else if (classes[i] === 1) weights[i] *= this.tuning.crawl;
        }
      }
      // Send copies and transfer those, keeping studio.frame valid for the UI.
      const rgbaSend = f.rgba.slice();
      const maskSend = f.mask.slice();
      const wSend = weights ? weights.slice() : undefined;
      const res = await this.codecCall<any>({
        type: 'process',
        rgba: rgbaSend, width: this.settings.width, height: this.settings.height,
        qUniform: this.qUniform, weights: wSend, mask: maskSend,
      }, [rgbaSend.buffer as any, wSend?.buffer as any, maskSend.buffer as any].filter(Boolean) as Transferable[]);
      // Note: transferring f.rgba/mask buffers detaches them; re-render if needed.
      const out: ProcessedFrame = {
        stats: res.stats,
        uniformRgba: new Uint8ClampedArray(res.u),
        roiRgba: new Uint8ClampedArray(res.o),
        qmap: new Uint8Array(res.q),
        gridW: res.gridW, gridH: res.gridH,
        roiBits: new Uint8Array(res.b),
        width: this.settings.width, height: this.settings.height,
      };
      this.processed = out;
      this.keyframes.set(Math.floor(this.frameIndex / this.settings.fps), out.roiBits);
      return out;
    } finally {
      this.processing = false;
      this.emit();
    }
  }

  async decodeAtSecond(second: number): Promise<number> {
    const bits = this.keyframes.get(second);
    if (!bits) throw new Error(`第 ${second} 秒还没有关键帧，请先压缩该秒`);
    const res = await this.codecCall<{ ms: number }>({ type: 'decode', bits: bits.slice() });
    this.seekLog.unshift({ second, ms: res.ms, ok: true });
    this.seekLog = this.seekLog.slice(0, 8);
    this.emit();
    return res.ms;
  }

  // ---- analysis worker -----------------------------------------------------
  async analyzeCurrent(): Promise<AnalyzeResponse> {
    if (!this.analysisWorker) {
      this.analysisWorker = new Worker(new URL('./workers/analysis.worker.ts', import.meta.url), { type: 'module' });
    }
    // Warm up on preceding frames so SAD and persistence are meaningful on a
    // single button click. The TS synthesizer is deterministically seekable.
    const targetIndex = this.frameIndex;
    const warm = this.settings.source === 'synthetic' && this.synth ? 9 : 0;
    this.analyzing = true; this.emit();

    const worker = this.analysisWorker!;
    const result = new Promise<AnalyzeResponse>((resolve, reject) => {
      const onMsg = (ev: MessageEvent) => {
        const m = ev.data as AnalyzeResponse;
        if (m.type === 'analysis' && m.frameId === targetIndex) {
          worker.removeEventListener('message', onMsg);
          this.analysis = m;
          this.analyzing = false;
          this.emit();
          resolve(m);
        }
      };
      worker.addEventListener('message', onMsg);
      worker.addEventListener('error', (e) => { this.analyzing = false; this.emit(); reject(e); }, { once: true });
    });

    for (let k = warm; k >= 1; k--) {
      const idx = Math.max(0, targetIndex - k);
      const f = this.synth!.render(idx);
      const copy = f.rgba.slice();
      worker.postMessage({
        type: 'analyze', frameId: idx,
        width: this.settings.width, height: this.settings.height, block: 16, rgba: copy,
      }, [copy.buffer]);
    }
    if (!this.frame || this.frameIndex !== targetIndex) this.renderCurrent();
    const rgbaCopy = this.frame!.rgba.slice();
    worker.postMessage({
      type: 'analyze', frameId: targetIndex,
      width: this.settings.width, height: this.settings.height, block: 16,
      rgba: rgbaCopy,
    }, [rgbaCopy.buffer]);

    return result;
  }
}

export const studio = new Studio();
