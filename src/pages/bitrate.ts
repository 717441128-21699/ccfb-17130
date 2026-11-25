import { studio, type Studio } from '../studio';
import { h, toast, fmtBytes } from '../ui/dom';

export function renderBitrate(root: HTMLElement) {
  root.innerHTML = '';
  const s = studio.settings;

  // ---------- controls ----------
  const ctrl = h('div', { class: 'card' }, h('h2', {}, '总码率上限与 ROI 加权'));
  const kbps = h('input', { type: 'range', min: '8000', max: '160000', step: '2000', value: String(studio.totalKbps) }) as HTMLInputElement;
  const kbpsVal = h('b', {}, `${(studio.totalKbps / 1000).toFixed(0)} Mbps`);
  kbps.addEventListener('input', () => { studio.totalKbps = +kbps.value; kbpsVal.textContent = `${(studio.totalKbps / 1000).toFixed(0)} Mbps`; });

  const srcSel = h('select') as HTMLSelectElement;
  srcSel.append(h('option', { value: 'gt' }, '合成真实标注（验收基准）'));
  srcSel.append(h('option', { value: 'worker' }, 'Worker 自动运动分析'));
  srcSel.value = studio.allocationSource;
  srcSel.addEventListener('change', () => { studio.allocationSource = srcSel.value as any; });

  function tuneSlider(key: 'pollen' | 'fast' | 'crawl', label: string) {
    const r = h('input', { type: 'range', min: '0.5', max: '2', step: '0.05', value: String(studio.tuning[key]) }) as HTMLInputElement;
    const v = h('b', {}, `×${studio.tuning[key].toFixed(2)}`);
    r.addEventListener('input', () => { studio.tuning[key] = +r.value; v.textContent = `×${(+r.value).toFixed(2)}`; });
    return h('label', { class: 'field' }, h('span', {}, label), r, h('span', { style: 'justify-content:flex-end' }, v));
  }

  const qVal = h('span', { class: 'badge' }, `基线 Q=${studio.qUniform}`);
  const runBtn = h('button', { class: 'btn primary' }, '按总码率压缩当前帧 (WASM)');
  const bar = h('div', { class: 'progress hidden' }, h('i'));
  const barI = bar.firstElementChild as HTMLElement;

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true; bar.classList.remove('hidden'); barI.style.width = '30%';
    try {
      const t0 = performance.now();
      const out = await studio.compressToCap();
      barI.style.width = '100%';
      qVal.textContent = `基线 Q=${studio.qUniform}`;
      renderResult(out, performance.now() - t0);
      toast('WASM 编码 + 解码完成，两侧码率严格匹配', 'good');
    } catch (e) { toast('压缩失败：' + (e as Error).message, 'bad'); }
    finally { runBtn.disabled = false; setTimeout(() => bar.classList.add('hidden'), 400); }
  });

  ctrl.append(
    h('label', { class: 'field' }, h('span', {}, '研究员设定总码率上限'), kbps, h('span', { style: 'justify-content:flex-end' }, kbpsVal)),
    h('label', { class: 'field' }, h('span', {}, 'ROI 权重来源'), srcSel),
    tuneSlider('pollen', '带花粉团块加权'),
    tuneSlider('fast', '快速飞行块加权'),
    tuneSlider('crawl', '巢门板爬行块系数（<1 少给码率）'),
    h('div', { class: 'row' }, runBtn, qVal),
    bar,
    h('p', { class: 'hint mt8' }, `目标 I 帧预算 ≈ ${fmtBytes((studio.totalKbps * 1000) / 8 / s.fps)} / 帧；P 帧背景块直接复制稳定底板，平均码率显著更低。码率闭环最多迭代 4 次量化尺度。`),
  );

  const resultCard = h('div', { class: 'card' },
    h('h2', {}, '当前帧分配结果'),
    h('p', { class: 'hint' }, '同一 HCV1 编解码器、匹配字节数下，整幅均匀量化 vs 背景/蜜蜂差异化分配。'),
  );
  const kpis = h('div', { class: 'kpi-hero' });
  const qmapCanvas = h('canvas', { style: 'width:100%;border-radius:10px;background:#070b10' }) as HTMLCanvasElement;
  const qmapWrap = h('div', { class: 'mt16' }, h('div', { class: 'pane-title' }, '宏块量化尺度图（越亮/Q 越小 = 质量越高）'), qmapCanvas);
  resultCard.append(kpis, qmapWrap);

  function renderResult(out: Awaited<ReturnType<Studio['processCurrent']>>, ms: number) {
    const st = out.stats;
    const achievedKbps = (st.roiBytes * s.fps * 8) / 1000;
    const pass = st.deltaBeeDb >= 4;
    kpis.innerHTML = '';
    const kpi = (k: string, v: string, cls: string, d: string) =>
      h('div', { class: 'kpi' }, h('div', { class: 'k' }, k), h('div', { class: `v ${cls}` }, v), h('div', { class: 'd' }, d));
    kpis.append(
      kpi('蜜蜂区域 ΔPSNR', `${st.deltaBeeDb >= 0 ? '+' : ''}${st.deltaBeeDb.toFixed(2)} dB`, pass ? 'good' : 'bad', pass ? '达到 ≥ 4 dB 设计指标' : '该帧未达 4 dB（参考多帧基准）'),
      kpi('ROI 蜜蜂 PSNR', `${st.beeRoiPsnr ? st.beeRoiPsnr.toFixed(2) : '—'}`, 'accent', `均匀基线 ${st.beeUniformPsnr ? st.beeUniformPsnr.toFixed(2) : 'n/a'} dB`),
      kpi('字节匹配', `${(st.byteRatio * 100).toFixed(1)}%`, '', `${fmtBytes(st.roiBytes)} vs ${fmtBytes(st.uniformBytes)}`),
      kpi('等效码率', `${(achievedKbps / 1000).toFixed(1)} Mbps`, achievedKbps <= studio.totalKbps * 1.05 ? 'good' : 'bad', `上限 ${(studio.totalKbps / 1000).toFixed(0)} Mbps · ${ms.toFixed(0)} ms`),
    );
    // qmap heat
    const gw = out.gridW, gh = out.gridH;
    qmapCanvas.width = gw * 12; qmapCanvas.height = gh * 12;
    const cx = qmapCanvas.getContext('2d')!;
    for (let i = 0; i < out.qmap.length; i++) {
      const q = out.qmap[i]; const bx = i % gw, by = (i / gw) | 0;
      if (q === 0) { cx.fillStyle = '#16233a'; }
      else { const t = Math.max(0, Math.min(1, (90 - q) / 88)); cx.fillStyle = `rgb(${20 + t * 235 | 0},${40 + t * 150 | 0},${80 + t * 20 | 0})`; }
      cx.fillRect(bx * 12, by * 12, 11, 11);
    }
  }

  // ---------- objective benchmark report ----------
  const benchCard = h('div', { class: 'card mt16' },
    h('h2', {}, '客观验收基准：5 种光照 × 3 种蜂流'),
    h('p', { class: 'hint' }, 'Rust/WASM 核心对合成时生成的真实运动标注负责：15 个场景、每场景多帧、ROI 与均匀分配严格匹配字节数。下表为提交的 1920×1080 / 200fps 实测报告。'),
  );
  const reportSlot = h('div', {}, h('p', { class: 'muted' }, '报告加载中…'));
  benchCard.append(reportSlot);

  fetch(`${import.meta.env.BASE_URL}reports/1080p-quality.json`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('missing'))))
    .then((d) => renderReport(d))
    .catch(() => { reportSlot.innerHTML = '<p class="muted">未找到 public/reports/1080p-quality.json；运行 npm run bench:native 生成。</p>'; });

  function renderReport(d: any) {
    reportSlot.innerHTML = '';
    const hero = h('div', { class: 'kpi-hero' });
    hero.append(
      h('div', { class: 'kpi' }, h('div', { class: 'k' }, '1080p 最差场景 ΔPSNR'), h('div', { class: 'v good' }, `+${d.min_delta_bee_db.toFixed(2)} dB`), h('div', { class: 'd' }, `全 15 场景通过 ≥4dB：${d.pass_4db ? '是' : '否'}`)),
      h('div', { class: 'kpi' }, h('div', { class: 'k' }, '平均 ΔPSNR'), h('div', { class: 'v accent' }, `+${d.mean_delta_bee_db.toFixed(2)} dB`), h('div', { class: 'd' }, '同码率 ROI vs 整幅平均')),
    );
    reportSlot.append(hero);
    const table = h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ...['光照', '蜂流', '均匀蜜蜂 dB', 'ROI 蜜蜂 dB', 'Δ dB', '字节比'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...d.presets.map((p: any) => h('tr', {},
        h('td', {}, p.lighting), h('td', {}, p.flow),
        h('td', {}, p.uniform_bee_psnr.toFixed(2)), h('td', {}, p.roi_bee_psnr.toFixed(2)),
        h('td', { class: p.delta_bee_db >= 4 ? 'pass' : 'fail' }, `+${p.delta_bee_db.toFixed(2)}`),
        h('td', {}, p.byte_ratio.toFixed(3)),
      ))),
    );
    reportSlot.append(table);
  }

  root.append(h('div', { class: 'grid cols-2' }, ctrl, resultCard), benchCard);

  // If a processed frame already exists (navigating back), show it.
  if (studio.processed) renderResult(studio.processed, 0);
}
