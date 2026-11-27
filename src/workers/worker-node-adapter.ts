// Node worker_threads 适配层:让同一份 codec-worker.ts 在 Node 下运行。
// Node 没有 self/postMessage 全局,这里做最小垫片后动态导入 worker 模块。
import { parentPort } from 'node:worker_threads';

if (!parentPort) throw new Error('必须由 worker_threads 启动');

const port = parentPort;
const selfShim: unknown = {
  onmessage: null as null | ((ev: { data: unknown }) => void),
  postMessage: (m: unknown, transfer?: ArrayBuffer[]) => {
    void transfer;
    port.postMessage(m);
  },
};
(globalThis as Record<string, unknown>).self = selfShim;

port.on('message', (data: unknown) => {
  const handler = (selfShim as { onmessage: ((ev: { data: unknown }) => void) | null }).onmessage;
  if (handler) handler({ data });
});

await import('../core/codec-worker.ts');
