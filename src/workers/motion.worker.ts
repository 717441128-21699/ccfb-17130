// 运动分析 Web Worker:优先使用 WASM 原生分析器(高吞吐),
// 不可用时回退到纯 TS MotionAnalyzer。Worker 线程不阻塞 UI。

import { MotionAnalyzer } from '../core/motion';
import { WasmCodec } from '../wasm/codec';
import type { AnalysisResult, RawFrame } from '../core/types';
import { MB } from '../core/types';

export type WorkerRequest =
  | { type: 'init'; width: number; height: number }
  | { type: 'analyze'; frame: RawFrame }
  | { type: 'reset' };

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; result: AnalysisResult; index: number }
  | { type: 'error'; message: string };

let tsAnalyzer: MotionAnalyzer | null = null;
let wasmAnalyzer: Awaited<ReturnType<typeof getWasmAnalyzer>> | null = null;
let index = 0;

async function getWasmAnalyzer(w: number, h: number) {
  const codec = await WasmCodec.create();
  return codec.createMotionAnalyzer(w, h);
}

function emptyCounts(): [number, number, number, number] {
  return [0, 0, 0, 0];
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init' || msg.type === 'reset') {
      tsAnalyzer = null;
      wasmAnalyzer = null;
      index = 0;
      const res: WorkerResponse = { type: 'ready' };
      self.postMessage(res);
      return;
    }
    if (msg.type === 'analyze') {
      const frame = msg.frame;
      // 懒初始化:先尝试 WASM,失败回退 TS
      const respond = (classMap: Uint8Array) => {
        const counts = emptyCounts();
        let lumaSum = 0;
        for (let p = 0; p < frame.width * frame.height; p++) {
          const i = p * 3;
          lumaSum += (19595 * frame.data[i] + 38470 * frame.data[i + 1] + 7471 * frame.data[i + 2] + 32768) >> 16;
        }
        for (const c of classMap) counts[c]++;
        const result: AnalysisResult = {
          classMap,
          mbCols: Math.ceil(frame.width / MB),
          mbRows: Math.ceil(frame.height / MB),
          counts: counts as unknown as Record<number, number> as AnalysisResult['counts'],
          meanLuma: lumaSum / (frame.width * frame.height),
        };
        const res: WorkerResponse = { type: 'result', result, index: index++ };
        self.postMessage(res, { transfer: [classMap.buffer] });
      };

      if (!wasmAnalyzer && !tsAnalyzer) {
        getWasmAnalyzer(frame.width, frame.height)
          .then((an) => {
            wasmAnalyzer = an;
            respond(an.analyze(frame.data));
          })
          .catch(() => {
            tsAnalyzer = new MotionAnalyzer(frame.width, frame.height);
            respond(tsAnalyzer.analyze(frame).classMap);
          });
        return;
      }
      if (wasmAnalyzer) {
        respond(wasmAnalyzer.analyze(frame.data));
      } else if (tsAnalyzer) {
        respond(tsAnalyzer.analyze(frame).classMap);
      }
    }
  } catch (err) {
    const res: WorkerResponse = {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(res);
  }
};
