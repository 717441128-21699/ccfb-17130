// 通用格式导出:把解码后的帧序列导出为其他软件可打开的标准格式。
//
// 浏览器原生 MediaRecorder 支持 image/jpeg 帧打包为 webm(VP8/VP9),
// 这里用 canvas 逐帧绘制 + CanvasCaptureStream 录制;同时提供
// 不依赖 MediaRecorder 的 MJPEG 容器导出(纯字节拼接,兼容性最广)。

import type { RawFrame } from './types';

function frameToCanvas(frame: RawFrame): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(frame.width, frame.height);
  // RGB -> RGBA
  for (let p = 0, j = 0; p < frame.data.length; p += 3, j += 4) {
    img.data[j] = frame.data[p];
    img.data[j + 1] = frame.data[p + 1];
    img.data[j + 2] = frame.data[p + 2];
    img.data[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** 用 MediaRecorder 把帧录制成 webm(优先 VP9,回退 VP8)。 */
export async function exportWebM(
  frames: RawFrame[],
  fps: number,
): Promise<{ blob: Blob; ext: string; mime: string }> {
  const canvas = frameToCanvas(frames[0]);
  const stream = canvas.captureStream(fps);
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mime = candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);

  const ctx = canvas.getContext('2d')!;
  const done = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  recorder.start();
  const frameMs = 1000 / fps;
  for (const frame of frames) {
    const img = ctx.createImageData(frame.width, frame.height);
    for (let p = 0, j = 0; p < frame.data.length; p += 3, j += 4) {
      img.data[j] = frame.data[p];
      img.data[j + 1] = frame.data[p + 1];
      img.data[j + 2] = frame.data[p + 2];
      img.data[j + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    await new Promise((r) => setTimeout(r, frameMs));
  }
  recorder.stop();
  await done;
  stream.getTracks().forEach((t) => t.stop());
  return { blob: new Blob(chunks, { type: mime }), ext: 'webm', mime };
}

/** 导出为 MJPEG(.mjpeg):每帧 JPEG + 简单长度前缀,通用且无额外依赖。 */
export async function exportMjpeg(frames: RawFrame[]): Promise<{ blob: Blob; ext: string; mime: string }> {
  const parts: BlobPart[] = [];
  for (const frame of frames) {
    const canvas = frameToCanvas(frame);
    const jpeg: Blob = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.9),
    );
    const buf = await jpeg.arrayBuffer();
    const hdr = new Uint8Array(8);
    new DataView(hdr.buffer).setUint32(0, 0x4d4a5047, false); // "MJPG"
    new DataView(hdr.buffer).setUint32(4, buf.byteLength, false);
    parts.push(hdr, new Uint8Array(buf));
  }
  return {
    blob: new Blob(parts, { type: 'video/x-mjpeg' }),
    ext: 'mjpeg',
    mime: 'video/x-mjpeg',
  };
}

/** 触发浏览器下载。 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
