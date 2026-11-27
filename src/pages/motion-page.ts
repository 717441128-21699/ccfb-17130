// 运动区域页:分块运动分析结果可视化 + 触发编码
import { state, navigate } from '../ui/app-state.ts';
import { el, rgbaToCanvas, overlayClasses, classLegend } from '../ui/canvas-util.ts';
import { loadWasm } from '../ui/wasm-loader.ts';
import { WasmCodec } from '../core/codec-wasm.ts';
import { EncodeSession } from '../core/pipeline.ts';
import { SynthVideo } from '../core/synth.ts';
import { WorkerPool } from '../core/worker-pool.ts';
import { CLASS_NAMES } from '../core/types.ts';

export function mount(host: HTMLElement): void {
  if (!state.synth) {
    host.append(el('div', { class: 'card' }, el('p', {}, '请先在录像导入页选择或合成录像。')));
    return;
 }
  const cfg = state.synth;
  host.append(
    el('h2', {}, '运动区域分析'),
    el('p', { class: 'sub' }, `8×8 块分类:静止背景 / 爬行 / 快速飞行 / 携粉。${cfg.width}×${cfg.height} @ ${cfg.fps}fps,${cfg.frames} 帧。`),
  );

  const card = el('div', { class: 'card' });
  const canvas = el('canvas', { class: 'frame-canvas' });
  const toggle = el('input', { type: 'checkbox' }) as HTMLInputElement;
  toggle.checked = true;
  const toggleLabel = el('label', { class: 'inline' }, toggle, '叠加块分类遮罩');
  const stats = el('div', { class: 'stats' });
  const progress = el('div', { class: 'progress' }, el('div', { class: 'progress-bar' }));
  const status = el('div', { class: 'hint' }, '就绪。');
  card.append(el('div', { class: 'btn-row' }, toggleLabel), canvas, stats, progress, status);
  host.append(card, el('div', { class: 'card legend' }, el('div', { class: 'legend-row' }, classLegend() as unknown as string)));

  let lastClasses: Uint8Array | null = null;
  let lastRgba: Uint8Array | null = null;
  let running = false;

  const runBtn = el('button', { class: 'btn primary' }, '运行分析并压缩') as HTMLButtonElement;
  card.querySelector('.btn-row')!.append(runBtn);
  const toRate = el('button', { class: 'btn secondary', disabled: 'true' }, '前往码率分配') as HTMLButtonElement;
  card.querySelector('.btn-row')!.append(toRate);
  toRate.addEventListener('click', () => navigate('rate'));

  runBtn.addEventListener('click', async () => {
    if (running) return;
    running = true;
    runBtn.setAttribute('disabled', 'true');
    try {
      const exports = await loadWasm();
      const codec = new WasmCodec(exports, cfg.width, cfg.height);
      const video = new SynthVideo(cfg);

      // Web Worker 分块运动分析演示:首帧按块行并行分析
      const poolSize = Math.min(4, navigator.hardwareConcurrency || 2);
      const pool = await WorkerPool.create(
        new Uint8Array(await (await fetch('/wasm/hive_codec.wasm')).arrayBuffer()),
        poolSize,
      );
      // 用帧0建立背景,帧1做并行分块分析
      codec.rgbaToYuv(video.renderFrame(0).rgba);
      const bgFrame = codec.encodeKeyframe(30);
      codec.decodeKeyframe(bgFrame);
      codec.copyDecToBackground();
      codec.rgbaToYuv(video.renderFrame(1).rgba);
      const planes = codec.yuvPlaneBuffers();
      const wt0 = performance.now();
      const workerResult = await pool.analyzeFrameChunks(
        cfg.width, cfg.height, planes, state.analyzeCfg, poolSize,
      );
      const workerMs = performance.now() - wt0;
      pool.terminate();
      const workerActive = [...workerResult.classes].filter((x) => x !== 0).length;
      status.textContent = `Worker 分块分析(${poolSize} 线程)耗时 ${workerMs.toFixed(1)}ms,活动块 ${workerActive}`;

      const session = new EncodeSession(
        codec, cfg.fps, state.rateCfg, state.analyzeCfg, state.mode,
      );
      session.psnrEvery = Math.max(25, Math.floor(cfg.frames / 40));
      state.originalFrames.clear();

      const bar = progress.querySelector('.progress-bar') as HTMLElement;
      const t0 = performance.now();
      const classTotals = [0, 0, 0, 0];
      let sampleFrame = 0;

      for (let n = 0; n < cfg.frames; n++) {
        const { rgba } = video.renderFrame(n);
        const r = session.pushFrame(rgba);
        for (const c of r.classes) classTotals[c]++;
        if (n === Math.floor(cfg.frames / 2)) {
          sampleFrame = n;
          lastRgba = rgba.slice();
          lastClasses = r.classes;
        }
        if (n % Math.max(1, Math.floor(cfg.frames / 100)) === 0) {
          bar.style.width = `${(n / cfg.frames) * 100}%`;
          status.textContent = `编码中 ${n}/${cfg.frames} … 关键帧 ${session.keyframes}`;
          await new Promise((rq) => setTimeout(rq, 0));
        }
      }
      bar.style.width = '100%';

      const hvc = session.finish();
      const ms = performance.now() - t0;
      state.hvcBytes = hvc;
      state.width = cfg.width; state.height = cfg.height;
      state.fps = cfg.fps; state.frameCount = cfg.frames;
      state.totalBytes = session.totalBytes; state.encodeMs = ms;
      state.psnr = session.avgPsnr();
      state.originalFrames.set(sampleFrame, lastRgba!);

      if (lastRgba) {
        rgbaToCanvas(canvas, lastRgba, cfg.width, cfg.height);
        const draw = (): void => {
          rgbaToCanvas(canvas, lastRgba!, cfg.width, cfg.height);
          if (toggle.checked && lastClasses) overlayClasses(canvas, lastClasses, cfg.width, cfg.height, true);
        };
        draw();
        toggle.onchange = draw;
      }

      const total = classTotals.reduce((a, b) => a + b, 0) || 1;
      stats.innerHTML = CLASS_NAMES.map((name, i) =>
        `<div class="stat"><b>${name}</b><span>${(classTotals[i] / total * 100).toFixed(1)}%</span></div>`,
      ).join('') + `<div class="stat"><b>关键帧</b><span>${session.keyframes}</span></div>`;
      status.textContent = `完成:${(hvc.length / 1024).toFixed(1)}KB,用时 ${(ms / 1000).toFixed(1)}s`;
      toRate.removeAttribute('disabled');
    } catch (e) {
      status.textContent = `失败:${(e as Error).message}`;
      console.error(e);
    } finally {
      running = false;
      runBtn.removeAttribute('disabled');
    }
  });
}
