/// <reference lib="webworker" />
import { HiveWasm } from '../wasm/hive-client';

let wasm: HiveWasm | null = null;

export type CodecRequest =
  | { type: 'init' }
  | { type: 'benchmark'; id: number; spec: string }
  | { type: 'throughput'; id: number; spec: string }
  | {
      type: 'process'; id: number;
      rgba: Uint8ClampedArray; width: number; height: number; qUniform: number;
      weights?: Float32Array; mask?: Uint8Array | null;
    }
  | { type: 'decode'; id: number; bits: Uint8Array };

self.onmessage = async (ev: MessageEvent<CodecRequest>) => {
  const msg = ev.data;
  try {
    if (!wasm) wasm = await HiveWasm.load();
    if (msg.type === 'init') {
      post({ type: 'ready' });
      return;
    }
    if (msg.type === 'benchmark') {
      const report = wasm.benchmark(msg.spec);
      post({ type: 'benchmark', id: msg.id, report });
      return;
    }
    if (msg.type === 'throughput') {
      const report = wasm.throughput(msg.spec);
      post({ type: 'throughput', id: msg.id, report });
      return;
    }
    if (msg.type === 'process') {
      const r = wasm.processFrame({
        rgba: msg.rgba, width: msg.width, height: msg.height,
        qUniform: msg.qUniform, weights: msg.weights, mask: msg.mask ?? null,
      });
      // Copy buffers into transferables.
      const u = r.uniformRgba.buffer.slice(0) as ArrayBuffer;
      const o = r.roiRgba.buffer.slice(0) as ArrayBuffer;
      const q = r.qmap.buffer.slice(0) as ArrayBuffer;
      const b = r.roiBits.buffer.slice(0) as ArrayBuffer;
      (self as unknown as Worker).postMessage(
        { type: 'process', id: msg.id, stats: r.stats, gridW: r.gridW, gridH: r.gridH, u, o, q, b },
        { transfer: [u, o, q, b] },
      );
      return;
    }
    if (msg.type === 'decode') {
      const t0 = performance.now();
      const r = wasm.decodeIntra(msg.bits);
      const ms = performance.now() - t0;
      const buf = r.rgba.buffer.slice(0) as ArrayBuffer;
      (self as unknown as Worker).postMessage(
        { type: 'decode', id: msg.id, ms, width: r.width, height: r.height, buf },
        { transfer: [buf] },
      );
    }
  } catch (err) {
    post({ type: 'error', id: (msg as any).id, message: (err as Error).message ?? String(err) });
  }
};

function post(msg: unknown) {
  (self as unknown as Worker).postMessage(msg);
}
