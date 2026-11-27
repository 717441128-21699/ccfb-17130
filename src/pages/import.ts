// 页面 ①:录像导入。支持合成带标注的巢门录像(多光照 × 蜂流量),
// 也支持导入本地原始 RGB/视频文件抽帧。生成后写入全局状态供后续页面使用。

import { SyntheticVideoGenerator } from '../core/synthetic';
import {
  type BeeTraffic,
  type Lighting,
  type RawFrame,
  type SyntheticConfig,
} from '../core/types';
import { makeCanvas, putRGB } from '../ui/canvas';
import { store } from '../store';

const LIGHTINGS: { value: Lighting; label: string }[] = [
  { value: 'bright', label: '明亮日光' },
  { value: 'overcast', label: '阴天漫射' },
  { value: 'dusk', label: '黄昏弱光' },
];
const TRAFFICS: { value: BeeTraffic; label: string }[] = [
  { value: 'sparse', label: '稀疏(3 只)' },
  { value: 'normal', label: '正常(7 只)' },
  { value: 'dense', label: '密集(14 只)' },
];

export function renderImportPage(): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="card">
      <h2>① 录像导入与合成</h2>
      <p class="hint">
        真实巢门录像一天可达数 TB。这里按几种<b>光照</b>与<b>蜂流量</b>合成带
        逐帧运动标注的测试录像(确定性、可复现),也可导入本地视频抽帧。
      </p>
      <div class="grid-2">
        <label class="field"><span>分辨率</span>
          <select id="f-res">
            <option value="320x240">320 × 240(快速演示)</option>
            <option value="640x480" selected>640 × 480</option>
            <option value="960x544">960 × 544(接近 1080p 比例)</option>
          </select>
        </label>
        <label class="field"><span>帧率(fps)</span>
          <input id="f-fps" type="number" value="200" min="25" max="240" />
        </label>
        <label class="field"><span>帧数</span>
          <input id="f-frames" type="number" value="120" min="8" max="2000" />
        </label>
        <label class="field"><span>随机种子</span>
          <input id="f-seed" type="number" value="42" />
        </label>
        <label class="field"><span>光照条件</span>
          <select id="f-light">${LIGHTINGS.map((l) => `<option value="${l.value}">${l.label}</option>`).join('')}</select>
        </label>
        <label class="field"><span>蜂流量</span>
          <select id="f-traffic">${TRAFFICS.map((t) => `<option value="${t.value}">${t.label}</option>`).join('')}</select>
        </label>
      </div>
      <div style="display:flex;gap:10px;margin-top:8px">
        <button class="btn" id="btn-gen">合成录像</button>
        <button class="btn secondary" id="btn-import">导入本地视频抽帧</button>
        <input type="file" id="file-input" accept="video/*" hidden />
      </div>
      <div class="progress"><div id="prog"></div></div>
      <div id="msg" class="hint"></div>
    </div>
    <div class="card" id="preview-card" hidden>
      <h2>首帧预览</h2>
      <div id="preview"></div>
    </div>
  `;

  el.querySelector<HTMLButtonElement>('#btn-gen')!.onclick = async () => {
    const [w, h] = el.querySelector<HTMLSelectElement>('#f-res')!.value.split('x').map(Number);
    const cfg: SyntheticConfig = {
      width: w,
      height: h,
      frames: Number(el.querySelector<HTMLInputElement>('#f-frames')!.value),
      fps: Number(el.querySelector<HTMLInputElement>('#f-fps')!.value),
      lighting: el.querySelector<HTMLSelectElement>('#f-light')!.value as Lighting,
      traffic: el.querySelector<HTMLSelectElement>('#f-traffic')!.value as BeeTraffic,
      seed: Number(el.querySelector<HTMLInputElement>('#f-seed')!.value),
    };
    await generate(cfg, el);
  };

  el.querySelector<HTMLButtonElement>('#btn-import')!.onclick = () =>
    el.querySelector<HTMLInputElement>('#file-input')!.click();
  el.querySelector<HTMLInputElement>('#file-input')!.onchange = (e) =>
    importVideo((e.target as HTMLInputElement).files?.[0], el);

  return el;
}

async function generate(cfg: SyntheticConfig, el: HTMLElement): Promise<void> {
  const prog = el.querySelector<HTMLDivElement>('#prog')!;
  const msg = el.querySelector<HTMLElement>('#msg')!;
  const gen = new SyntheticVideoGenerator(cfg);
  const frames: RawFrame[] = [];
  const groundTruths: Uint8Array[] = [];
  for (let t = 0; t < cfg.frames; t++) {
    const { frame, groundTruth } = gen.generate(t);
    frames.push(frame);
    groundTruths.push(groundTruth);
    if (t % 4 === 0) {
      prog.style.width = `${((t + 1) / cfg.frames) * 100}%`;
      msg.textContent = `正在合成第 ${t + 1}/${cfg.frames} 帧…`;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  prog.style.width = '100%';
  store.set({
    synthCfg: cfg,
    frames,
    groundTruths,
    analyses: [],
    classMaps: [],
    encodedFile: null,
    summary: null,
  });
  msg.textContent = `已生成 ${cfg.frames} 帧 · ${cfg.width}×${cfg.height} @ ${cfg.fps}fps · ${cfg.lighting}/${cfg.traffic}`;
  showPreview(frames[0], el);
}

function showPreview(frame: RawFrame, el: HTMLElement): void {
  const card = el.querySelector<HTMLElement>('#preview-card')!;
  card.hidden = false;
  const host = el.querySelector<HTMLDivElement>('#preview')!;
  host.innerHTML = '';
  const { canvas, ctx } = makeCanvas(frame.width, frame.height);
  putRGB(ctx, frame);
  host.appendChild(canvas);
}

async function importVideo(file: File | undefined, el: HTMLElement): Promise<void> {
  if (!file) return;
  const msg = el.querySelector<HTMLElement>('#msg')!;
  const video = document.createElement('video');
  video.src = URL.createObjectURL(file);
  video.muted = true;
  await new Promise((r) => (video.onloadedmetadata = r));
  const w = video.videoWidth;
  const h = video.videoHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const frames: RawFrame[] = [];
  const groundTruths: Uint8Array[] = [];
  const mbCols = Math.ceil(w / 16);
  const mbRows = Math.ceil(h / 16);
  const maxFrames = 120;
  for (let i = 0; i < maxFrames; i++) {
    video.currentTime = (i / maxFrames) * video.duration;
    await new Promise((r) => (video.onseeked = r));
    ctx.drawImage(video, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const rgb = new Uint8Array(w * h * 3);
    for (let p = 0, j = 0; p < rgba.length; p += 4, j += 3) {
      rgb[j] = rgba[p];
      rgb[j + 1] = rgba[p + 1];
      rgb[j + 2] = rgba[p + 2];
    }
    frames.push({ width: w, height: h, data: rgb });
    groundTruths.push(new Uint8Array(mbCols * mbRows)); // 导入视频无 ground truth
  }
  URL.revokeObjectURL(video.src);
  const cfg: SyntheticConfig = {
    width: w,
    height: h,
    frames: frames.length,
    fps: 200,
    lighting: 'bright',
    traffic: 'normal',
    seed: 0,
  };
  store.set({ synthCfg: cfg, frames, groundTruths, analyses: [], classMaps: [], encodedFile: null, summary: null });
  msg.textContent = `已从视频抽取 ${frames.length} 帧 · ${w}×${h}(无 ground-truth,运动分析将自动检测)`;
  showPreview(frames[0], el);
}
