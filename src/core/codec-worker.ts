// 编解码 Worker:实例化独立 WASM 核心,接收分块运动分析与帧编码任务。
// 浏览器原生 module worker;Node 端由 worker-node-adapter 用 worker_threads 加载同一份模块。

import { instantiateWasm, WasmCodec } from './codec-wasm.ts';
import { EncodeSession } from './pipeline.ts';
import {
  CLASS_BG,
  type AnalyzeParams,
  type RateConfig,
} from './types.ts';

export interface AnalyzeTask {
  kind: 'analyze';
  id: number;
  width: number;
  height: number;
  rowStart: number; // 块行起始(含)
  rowEnd: number;   // 块行结束(不含)
  bgY: ArrayBuffer;
  curY: ArrayBuffer;
  curU: ArrayBuffer;
  curV: ArrayBuffer;
  params: AnalyzeParams;
}

export interface AnalyzeResult {
  kind: 'analyze';
  id: number;
  rowStart: number;
  rowEnd: number;
  classes: ArrayBuffer;
  sads: ArrayBuffer;
  deltas: ArrayBuffer; // 每个块行一个平均亮度漂移
}

export interface EncodeTask {
  kind: 'encode';
  frame: number;
  width: number;
  height: number;
  fps: number;
  rgba: ArrayBuffer;
  rateCfg: RateConfig;
  analyzeParams: AnalyzeParams;
  mode: 'adaptive' | 'uniform';
  psnrEvery: number;
}

export interface EncodeResult {
  kind: 'encode';
  frame: number;
  type: number;
  trigger: number;
  bytes: number;
  qpBase: number;
  lightDelta: number;
  activeBlocks: number;
  classes: ArrayBuffer;
  psnr: { frame: number; full: number; bee: number; bg: number } | null;
  ms: number;
}

export interface EncodeInit {
  kind: 'init';
  wasm: ArrayBuffer;
}

type InMsg = AnalyzeTask | EncodeTask | EncodeInit;

let codec: WasmCodec | null = null;
let session: EncodeSession | null = null;
let lastDims = '';
let lastMode = '';

async function ensureCodec(wasmBytes: Uint8Array, w: number, h: number): Promise<WasmCodec> {
  const key = `${w}x${h}`;
  if (!codec || lastDims !== key) {
    const x = await instantiateWasm(wasmBytes);
    codec = new WasmCodec(x, w, h);
    lastDims = key;
  }
  return codec;
}

let wasmBytes: Uint8Array | null = null;

self.onmessage = async (ev: MessageEvent<InMsg>): Promise<void> => {
  const msg = ev.data;

  if (msg.kind === 'init') {
    wasmBytes = new Uint8Array(msg.wasm);
    (self as unknown as { postMessage: (m: unknown) => void }).postMessage({ kind: 'ready' });
    return;
  }

  if (!wasmBytes) throw new Error('Worker 尚未 init');

  if (msg.kind === 'analyze') {
    const c = await ensureCodec(wasmBytes, msg.width, msg.height);
    const nbw = msg.width / 8;
    const rows = msg.rowEnd - msg.rowStart;
    const n = rows * nbw;
    // 全尺寸平面需要整块内存:把传入的平面写入 codec 缓冲的对应区域
    const fullY = msg.width * msg.height;
    const fullC = (msg.width / 2) * (msg.height / 2);
    new Int16Array(c.x.memory.buffer, c.bgY, fullY).set(new Int16Array(msg.bgY));
    new Int16Array(c.x.memory.buffer, c.curY, fullY).set(new Int16Array(msg.curY));
    new Int16Array(c.x.memory.buffer, c.curU, fullC).set(new Int16Array(msg.curU));
    new Int16Array(c.x.memory.buffer, c.curV, fullC).set(new Int16Array(msg.curV));

    const a = c.analyze(msg.params);
    const classesPart = a.classes.slice(msg.rowStart * nbw, msg.rowEnd * nbw);
    const sadsPart = a.sads.slice(msg.rowStart * nbw, msg.rowEnd * nbw);
    const deltas = new Float32Array(rows);
    for (let r = msg.rowStart; r < msg.rowEnd; r++) {
      let sum = 0;
      let cnt = 0;
      for (let bx = 0; bx < nbw; bx++) {
        if (classesPart[(r - msg.rowStart) * nbw + bx] === CLASS_BG) {
          sum += sadsPart[(r - msg.rowStart) * nbw + bx];
          cnt++;
        }
      }
      deltas[r - msg.rowStart] = cnt ? sum / cnt : 0;
    }
    const res: AnalyzeResult = {
      kind: 'analyze',
      id: msg.id,
      rowStart: msg.rowStart,
      rowEnd: msg.rowEnd,
      classes: classesPart.buffer,
      sads: sadsPart.buffer,
      deltas: deltas.buffer,
    };
    (self as unknown as {
      postMessage: (m: unknown, transfer?: Transferable[]) => void;
    }).postMessage(res, [res.classes, res.sads, res.deltas] as Transferable[]);
    return;
  }

  if (msg.kind === 'encode') {
    const c = await ensureCodec(wasmBytes, msg.width, msg.height);
    const modeKey = `${msg.width}x${msg.height}:${msg.mode}`;
    if (!session || lastMode !== modeKey) {
      session = new EncodeSession(c, msg.fps, msg.rateCfg, msg.analyzeParams, msg.mode);
      session.psnrEvery = msg.psnrEvery;
      lastMode = modeKey;
    }
    const r = session.pushFrame(new Uint8Array(msg.rgba));
    const lastPsnr = session.psnrSamples.length
      ? session.psnrSamples[session.psnrSamples.length - 1]
      : null;
    const res: EncodeResult = {
      kind: 'encode',
      frame: msg.frame,
      type: r.type,
      trigger: r.keyTrigger === 'first' ? 0 : r.keyTrigger === 'light' ? 1 : r.keyTrigger === 'gop' ? 2 : 0,
      bytes: r.bytes,
      qpBase: r.qpBase,
      lightDelta: r.lightDelta,
      activeBlocks: r.activeBlocks,
      classes: r.classes.buffer as ArrayBuffer,
      psnr: lastPsnr && lastPsnr.frame === r.frame ? lastPsnr : null,
      ms: r.ms,
    };
    (self as unknown as {
      postMessage: (m: unknown, transfer?: Transferable[]) => void;
    }).postMessage(res, [res.classes] as Transferable[]);
    return;
  }
};
