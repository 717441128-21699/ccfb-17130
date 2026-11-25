import { studio } from '../studio';
import { h, toast, drawRgba, downloadBlob, fmtBytes } from '../ui/dom';
import { muxHcv } from '../lib/hcv-container';

export function renderCompare(root: HTMLElement) {
  root.innerHTML = '';
  const s = studio.settings;
  let showUniform = false;

  const toolbar = h('div', { class: 'card mb16' },
    h('div', { class: 'row' },
      h('label', { class: 'field', style: 'min-width:220px;flex:1' },
        h('span', { html: `时间轴：第 <b id="sec-label">0.000</b> 秒 / 共 ${s.durationSeconds}s` }),
        (() => {
          const slider = h('input', { type: 'range', min: '0', max: String(s.durationSeconds * s.fps - 1), value: String(studio.frameIndex) }) as HTMLInputElement;
          slider.addEventListener('input', () => { studio.frameIndex = +slider.value; syncFrame(); });
          return slider;
        })(),
      ),
    ),
    h('div', { class: 'row' },
      (() => { const b = h('button', { class: 'btn primary' }, '压缩当前帧并并排比较 (WASM)'); b.addEventListener('click', () => compress()); return b; })(),
      (() => { const b = h('button', { class: 'btn' }, '存入该秒关键帧'); b.addEventListener('click', () => { const sec = Math.floor(studio.frameIndex / s.fps); if (studio.processed) { studio.keyframes.set(sec, studio.processed.roiBits.slice()); toast(`第 ${sec} 秒关键帧已写入索引`, 'good'); } else toast('请先压缩当前帧', 'bad'); }); return b; })(),
      h('span', { class: 'spacer' }),
      h('label', { class: 'switch' }, (() => { const c = h('input', { type: 'checkbox' }) as HTMLInputElement; c.checked = showUniform; c.addEventListener('change', () => { showUniform = c.checked; uniformPane.classList.toggle('hidden', !showUniform); }); return c; })(), h('span', { class: 'track' }), '同时显示均匀基线'),
    ),
  );

  function pane(title: string, tag: string): [HTMLDivElement, HTMLCanvasElement, HTMLDivElement] {
    const canvas = h('canvas');
    const meta = h('div', { class: 'pane-title' }, title, h('span', { class: 'tag' }, tag));
    const body = h('div', { class: 'canvas-wrap' }, canvas);
    const card = h('div', { class: 'card' }, meta, body);
    return [card, canvas, meta];
  }
  const [origCard, origCanvas] = pane('压缩前 · 原始帧', 'RGBA');
  const [roiCard, roiCanvas, roiMeta] = pane('压缩后 · ROI 解码', 'HCV1 / WASM');
  const [uniformCard, uniformCanvas] = pane('整幅平均分配解码', 'baseline');
  uniformCard.classList.add('hidden');
  const uniformPane = uniformCard;

  const grid = h('div', { class: 'compare-grid' }, origCard, roiCard);
  root.append(toolbar, grid, h('div', { class: 'compare-grid mt16' }, uniformCard));

  // ---- seek + export card ----
  const seekCard = h('div', { class: 'card mt16' }, h('h2', {}, '秒级随机访问与通用格式导出'));
  const secInput = h('input', { type: 'number', min: '0', max: String(s.durationSeconds - 1), value: '0', style: 'width:110px' }) as HTMLInputElement;
  const seekBtn = h('button', { class: 'btn good' }, '跳到该秒并解码');
  const seekStat = h('span', { class: 'badge' }, '解码耗时 —');
  seekBtn.addEventListener('click', async () => {
    const sec = Math.max(0, Math.min(s.durationSeconds - 1, Math.floor(+secInput.value || 0)));
    studio.frameIndex = sec * s.fps;
    syncFrame();
    try {
      const ms = await studio.decodeAtSecond(sec);
      seekStat.textContent = `第 ${sec} 秒解码 ${ms.toFixed(1)} ms`;
      seekStat.className = 'badge ' + (ms <= 500 ? 'good' : 'bad');
      toast(`随机访问第 ${sec} 秒：${ms.toFixed(1)} ms（指标 ≤500ms）`, ms <= 500 ? 'good' : 'bad');
    } catch (e) { toast((e as Error).message, 'bad'); }
  });

  const seekLog = h('div', { class: 'mt16' });
  function renderSeekLog() {
    seekLog.innerHTML = '';
    if (!studio.seekLog.length) return;
    seekLog.append(h('h3', {}, '最近随机访问'));
    const t = h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', {}, '目标秒'), h('th', {}, 'WASM 解码 ms'), h('th', {}, '≤500ms'))));
    const tb = h('tbody');
    for (const r of studio.seekLog) tb.append(h('tr', {}, h('td', {}, `${r.second}s`), h('td', {}, r.ms.toFixed(1)), h('td', { class: r.ms <= 500 ? 'pass' : 'fail' }, r.ms <= 500 ? 'PASS' : 'FAIL')));
    t.append(tb); seekLog.append(t);
  }
  studio.subscribe(renderSeekLog);

  const exportHcv = h('button', { class: 'btn' }, '导出 .hcv 压缩码流');
  exportHcv.addEventListener('click', () => {
    if (!studio.processed) return toast('请先压缩当前帧', 'bad');
    downloadBlob(new Blob([studio.processed.roiBits.slice().buffer as ArrayBuffer], { type: 'application/octet-stream' }), `hive-roi-f${studio.frameIndex}.hcv`);
    toast('已导出 HCV1 裸码流（含帧头/量化系数）', 'good');
  });
  const exportContainer = h('button', { class: 'btn good' }, '压缩全部整数秒并导出 .hcv 索引容器');
  exportContainer.addEventListener('click', async () => {
    exportContainer.disabled = true;
    const old = exportContainer.textContent;
    try {
      const seconds = Math.max(1, Math.floor(s.durationSeconds));
      for (let sec = 0; sec < seconds; sec++) {
        exportContainer.textContent = `编码关键帧 ${sec + 1}/${seconds}…`;
        studio.frameIndex = sec * s.fps;
        await studio.processCurrent(); // stores keyframe under this second
      }
      const frames = [...studio.keyframes.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([second, bytes]) => ({ second, bytes }));
      const blob = muxHcv({ fps: s.fps, width: s.width, height: s.height }, frames);
      downloadBlob(blob, `hive-roi-indexed-${s.width}x${s.height}.hcvx`);
      toast(`已导出 ${frames.length} 个秒级关键帧 + 索引，可随机访问`, 'good');
    } catch (e) {
      toast('容器导出失败：' + (e as Error).message, 'bad');
    } finally {
      exportContainer.disabled = false;
      exportContainer.textContent = old;
    }
  });
  const exportPng = h('button', { class: 'btn' }, '导出当前解码帧 PNG');
  exportPng.addEventListener('click', () => {
    roiCanvas.toBlob((b) => { if (b) downloadBlob(b, `hive-roi-f${studio.frameIndex}.png`); }, 'image/png');
  });
  const exportWebm = h('button', { class: 'btn primary' }, '录制 16 帧解码画面为通用 WebM');
  exportWebm.addEventListener('click', () => recordWebm(exportWebm));

  seekCard.append(
    h('div', { class: 'row' }, h('label', { class: 'field', style: 'margin:0' }, h('span', {}, '目标秒（整数秒，自带关键帧索引）'), h('div', { class: 'row' }, secInput, seekBtn, seekStat))),
    h('div', { class: 'row mt16' }, exportHcv, exportContainer, exportPng, exportWebm),
    h('p', { class: 'hint mt8' }, 'WebM(VP9/VP8) 可被 FFmpeg / VLC / DaVinci / OpenCV 直接读取；.hcv 为研究用裸码流，可用本工作台解码。真实系统按每秒一个 IDR 关键帧写索引，任意秒无需从头解码。'),
    seekLog,
  );
  root.append(seekCard);

  function syncFrame() {
    const f = studio.renderCurrent();
    drawRgba(origCanvas, f.rgba, s.width, s.height);
    const lab = root.querySelector('#sec-label');
    if (lab) lab.textContent = (studio.frameIndex / s.fps).toFixed(3);
    // Clear decoded panes until recompressed for this frame.
    const p = studio.processed;
    if (p && studio.frame) drawRgba(roiCanvas, p.roiRgba, p.width, p.height);
  }

  async function compress() {
    const btn = eventTargetButton();
    if (btn) btn.disabled = true;
    try {
      const out = await studio.processCurrent();
      drawRgba(roiCanvas, out.roiRgba, out.width, out.height);
      drawRgba(uniformCanvas, out.uniformRgba, out.width, out.height);
      roiMeta.innerHTML = `压缩后 · ROI 解码 <span class="tag">Δ ${out.stats.deltaBeeDb >= 0 ? '+' : ''}${out.stats.deltaBeeDb.toFixed(2)} dB · ${fmtBytes(out.stats.roiBytes)}</span>`;
      if (showUniform) uniformCard.classList.remove('hidden');
      toast(`完成：蜜蜂区域 ΔPSNR ${out.stats.deltaBeeDb.toFixed(2)} dB`, out.stats.deltaBeeDb >= 4 ? 'good' : '');
    } catch (e) { toast('压缩失败：' + (e as Error).message, 'bad'); }
    finally { if (btn) btn.disabled = false; }
  }
  function eventTargetButton(): HTMLButtonElement | null { return root.querySelector('button.btn.primary'); }

  async function recordWebm(btn: HTMLButtonElement) {
    if (typeof MediaRecorder === 'undefined') return toast('当前浏览器不支持 MediaRecorder', 'bad');
    btn.disabled = true; const old = btn.textContent; btn.textContent = '录制中 0/16…';
    const stream = roiCanvas.captureStream(0);
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
    const chunks: BlobPart[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise<void>((res) => { rec.onstop = () => res(); });
    rec.start();
    const startFrame = studio.frameIndex;
    try {
      for (let i = 0; i < 16; i++) {
        studio.frameIndex = startFrame + i * 4; // step every 4 high-speed frames
        const out = await studio.processCurrent();
        drawRgba(roiCanvas, out.roiRgba, out.width, out.height);
        drawRgba(origCanvas, studio.frame!.rgba, s.width, s.height);
        if (track.requestFrame) track.requestFrame();
        btn.textContent = `录制中 ${i + 1}/16…`;
        await new Promise((r) => setTimeout(r, 60));
      }
    } catch (e) { toast('录制失败：' + (e as Error).message, 'bad'); }
    rec.stop();
    await done;
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    downloadBlob(new Blob(chunks, { type: mime || 'video/webm' }), `hive-roi-preview.${ext}`);
    btn.disabled = false; btn.textContent = old;
    toast('已导出通用视频，可拖入 FFmpeg / VLC', 'good');
  }

  // initial paint
  syncFrame();
  if (studio.processed) {
    drawRgba(roiCanvas, studio.processed.roiRgba, studio.processed.width, studio.processed.height);
    drawRgba(uniformCanvas, studio.processed.uniformRgba, studio.processed.width, studio.processed.height);
  }
  renderSeekLog();
}
