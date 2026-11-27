// 页面 ②:运动区域。通过 Web Worker 对导入的帧做分块运动分析,
// 展示背景/爬行/飞行/花粉四类区域叠加、各类 MB 数量与背景光照曲线。

import { MotionWorkerClient } from '../workers/client';
import { CLASS_META, MbClass, type AnalysisResult } from '../core/types';
import { drawClassOverlay, putRGB } from '../ui/canvas';
import { store } from '../store';

export function renderMotionPage(): HTMLElement {
  const el = document.createElement('div');
  const s = store.get();
  if (s.frames.length === 0) {
    el.innerHTML = `<div class="card"><h2>② 运动区域</h2><p class="hint">请先在「① 录像导入」生成或导入录像。</p></div>`;
    return el;
  }
  const frame0 = s.frames[0];
  el.innerHTML = `
    <div class="card">
      <h2>② 分块运动分析(Web Worker)</h2>
      <p class="hint">
        背景模型采用时间指数滑动平均,仅在光照变化时加快更新;按 16×16 宏块计算
        前景 SAD,再用块速度与饱和度区分爬行/飞行/花粉团。分析在 Worker 线程,不阻塞界面。
      </p>
      <button class="btn" id="btn-run">运行运动分析</button>
      <div class="progress"><div id="prog"></div></div>
      <div id="msg" class="hint"></div>
    </div>
    <div class="card">
      <div class="legend" id="legend"></div>
      <div class="canvas-wrap" style="margin-top:12px">
        <div class="canvas-box"><canvas id="c-src"></canvas><div class="canvas-caption">原始帧</div></div>
        <div class="canvas-box"><canvas id="c-overlay"></canvas><div class="canvas-caption">运动区域叠加</div></div>
      </div>
      <div class="seek-row" style="margin-top:14px">
        <span>帧</span>
        <input type="range" id="seek" min="0" max="${s.frames.length - 1}" value="0" />
        <span id="seek-label" class="num">0 / ${s.frames.length - 1}</span>
      </div>
    </div>
    <div class="card">
      <h2>分类统计与光照</h2>
      <table class="metrics">
        <thead><tr><th>帧</th><th>背景</th><th>爬行</th><th>飞行</th><th>花粉</th><th>平均亮度</th></tr></thead>
        <tbody id="stat-body"></tbody>
      </table>
    </div>
  `;

  const legend = el.querySelector<HTMLDivElement>('#legend')!;
  legend.innerHTML = (Object.values(MbClass) as number[])
    .filter((c) => typeof c === 'number' && c !== MbClass.Background)
    .map((c) => {
      const meta = CLASS_META[c as MbClass];
      return `<span class="pill"><span class="dot" style="background:${meta.color}"></span>${meta.label}(QP Δ ${meta.qpDelta})</span>`;
    })
    .join('');

  const cSrc = el.querySelector<HTMLCanvasElement>('#c-src') as HTMLCanvasElement;
  const cOver = el.querySelector<HTMLCanvasElement>('#c-overlay') as HTMLCanvasElement;
  cSrc.width = cOver.width = frame0.width;
  cSrc.height = cOver.height = frame0.height;
  const ctxSrc = cSrc.getContext('2d')!;
  const ctxOver = cOver.getContext('2d')!;
  putRGB(ctxSrc, frame0);
  putRGB(ctxOver, frame0);

  let analyses: AnalysisResult[] = s.analyses;
  const seek = el.querySelector<HTMLInputElement>('#seek')!;
  const seekLabel = el.querySelector<HTMLElement>('#seek-label')!;

  function paintFrame(idx: number): void {
    const frame = store.get().frames[idx];
    if (!frame) return;
    putRGB(ctxSrc, frame);
    putRGB(ctxOver, frame);
    const am = analyses[idx];
    if (am) drawClassOverlay(ctxOver, am.classMap, am.mbCols, am.mbRows);
    seekLabel.textContent = `${idx} / ${store.get().frames.length - 1}`;
  }
  seek.oninput = () => paintFrame(Number(seek.value));
  paintFrame(0);

  el.querySelector<HTMLButtonElement>('#btn-run')!.onclick = async () => {
    const frames = store.get().frames;
    const worker = new MotionWorkerClient();
    await worker.init(frames[0].width, frames[0].height);
    const out: AnalysisResult[] = [];
    const prog = el.querySelector<HTMLDivElement>('#prog')!;
    const msg = el.querySelector<HTMLElement>('#msg')!;
    const tbody = el.querySelector<HTMLTableSectionElement>('#stat-body')!;
    for (let i = 0; i < frames.length; i++) {
      const r = await worker.analyze(frames[i]);
      out.push(r);
      prog.style.width = `${((i + 1) / frames.length) * 100}%`;
      if (i % 10 === 0 || i === frames.length - 1) {
        msg.textContent = `Worker 分析第 ${i + 1}/${frames.length} 帧`;
        tbody.insertAdjacentHTML(
          'beforeend',
          `<tr><td class="num">${i}</td><td class="num">${r.counts[MbClass.Background]}</td>` +
            `<td class="num">${r.counts[MbClass.Crawling]}</td><td class="num">${r.counts[MbClass.Flying]}</td>` +
            `<td class="num">${r.counts[MbClass.Pollen]}</td><td class="num">${r.meanLuma.toFixed(1)}</td></tr>`,
        );
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    worker.terminate();
    analyses = out;
    const classMaps = out.map((r) => r.classMap);
    store.set({ analyses: out, classMaps });
    msg.textContent = `分析完成:${frames.length} 帧,类别图已传递给码率分配与编码。`;
    paintFrame(Number(seek.value));
  };

  return el;
}
