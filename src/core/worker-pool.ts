// 双端 Worker 池:浏览器用 module Worker,Node 用 worker_threads(经适配层)。
// 分块运动分析按块行并行;编码状态机保序,由调用方固定投递到同一 worker。
// Node 的 worker_threads 仅在 Node 分支动态 import,浏览器打包不会触碰。

import type { AnalyzeResult, AnalyzeTask, EncodeInit, EncodeResult, EncodeTask } from './codec-worker.ts';
import type { AnalyzeParams } from './types.ts';

export type WorkerMessage = AnalyzeResult | EncodeResult | { kind: 'ready' };

// 浏览器 Worker 与 Node worker_threads.Worker 的最小公共形状
type AnyWorker = {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  on?(event: 'message', cb: (msg: WorkerMessage) => void): void;
};

interface PoolEntry {
  worker: AnyWorker;
  busy: boolean;
  encodeCb: ((r: EncodeResult) => void) | null;
}

const isNode = typeof globalThis.Worker === 'undefined';

export class WorkerPool {
  private entries: PoolEntry[] = [];
  private queue: { task: AnalyzeTask; resolve: (r: AnalyzeResult) => void }[] = [];
  readonly size: number;
  private readyResolve: (() => void) | null = null;
  private readyCount = 0;
  private pendingAnalyze = new Map<number, (r: AnalyzeResult) => void>();
  private analyzeId = 0;

  private constructor(size: number) {
    this.size = size;
  }

  static async create(wasmBytes: Uint8Array, size: number): Promise<WorkerPool> {
    const pool = new WorkerPool(size);
    const ready = new Promise<void>((resolve) => { pool.readyResolve = resolve; });
    const initMsg: EncodeInit = { kind: 'init', wasm: wasmBytes.slice().buffer };
    for (let i = 0; i < size; i++) {
      const worker = await pool.makeWorker();
      const entry: PoolEntry = { worker, busy: false, encodeCb: null };
      pool.entries.push(entry);
      pool.wire(entry);
      worker.postMessage(initMsg);
    }
    await ready;
    return pool;
  }

  private async makeWorker(): Promise<AnyWorker> {
    if (!isNode) {
      return new Worker(new URL('./codec-worker.ts', import.meta.url), { type: 'module' }) as unknown as AnyWorker;
    }
    // Node 分支动态加载,避免浏览器打包解析 node: 内置模块
    const { Worker: NodeWorker } = await import('node:worker_threads');
    return new NodeWorker(new URL('../workers/worker-node-adapter.ts', import.meta.url), {
      execArgv: ['--experimental-strip-types', '--no-warnings'],
    }) as unknown as AnyWorker;
  }

  private wire(entry: PoolEntry): void {
    const onMsg = (msg: WorkerMessage): void => {
      if (msg.kind === 'ready') {
        this.readyCount += 1;
        if (this.readyCount === this.size) this.readyResolve?.();
        return;
      }
      if (msg.kind === 'analyze') {
        entry.busy = false;
        this.pendingAnalyze.get(msg.id)?.(msg);
        this.pendingAnalyze.delete(msg.id);
        const next = this.queue.shift();
        if (next) this.dispatch(entry, next.task, next.resolve);
        return;
      }
      if (msg.kind === 'encode') {
        entry.encodeCb?.(msg);
      }
    };
    if (!isNode) {
      entry.worker.onmessage = (ev: MessageEvent): void => onMsg(ev.data as WorkerMessage);
    } else {
      // Node worker_threads 的 EventEmitter 接口
      (entry.worker as unknown as { on: (e: string, cb: (m: WorkerMessage) => void) => void })
        .on('message', onMsg);
    }
  }

  private dispatch(
    entry: PoolEntry,
    task: AnalyzeTask,
    resolve: (r: AnalyzeResult) => void,
  ): void {
    entry.busy = true;
    this.pendingAnalyze.set(task.id, resolve);
    entry.worker.postMessage(task);
  }

  /** 提交分块分析任务,自动调度到空闲 worker */
  submitAnalyze(task: Omit<AnalyzeTask, 'id'>): Promise<AnalyzeResult> {
    const id = ++this.analyzeId;
    const full = { ...task, id } as AnalyzeTask;
    return new Promise<AnalyzeResult>((resolve) => {
      const free = this.entries.find((e) => !e.busy);
      if (free) this.dispatch(free, full, resolve);
      else this.queue.push({ task: full, resolve });
    });
  }

  /**
   * 分块运动分析便捷方法:把整帧按块行切成 chunks 投递给空闲 worker 并行,
   * 合并返回完整的 classes / sads 数组。
   */
  async analyzeFrameChunks(
    width: number,
    height: number,
    planes: { bgY: ArrayBuffer; curY: ArrayBuffer; curU: ArrayBuffer; curV: ArrayBuffer },
    params: AnalyzeTask['params'],
    chunks?: number,
  ): Promise<{ classes: Uint8Array; sads: Uint32Array }> {
    const nbw = width / 8;
    const nbh = height / 8;
    const nChunks = Math.max(1, Math.min(chunks ?? this.size, nbh));
    const rowsPer = Math.ceil(nbh / nChunks);
    const promises: Promise<AnalyzeResult>[] = [];
    for (let k = 0; k < nChunks; k++) {
      const rowStart = k * rowsPer;
      const rowEnd = Math.min(nbh, rowStart + rowsPer);
      if (rowStart >= rowEnd) break;
      promises.push(this.submitAnalyze({
        kind: 'analyze',
        width, height, rowStart, rowEnd,
        bgY: planes.bgY, curY: planes.curY,
        curU: planes.curU, curV: planes.curV,
        params,
      }));
    }
    const results = await Promise.all(promises);
    const classes = new Uint8Array(nbw * nbh);
    const sads = new Uint32Array(nbw * nbh);
    for (const r of results.sort((a, b) => a.rowStart - b.rowStart)) {
      classes.set(new Uint8Array(r.classes), r.rowStart * nbw);
      sads.set(new Uint32Array(r.sads), r.rowStart * nbw);
    }
    return { classes, sads };
  }

  /** 固定 worker 上的保序编码通道 */
  encodeChannel(workerIndex = 0): {
    send: (task: EncodeTask) => void;
    onResult: (cb: (r: EncodeResult) => void) => void;
  } {
    const entry = this.entries[workerIndex];
    return {
      send: (task: EncodeTask) => entry.worker.postMessage(task),
      onResult: (cb) => { entry.encodeCb = cb; },
    };
  }

  terminate(): void {
    for (const e of this.entries) void e.worker.terminate();
  }
}
