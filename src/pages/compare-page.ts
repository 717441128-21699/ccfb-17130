// 并排对比页:原始/解码画面、按秒随机跳转、块叠加、.hvc 下载与通用 WebM 导出
import { state } from '../ui/app-state.ts';
import { el, rgbaToCanvas, overlayClasses } from '../ui/canvas-util.ts';
import { loadWasm } from '../ui/wasm-loader.ts';
import { WasmCodec } from '../core/codec-wasm.ts';
import { DecodeSession } from '../core/pipeline.ts';
import { SynthVideo } from '../core/synth.ts';

export function mount(host: HTMLElement): void {
  if (!state.hvcBytes) {
    host.append(el('div', { class: 'card' }, el('p', {}, '尚无压缩结果,请先在运动区域页运行压缩。')));
    return;
  }
  host.append(
    el('h2', {}, '并排对比'),
    el('p', { class: 'sub' }, '左侧原始画面,右侧解码重建。可跳到任意秒(从最近关键帧链式解码),并叠加块分类。'),
  );

  const w = state.width; const h = state.height;
  const origCanvas = el('canvas', { class: 'cmp-canvas' });
  const decCanvas = el('canvas', { class: 'cmp-canvas' });
  const side = el('div', { class: 'compare-side' },
    el('div', { class: 'cmp-col' }, el('h4', {}, '压缩前(原始)'), origCanvas),
    el('div', { class: 'cmp-col' }, el('h4', {}, '压缩后(解码)'), decCanvas),
  );

  const dur = state.frameCount / state.fps;
  const seek = el('input', { type: 'range', min: '0', max: String(dur), step: String(1 / state.fps), value: '0' }) as HTMLInputElement;
  const timeLabel = el('span', { class: 'hint' }, '0.00 s');
  const overlayToggle = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const seekMs = el('span', { class: 'hint' }, '');

  const controls = el('div', { class: 'card' },
    el('div', { class: 'btn-row' }, el('label', { class: 'inline' }, seek, timeLabel)),
    el('div', { class: 'btn-row' },
      el('label', { class: 'inline' }, overlayToggle, '叠加块分类'),
      seekMs,
    ),
    side,
  );

  const downloadBtn = btn('下载 .hvc 文件', 'secondary', () => {
    const copy = new Uint8Array(state.hvcBytes!);
    const blob = new Blob([copy], { type: 'application/octet-stream' });
    triggerDownload(blob, 'hive-entrance.hvc');
  });
  const webmBtn = btn('导出通用 WebM', 'primary', () => { void exportWebM(); });
  controls.append(el('div', { class: 'btn-row' }, downloadBtn, webmBtn,
    el('span', { class: 'hint' }, 'WebM 可用任意通用播放器/编辑软件打开。')));
  host.append(controls);

  let ds: DecodeSession | null = null;
  let video: SynthVideo | null = null;
  let busy = false;

  async function ensure(): Promise<void> {
    if (ds) return;
    const exports = await loadWasm();
    const codec = new WasmCodec(exports, w, h);
    ds = new DecodeSession(codec, state.hvcBytes!);
    video = new SynthVideo(state.synth!);
  }

  async function showAt(second: number): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await ensure();
      const t0 = performance.now();
      const r = ds!.seek(second);
      const ms = performance.now() - t0;
      const frameNo = r.frameNo;
      const orig = video!.renderFrame(frameNo).rgba;
      rgbaToCanvas(origCanvas, orig, w, h);
      rgbaToCanvas(decCanvas, r.rgba, w, h);
      if (overlayToggle.checked) {
        overlayClasses(origCanvas, r.classes, w, h, true);
        overlayClasses(decCanvas, r.classes, w, h, true);
      }
      timeLabel.textContent = `${second.toFixed(2)} s(帧 ${frameNo},解码链长 ${r.chainLength})`;
      seekMs.textContent = `seek 耗时 ${ms.toFixed(0)} ms`;
    } finally {
      busy = false;
    }
  }

  seek.addEventListener('input', () => { void showAt(Number(seek.value)); });
  overlayToggle.addEventListener('change', () => { void showAt(Number(seek.value)); });
  void showAt(0);

  async function exportWebM(): Promise<void> {
    await ensure();
    webmBtn.setAttribute('disabled', 'true');
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const stream = canvas.captureStream(state.fps);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9' : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: state.rateCfg.maxBitrateKbps * 1000 });
    const chunks: BlobPart[] = [];
    rec.ondataavailable = (e): void => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise<Blob>((resolve) => { rec.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });
    rec.start();
    // 导出前 3 秒(或全部,取小),顺序 YUV 解码后逐帧绘制(避免每帧重复整条 seek 链)
    const exportFrames = Math.min(state.frameCount, state.fps * 3);
    for (let n = 0; n < exportFrames; n++) {
      ds!.decodeYuv(n);
      const rgba = ds!.materializeRgba();
      const clamped = new Uint8ClampedArray(
        rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.length),
      ) as unknown as Uint8ClampedArray<ArrayBuffer>;
      ctx.putImageData(new ImageData(clamped, w, h), 0, 0);
      await new Promise((rq) => setTimeout(rq, 1000 / state.fps));
    }
    rec.stop();
    const blob = await done;
    triggerDownload(blob, 'hive-entrance.webm');
    webmBtn.removeAttribute('disabled');
  }
}

function btn(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { class: `btn ${cls}` }, text) as HTMLButtonElement;
  b.addEventListener('click', () => { try { onClick(); } catch (e) { console.error(e); } });
  return b;
}

function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name }) as HTMLAnchorElement;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
