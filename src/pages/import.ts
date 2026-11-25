import { studio } from '../studio';
import { FLOWS, LIGHTINGS } from '../lib/types';
import { h, toast, downloadBlob } from '../ui/dom';

export function renderImport(root: HTMLElement) {
  const s = studio.settings;
  root.innerHTML = '';

  const previewCard = h('div', { class: 'card' },
    h('h2', {}, '录像预览'),
    h('p', { class: 'hint' }, '内置确定性合成器按真实巢门场景生成：木板纹理、拱形巢门、快速飞行/起飞/爬行蜜蜂、可标注的黄色花粉团。'),
  );
  const canvasWrap = h('div', { class: 'canvas-wrap' });
  const canvas = h('canvas', { width: s.width, height: s.height });
  canvasWrap.append(canvas);
  previewCard.append(canvasWrap);
  const metaRow = h('div', { class: 'stat-grid' });
  previewCard.append(metaRow);

  function paint() {
    const f = studio.renderCurrent();
    canvas.width = s.width; canvas.height = s.height;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(s.width, s.height);
    img.data.set(f.rgba);
    ctx.putImageData(img, 0, 0);
    metaRow.innerHTML = '';
    const stats = [
      ['分辨率', `${s.width}×${s.height}`],
      ['帧率', `${s.fps} fps`],
      ['虚拟时长', `${s.durationSeconds} s`],
      ['当前帧蜜蜂', `${f.bees.length} 只`],
      ['花粉携带', `${f.bees.filter((b) => b.pollen).length} 只`],
      ['爬行个体', `${f.bees.filter((b) => b.crawling).length} 只`],
    ];
    for (const [k, v] of stats) metaRow.append(h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v', style: 'font-size:16px' }, v)));
  }

  // ---- settings card -------------------------------------------------------
  const settingsCard = h('div', { class: 'card' }, h('h2', {}, '合成 / 导入'));

  const lightSel = h('select', {}, ...LIGHTINGS.map((l) => h('option', { value: l.id, ...(l.id === s.lighting ? { selected: true } : {}) }, l.label))) as HTMLSelectElement;
  lightSel.addEventListener('change', () => { s.lighting = lightSel.value as any; studio.rebuildSynth(); paint(); });

  const flowSel = h('select', {}, ...FLOWS.map((f) => h('option', { value: f.id, ...(f.id === s.flow ? { selected: true } : {}) }, `${f.label}（${f.count} 只同屏）`))) as HTMLSelectElement;
  flowSel.addEventListener('change', () => { s.flow = flowSel.value as any; studio.rebuildSynth(); paint(); });

  const resSel = h('select', {},
    ...[['1280x720', '1280×720（交互默认）'], ['1920x1080', '1920×1080（全规格）'], ['960x540', '960×540'], ['640x360', '640×360']]
      .map(([v, label]) => h('option', { value: v, ...(v === `${s.width}x${s.height}` ? { selected: true } : {}) }, label)),
  ) as HTMLSelectElement;
  resSel.addEventListener('change', () => {
    const [w, hh] = resSel.value.split('x').map(Number);
    s.width = w; s.height = hh; studio.rebuildSynth(); paint();
  });

  const durRange = h('input', { type: 'range', min: '1', max: '10', step: '1', value: String(s.durationSeconds) }) as HTMLInputElement;
  const durVal = h('b', {}, `${s.durationSeconds} 秒 / ${s.durationSeconds * s.fps} 帧`);
  durRange.addEventListener('input', () => { s.durationSeconds = +durRange.value; durVal.textContent = `${s.durationSeconds} 秒 / ${s.durationSeconds * s.fps} 帧`; });
  durRange.addEventListener('change', () => studio.rebuildSynth());

  const frameRange = h('input', { type: 'range', min: '0', max: String(s.durationSeconds * s.fps - 1), value: String(studio.frameIndex) }) as HTMLInputElement;
  frameRange.addEventListener('input', () => { studio.frameIndex = +frameRange.value; paint(); });

  const regenBtn = h('button', { class: 'btn primary' }, '重新生成该光照场景');
  regenBtn.addEventListener('click', () => { studio.rebuildSynth(); paint(); toast('已重建合成巢门场景', 'good'); });

  const annoBtn = h('button', { class: 'btn' }, '下载真实运动标注 JSON');
  annoBtn.addEventListener('click', () => {
    const f = studio.frame ?? studio.renderCurrent();
    const payload = {
      schema: 'hive-roi-annotations/v1',
      width: s.width, height: s.height, fps: s.fps,
      lighting: s.lighting, flow: s.flow, frame: f.index,
      coordinate: 'pixel top-left; speed px/s; pollen 0=none 1..3=load',
      bees: f.bees,
    };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `hive-annotations-${s.lighting}-${s.flow}-f${f.index}.json`);
    toast('已导出逐帧真实标注', 'good');
  });

  // ---- real video import ---------------------------------------------------
  const fileInput = h('input', { type: 'file', accept: 'video/*' }) as HTMLInputElement;
  const drop = h('label', { class: 'dropzone' },
    h('div', { style: 'font-size:26px' }, '🎥'),
    h('div', {}, h('b', {}, '点击选择或拖入真实巢门录像')),
    h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, '支持 MP4/WebM/MOV；本地解码，不会上传'),
    fileInput,
  );
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) loadVideo(file);
  });
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e: DragEvent) => { const f = e.dataTransfer?.files?.[0]; if (f) loadVideo(f); });

  const videoSlot = h('div', { class: 'video-slot mt16' });
  function loadVideo(file: File) {
    const url = URL.createObjectURL(file);
    const video = h('video', { src: url, controls: true, muted: true, playsInline: true }) as HTMLVideoElement;
    video.style.width = '100%';
    video.addEventListener('loadedmetadata', () => {
      studio.videoEl = video; studio.videoFileName = file.name;
      s.source = 'video';
      s.width = video.videoWidth; s.height = video.videoHeight;
      toast(`已导入 ${file.name}（${video.videoWidth}×${video.videoHeight}）。播放到目标帧后点“抓取当前帧”。`, 'good', 5200);
    });
    videoSlot.innerHTML = '';
    videoSlot.append(video);
  }

  const grabBtn = h('button', { class: 'btn good' }, '抓取视频当前帧到分析/压缩');
  grabBtn.addEventListener('click', () => {
    const v = studio.videoEl;
    if (!v) return toast('请先选择视频文件', 'bad');
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    studio.settings.source = 'video';
    studio.settings.width = c.width; studio.settings.height = c.height;
    studio.injectExternalFrame(data.data, c.width, c.height);
    toast('已抓取当前帧，可进入“运动区域”页分析', 'good');
  });

  settingsCard.append(
    h('label', { class: 'field' }, h('span', {}, '光照条件'), lightSel),
    h('label', { class: 'field' }, h('span', {}, '蜂流量'), flowSel),
    h('label', { class: 'field' }, h('span', {}, '分辨率'), resSel),
    h('label', { class: 'field' }, h('span', {}, '时长（交互虚拟片段）'), durRange, h('span', { style: 'justify-content:flex-end' }, durVal)),
    h('label', { class: 'field' }, h('span', {}, '预览帧'), frameRange),
    h('div', { class: 'row mt8' }, regenBtn, annoBtn),
    h('h3', {}, '真实录像'),
    drop,
    videoSlot,
    h('div', { class: 'row mt8' }, grabBtn),
  );

  root.append(h('div', { class: 'grid cols-2' }, settingsCard, previewCard));
  paint();
}
