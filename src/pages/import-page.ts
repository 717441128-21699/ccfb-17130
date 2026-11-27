// 录像导入页:合成带标注的巢门录像,或导入本地视频抽帧
import { state, navigate } from '../ui/app-state.ts';
import { el } from '../ui/canvas-util.ts';
import type { LightScenario, SynthConfig, TrafficScenario } from '../core/types.ts';

export function mount(host: HTMLElement): void {
  host.append(
    el('h2', {}, '录像导入'),
    el('p', { class: 'sub' }, '合成带真实运动标注的巢门录像(多种光照 × 蜂流量),或导入本地视频文件抽帧。'),
  );

  const card = el('div', { class: 'card' });
  const form = el('div', { class: 'form-grid' });

  const width = numberField('宽度', [352, 640, 1280, 1920], 480);
  const height = numberField('高度', [208, 360, 720, 1080], 272);
  const fps = numberField('帧率 fps', [50, 100, 200], 200);
  const frames = numberField('帧数', [300, 1200, 3000, 12000], 1200);
  const seed = numberField('随机种子', [], 7);

  const light = selectField<LightScenario>('光照场景', [
    ['stable', '稳定光照'], ['drift', '缓慢漂移'], ['clouds', '云层变化'],
  ], 'clouds');
  const traffic = selectField<TrafficScenario>('蜂流量', [
    ['low', '低流量'], ['medium', '中流量'], ['high', '高流量'],
  ], 'high');

  form.append(
    wrap('分辨率宽', width), wrap('分辨率高', height),
    wrap('帧率', fps), wrap('帧数', frames),
    wrap('随机种子', seed),
    wrap('光照', light), wrap('蜂流量', traffic),
  );
  card.append(form);

  const preview = el('canvas', { class: 'preview' });
  const info = el('div', { class: 'hint' }, '填写参数后点击「生成预览」查看合成画面。');
  card.append(el('div', { class: 'btn-row' },
    makeBtn('生成预览', 'secondary', async () => {
      const cfg = collect();
      const { SynthVideo } = await import('../core/synth.ts');
      const video = new SynthVideo(cfg);
      const { rgba } = video.renderFrame(0);
      preview.style.width = '100%';
      const ctx = preview.getContext('2d')!;
      preview.width = cfg.width; preview.height = cfg.height;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), cfg.width, cfg.height), 0, 0);
      const ann = video.renderFrame(Math.floor(cfg.frames / 2)).annotation;
      info.textContent = `预览帧 0;中间帧标注:${ann.bees.length} 只蜜蜂,光照增益 ${ann.lightGain.toFixed(3)}`;
    }),
    makeBtn('使用该录像并开始压缩', 'primary', () => {
      state.synth = collect();
      navigate('motion');
    }),
  ), preview, info);

  // 本地视频导入
  const importCard = el('div', { class: 'card' });
  importCard.append(el('h3', {}, '或导入本地视频'));
  const fileInput = el('input', { type: 'file', accept: 'video/*' }) as HTMLInputElement;
  const fileHint = el('div', { class: 'hint' }, '选择 MP4/WebM 后将抽取前若干帧(受浏览器解码支持限制)。');
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) fileHint.textContent = `已选择:${f.name}(${(f.size / 1024 / 1024).toFixed(1)} MB)。浏览器视频抽帧在运动区域页处理。`;
  });
  importCard.append(fileInput, fileHint);

  host.append(card, importCard);

  function collect(): SynthConfig {
    return {
      width: Number(width.value), height: Number(height.value),
      fps: Number(fps.value), frames: Number(frames.value),
      light: light.value as LightScenario, traffic: traffic.value as TrafficScenario,
      seed: Number(seed.value),
    };
  }
}

function numberField(label: string, presets: number[], def: number): HTMLInputElement {
  const input = el('input', { type: 'number', value: String(def) }) as HTMLInputElement;
  if (presets.length) {
    const datalist = el('datalist');
    presets.forEach((p) => datalist.append(el('option', { value: String(p) })));
    input.setAttribute('list', `dl-${label}`);
  }
  return input;
}

function selectField<T extends string>(label: string, opts: [T, string][], def: T): HTMLSelectElement {
  const s = el('select') as HTMLSelectElement;
  opts.forEach(([v, t]) => {
    const o = el('option', { value: v }, t);
    if (v === def) o.setAttribute('selected', '');
    s.append(o);
  });
  return s;
}

function wrap(label: string, node: HTMLElement): HTMLElement {
  return el('label', { class: 'field' }, el('span', {}, label), node);
}

function makeBtn(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { class: `btn ${cls}` }, text) as HTMLButtonElement;
  b.addEventListener('click', () => { try { onClick(); } catch (e) { console.error(e); } });
  return b;
}
