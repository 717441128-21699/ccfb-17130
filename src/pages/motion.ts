import { studio } from '../studio';
import { CLASS_COLORS, CLASS_LABELS } from '../lib/types';
import { h, toast } from '../ui/dom';
import type { AnalyzeResponse } from '../workers/analysis.worker';

export function renderMotion(root: HTMLElement) {
  root.innerHTML = '';
  const s = studio.settings;

  const stageCard = h('div', { class: 'card' },
    h('h2', {}, '分块运动分析'),
    h('p', { class: 'hint' }, 'Web Worker 对 16×16 块计算帧间 SAD、相对稳定底板的前景占比与花粉色度，自适应噪声阈值后分成背景 / 爬行 / 快速 / 花粉四类。'),
  );
  const wrap = h('div', { class: 'canvas-wrap' });
  const base = h('canvas', { width: s.width, height: s.height });
  const overlay = h('canvas', { width: s.width, height: s.height, class: 'overlay' }) as HTMLCanvasElement;
  overlay.style.position = 'absolute'; overlay.style.inset = '0'; overlay.style.width = '100%'; overlay.style.height = '100%';
  wrap.append(base, overlay);
  stageCard.append(wrap);

  const legend = h('div', { class: 'legend' },
    ...CLASS_LABELS.map((label, i) => h('span', { html: `<i style="background:${CLASS_COLORS[i]}"></i>${label}` })),
    h('span', { html: '<i style="background:linear-gradient(90deg,#14506b,#ff7a3d)"></i>框越亮 = 码率权重越高' }),
  );
  stageCard.append(legend);

  const side = h('div', { class: 'grid' });
  const ctrl = h('div', { class: 'card' }, h('h2', {}, '分析控制'));

  const sourceSeg = h('select') as HTMLSelectElement;
  sourceSeg.append(h('option', { value: 'worker' }, 'Web Worker 自动分析'));
  sourceSeg.append(h('option', { value: 'gt' }, '合成真实标注（Ground Truth）'));
  sourceSeg.value = studio.allocationSource;
  sourceSeg.addEventListener('change', () => { studio.allocationSource = sourceSeg.value as any; });

  const overlayMode = h('select') as HTMLSelectElement;
  overlayMode.append(h('option', { value: 'class' }, '类别色块'));
  overlayMode.append(h('option', { value: 'weight' }, '码率权重热力'));
  overlayMode.append(h('option', { value: 'motion' }, '运动强度'));

  const opacity = h('input', { type: 'range', min: '0', max: '90', value: '38' }) as HTMLInputElement;
  const opVal = h('b', {}, '38%');
  opacity.addEventListener('input', () => { opVal.textContent = opacity.value + '%'; drawOverlay(); });

  const analyzeBtn = h('button', { class: 'btn primary' }, '在 Worker 中分析当前帧');
  analyzeBtn.addEventListener('click', async () => {
    try {
      await studio.analyzeCurrent();
      sourceSeg.value = 'worker'; studio.allocationSource = 'worker';
      drawOverlay(); renderStats();
      toast('分块分析完成', 'good');
    } catch (e) { toast('分析失败：' + (e as Error).message, 'bad'); }
  });

  const gtBtn = h('button', { class: 'btn' }, '显示真实标注块');
  gtBtn.addEventListener('click', () => {
    studio.allocationSource = 'gt'; sourceSeg.value = 'gt';
    if (!studio.frame) studio.renderCurrent();
    const gt = studio.synth?.gtWeights(studio.frame!.mask);
    if (gt) {
      // Build a lightweight analysis-shaped object for overlay.
      studio.analysis = {
        type: 'analysis', frameId: studio.frameIndex, gridW: gt.gridW, gridH: gt.gridH, block: 16,
        cls: gt.classes, weights: gt.weights,
        motion: new Float32Array(gt.weights.length), foreground: new Float32Array(gt.weights.length),
        pollen: new Float32Array(gt.weights.length), persistence: new Float32Array(gt.weights.length),
      } as AnalyzeResponse;
      drawOverlay(); renderStats(); toast('已套用合成真实运动标注', 'good');
    }
  });

  const frameSlider = h('input', { type: 'range', min: '0', max: String(s.durationSeconds * s.fps - 1), value: String(studio.frameIndex) }) as HTMLInputElement;
  frameSlider.addEventListener('input', () => { studio.frameIndex = +frameSlider.value; paintFrame(); });
  frameSlider.addEventListener('change', () => { studio.analysis = null; drawOverlay(); renderStats(); });

  ctrl.append(
    h('label', { class: 'field' }, h('span', {}, 'ROI 权重来源'), sourceSeg),
    h('label', { class: 'field' }, h('span', {}, '叠加显示'), overlayMode),
    h('label', { class: 'field' }, h('span', {}, '不透明度'), opacity, h('span', { style: 'justify-content:flex-end' }, opVal)),
    h('label', { class: 'field' }, h('span', {}, '帧'), frameSlider),
    h('div', { class: 'row' }, analyzeBtn, gtBtn),
  );

  const statsCard = h('div', { class: 'card' }, h('h2', {}, '块统计'));
  const statsBody = h('div', { class: 'stat-grid' });
  statsCard.append(statsBody, h('div', { id: 'classbars', class: 'mt16' }));
  side.append(ctrl, statsCard);

  root.append(h('div', { class: 'grid cols-2' }, side, stageCard));

  overlayMode.addEventListener('change', drawOverlay);

  function paintFrame() {
    const f = studio.renderCurrent();
    if (base.width !== s.width) { base.width = s.width; overlay.width = s.width; base.height = s.height; overlay.height = s.height; }
    const ctx = base.getContext('2d')!;
    const img = ctx.createImageData(s.width, s.height);
    img.data.set(f.rgba); ctx.putImageData(img, 0, 0);
    drawOverlay();
  }

  function drawOverlay() {
    const ctx = overlay.getContext('2d')!;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const a = +opacity.value / 100;
    const an = studio.analysis;
    if (!an) return;
    const B = an.block ?? 16;
    const mode = overlayMode.value;
    for (let by = 0; by < an.gridH; by++) {
      for (let bx = 0; bx < an.gridW; bx++) {
        const i = by * an.gridW + bx;
        let color = CLASS_COLORS[an.cls[i]];
        if (mode === 'weight') {
          const t = Math.min(1, an.weights[i] / 5);
          color = t < 0.25 ? `rgba(65,214,255,${0.15 + t})` : `rgba(255,122,61,${0.25 + t * 0.6})`;
        } else if (mode === 'motion') {
          const t = Math.min(1, (an.motion?.[i] ?? 0) / 18);
          color = `rgba(65,214,255,${t})`;
        }
        ctx.fillStyle = color;
        ctx.globalAlpha = mode === 'class' ? a : 0.55;
        ctx.fillRect(bx * B, by * B, B, B);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx * B + 0.5, by * B + 0.5, B - 1, B - 1);
      }
    }
    // Emphasise ROI borders.
    ctx.strokeStyle = 'rgba(255,197,49,0.9)'; ctx.lineWidth = 1.5;
    for (let i = 0; i < an.gridW * an.gridH; i++) {
      if (an.weights[i] >= 2) {
        const bx = i % an.gridW, by = (i / an.gridW) | 0;
        ctx.strokeRect(bx * B + 1, by * B + 1, B - 2, B - 2);
      }
    }
  }

  function renderStats() {
    statsBody.innerHTML = '';
    const an = studio.analysis;
    if (!an) {
      statsBody.append(h('p', { class: 'hint' }, '尚未分析。点击“在 Worker 中分析当前帧”或“显示真实标注块”。'));
      return;
    }
    const counts = [0, 0, 0, 0];
    for (const c of an.cls) counts[c]++;
    const items: [string, string, string?][] = [
      ['宏块网格', `${an.gridW}×${an.gridH}`],
      ['背景块', String(counts[0])],
      ['爬行块', String(counts[1])],
      ['快速块', String(counts[2])],
      ['花粉块', String(counts[3])],
      ['ROI 占比', `${(100 * (counts[1] + counts[2] + counts[3]) / (an.gridW * an.gridH)).toFixed(1)}%`],
    ];
    for (const [k, v] of items) statsBody.append(h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v', style: 'font-size:18px' }, v)));
    const bars = document.getElementById('classbars')!;
    bars.innerHTML = '';
    const total = an.gridW * an.gridH;
    CLASS_LABELS.forEach((label, i) => {
      const pct = (100 * counts[i] / total).toFixed(1);
      bars.append(
        h('div', { class: 'mb8' },
          h('div', { class: 'row', style: 'justify-content:space-between;font-size:12.5px' },
            h('span', {}, label), h('span', { class: 'mono muted' }, `${counts[i]} · ${pct}%`)),
          h('div', { class: 'progress' }, h('i', { style: `width:${pct}%;background:${CLASS_COLORS[i]}` })),
        ),
      );
    });
  }

  studio.subscribe(() => { if (studio.analyzing) analyzeBtn.textContent = '分析中…'; else analyzeBtn.textContent = '在 Worker 中分析当前帧'; });

  paintFrame();
  renderStats();
}
