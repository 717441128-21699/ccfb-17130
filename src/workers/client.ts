// 运动分析 Worker 的 Promise 化客户端封装,供 UI 页面调用。

import MotionWorker from '../workers/motion.worker.ts?worker';
import type { AnalysisResult, RawFrame } from '../core/types';
import type { WorkerRequest, WorkerResponse } from '../workers/motion.worker';

export class MotionWorkerClient {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, (r: WorkerResponse) => void>();

  constructor() {
    this.worker = new MotionWorker();
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const res = ev.data;
      // ready/error 之外的 result 携带递增 index,这里用 seq 配对
      const cb = this.pending.get(this.seq);
      if (cb) {
        this.pending.delete(this.seq);
        cb(res);
      }
    };
  }

  private send(msg: WorkerRequest): Promise<WorkerResponse> {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage(msg);
    });
  }

  init(width: number, height: number): Promise<WorkerResponse> {
    return this.send({ type: 'init', width, height });
  }

  analyze(frame: RawFrame): Promise<AnalysisResult> {
    // 拷贝一份以避免 transfer 掉调用方仍在使用的 buffer
    const copy: RawFrame = { ...frame, data: new Uint8Array(frame.data) };
    return this.send({ type: 'analyze', frame: copy }).then((r) => {
      if (r.type === 'error') throw new Error(r.message);
      if (r.type !== 'result') throw new Error('意外的 Worker 响应');
      return r.result;
    });
  }

  reset(): Promise<WorkerResponse> {
    return this.send({ type: 'reset' });
  }

  terminate(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}
