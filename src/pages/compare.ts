// 页面 ④:并排对比。从 .hvc 字节用 WASM 解码器随机访问任意帧(测量 seek 延迟),
// 与原始帧并排显示,计算蜜蜂区/背景区/整帧 PSNR,并导出 webm/mjpeg 通用格式。

import { WasmCodec, type HvcDecoder } from '../wasm/codec';
import { regionPsnr } from '../core/metrics';
import { exportMjpeg, exportWebM, downloadBlob } from '../core/exporter';
import { makeCanvas, putRGB } from '../ui/canvas';
import type { RawFrame } from '../core/types';
import { store } from '../store';

export function renderComparePage(): HTMLElement {
  const el = document.createElement('div');
  const s = store.get();
  if (!s.encodedFile || s.frames.length === 0) {
    el.innerHTML = `<div class="card"><h2>④ 并排对比</h2><p class="hint">请先在「③ 码率分配」完成编码。</p></div>`;
    return el;
  }
  const f0 = s.frames[0];
  el.innerHTML = `
    <div class="card">
      <h2>④ 压缩前后并排对比 · 随机访问</h2>
      <p class="hint">
        解码器读取容器尾部的 I 帧索引,二分定位后从最近 I 帧顺序重建,
        可直接跳到任意秒而无需从头解码。每次 seek 的实测耗时显示在下方。
      </p>
      <div class="seek-row">
        <span>时间</span>
        <input type="range" id="seek" min="0" max="${s.frames.length - 1}" value="0" />
        <span id="time-label" class="num">0.000 s</span>
        <button class="btn secondary" id="btn-random">随机跳转</button>
      </div>
      <div id="seek-ms" class="hint" style="margin-top:8px"></div>
    </div>
    <div class="card">
      <div class="canvas-wrap">
        <div class="canvas-box"><canvas id="c-orig"></canvas><div class="canvas-caption">原始帧</div></div>
        <div class="canvas-box"><canvas id="c-dec"></canvas><div class="canvas-caption">压缩后解码帧</div></div>
      </div>
      <table class="metrics" style="margin-top:14px">
        <thead><tr><th>区域</th><th>PSNR(dB)</th><th>说明</th></tr></thead>
        <tbody id="psnr-body"></tbody>
      </table>
    </div>
    <div class="card">
      <h2>导出通用格式</h2>
      <p class="hint">把解码帧序列导出为其他软件可直接打开的 WebM(VP9/VP8)或 MJPEG。</p>
      <div style="display:flex;gap:10px">
        <button class="btn secondary" id="btn-webm">导出 WebM</button>
        <button class="btn secondary" id="btn-mjpeg">导出 MJPEG</button>
      </div>
      <div id="export-msg" class="hint" style="margin-top:8px"></div>
    </div>
  `;

  const cOrig = el.querySelector<HTMLCanvasElement>('#c-orig') as HTMLCanvasElement;
  const cDec = el.querySelector<HTMLCanvasElement>('#c-dec') as HTMLCanvasElement;
  cOrig.width = cDec.width = f0.width;
  cOrig.height = cDec.height = f0.height;
  const ctxOrig = cOrig.getContext('2d')!;
  const ctxDec = cDec.getContext('2d')!;

  let decoder: HvcDecoder | null = null;
  let decodedCache = new Map<number, RawFrame>();

  async function getDecoder(): Promise<HvcDecoder> {
    if (!decoder) {
      const codec = await WasmCodec.create();
      decoder = codec.openDecoder(store.get().encodedFile!);
    }
    return decoder;
  }

  async function seekTo(frameIdx: number): Promise<void> {
    const dec = await getDecoder();
    const state = store.get();
    const t0 = performance.now();
    const rgb = dec.seek(frameIdx);
    const seekMs = performance.now() - t0;
    const decoded: RawFrame = { width: f0.width, height: f0.height, data: rgb };
    decodedCache.set(frameIdx, decoded);

    const orig = state.frames[frameIdx];
    putRGB(ctxOrig, orig);
    putRGB(ctxDec, decoded);
    const mbCols = Math.ceil(f0.width / 16);
    const classMap = state.classMaps[frameIdx] ?? new Uint8Array(mbCols * Math.ceil(f0.height / 16));
    const psnr = regionPsnr(orig, decoded, classMap, mbCols);
    el.querySelector<HTMLTableSectionElement>('#psnr-body')!.innerHTML = `
      <tr><td>蜜蜂所在区域</td><td class="num good">${fmt(psnr.beeRegion)}</td><td>飞行/爬行/花粉块获得更高码率</td></tr>
      <tr><td>静止背景</td><td class="num">${fmt(psnr.background)}</td><td>P 帧零字节跳过,无块状闪烁</td></tr>
      <tr><td>整帧</td><td class="num">${fmt(psnr.wholeFrame)}</td><td>整体保真度</td></tr>
    `;
    const fps = state.synthCfg?.fps ?? 200;
    el.querySelector<HTMLElement>('#time-label')!.textContent = `${(frameIdx / fps).toFixed(3)} s`;
    el.querySelector<HTMLElement>('#seek-ms')!.textContent =
      `随机访问第 ${frameIdx} 帧解码耗时 ${seekMs.toFixed(1)} ms(需求门槛 < 500 ms)`;
  }

  const seek = el.querySelector<HTMLInputElement>('#seek')!;
  seek.oninput = () => seekTo(Number(seek.value));
  el.querySelector<HTMLButtonElement>('#btn-random')!.onclick = () => {
    const idx = Math.floor(Math.random() * s.frames.length);
    seek.value = String(idx);
    seekTo(idx);
  };
  void seekTo(0);

  el.querySelector<HTMLButtonElement>('#btn-webm')!.onclick = async () => {
    const msg = el.querySelector<HTMLElement>('#export-msg')!;
    msg.textContent = '正在解码全部帧并录制 WebM…';
    const dec = await getDecoder();
    const frames: RawFrame[] = [];
    for (let i = 0; i < s.frames.length; i++) {
      frames.push({ width: f0.width, height: f0.height, data: dec.seek(i) });
    }
    const { blob, ext } = await exportWebM(frames, s.synthCfg?.fps ?? 200);
    downloadBlob(blob, `entrance.${ext}`);
    msg.textContent = `已导出 ${ext}(${frames.length} 帧)`;
  };
  el.querySelector<HTMLButtonElement>('#btn-mjpeg')!.onclick = async () => {
    const msg = el.querySelector<HTMLElement>('#export-msg')!;
    msg.textContent = '正在导出 MJPEG…';
    const dec = await getDecoder();
    const frames: RawFrame[] = [];
    for (let i = 0; i < s.frames.length; i++) {
      frames.push({ width: f0.width, height: f0.height, data: dec.seek(i) });
    }
    const { blob, ext } = await exportMjpeg(frames);
    downloadBlob(blob, `entrance.${ext}`);
    msg.textContent = `已导出 ${ext}(${frames.length} 帧)`;
  };

  void makeCanvas;
  void decodedCache;
  return el;
}

function fmt(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : '∞(无差异)';
}
