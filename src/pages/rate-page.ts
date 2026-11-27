// 码率分配页:总码率上限与各类别 QP 偏移配置 + 编码统计
import { state, navigate } from '../ui/app-state.ts';
import { el } from '../ui/canvas-util.ts';

export function mount(host: HTMLElement): void {
  host.append(
    el('h2', {}, '码率分配'),
    el('p', { class: 'sub' }, '设置总码率上限,工具通过 VBV 反馈 + 指数模型前馈自动调节块 QP;类别偏移决定码率如何向高速/携粉块倾斜。'),
  );

  const cfg = state.rateCfg;
  const card = el('div', { class: 'card' });
  const grid = el('div', { class: 'form-grid' });

  const bitrate = field('总码率上限 (kbps)', cfg.maxBitrateKbps);
  const qpMin = field('QP 下限', cfg.qpMin);
  const qpMax = field('QP 上限', cfg.qpMax);
  const offPollen = field('携粉块 QP 偏移(负=更多码率)', cfg.offsetPollen);
  const offFast = field('快速飞行 QP 偏移(负=更多码率)', cfg.offsetFast);
  const offCrawl = field('爬行块 QP 偏移(正=省码率)', cfg.offsetCrawl);
  const gop = field('关键帧间隔 (秒)', cfg.gopSeconds);
  const lightThr = field('光照变化阈值 (亮度级)', cfg.lightDeltaThr);

  grid.append(
    wrap('码率上限', bitrate), wrap('QP 下限', qpMin), wrap('QP 上限', qpMax),
    wrap('携粉偏移', offPollen), wrap('飞行偏移', offFast), wrap('爬行偏移', offCrawl),
    wrap('GOP 秒数', gop), wrap('光照阈值', lightThr),
  );
  card.append(grid);

  const modeSel = el('select') as HTMLSelectElement;
  [['adaptive', '自适应(类别倾斜)'], ['uniform', '均匀基线(对照)']].forEach(([v, t]) => {
    const o = el('option', { value: v }, t);
    if (v === state.mode) o.setAttribute('selected', '');
    modeSel.append(o);
  });
  modeSel.addEventListener('change', () => { state.mode = modeSel.value as 'adaptive' | 'uniform'; });
  card.append(el('label', { class: 'field' }, el('span', {}, '分配模式'), modeSel));

  // 统计区
  const statsCard = el('div', { class: 'card' });
  if (state.hvcBytes) {
    const secs = state.frameCount / state.fps;
    const kbps = (state.totalBytes * 8 / secs) / 1000;
    const rows: [string, string][] = [
      ['文件大小', `${(state.totalBytes / 1024).toFixed(1)} KB`],
      ['实际平均码率', `${kbps.toFixed(0)} kbps`],
      ['编码用时', `${(state.encodeMs / 1000).toFixed(2)} s`],
      ['关键帧/总帧', `${state.frameCount} 帧`],
    ];
    if (state.psnr) {
      rows.push(['全帧 PSNR', `${state.psnr.full.toFixed(2)} dB`]);
      rows.push(['蜜蜂热点区 PSNR', `${state.psnr.bee.toFixed(2)} dB`]);
      rows.push(['背景区 PSNR', `${state.psnr.bg.toFixed(2)} dB`]);
    }
    statsCard.append(el('h3', {}, '最近一次编码统计'),
      el('table', { class: 'stat-table' },
        el('tbody', {}, ...rows.map(([k, v]) =>
          el('tr', {}, el('th', {}, k), el('td', {}, v))))));
  } else {
    statsCard.append(el('p', { class: 'hint' }, '尚未编码。请先在运动区域页运行分析并压缩。'));
  }

  card.append(el('div', { class: 'btn-row' },
    btn('保存参数', 'secondary', () => {
      state.rateCfg = {
        maxBitrateKbps: Number(bitrate.value),
        qpMin: Number(qpMin.value), qpMax: Number(qpMax.value),
        offsetPollen: Number(offPollen.value), offsetFast: Number(offFast.value),
        offsetCrawl: Number(offCrawl.value), gopSeconds: Number(gop.value),
        lightDeltaThr: Number(lightThr.value),
      };
      flash('参数已保存,返回运动区域页重新编码以生效。');
    }),
    btn('前往并排对比', 'primary', () => navigate('compare')),
  ));
  const flashMsg = el('div', { class: 'hint' });
  card.append(flashMsg);
  function flash(t: string): void { flashMsg.textContent = t; }

  host.append(card, statsCard);
}

function field(label: string, value: number): HTMLInputElement {
  return el('input', { type: 'number', value: String(value) }) as HTMLInputElement;
}
function wrap(label: string, node: HTMLElement): HTMLElement {
  return el('label', { class: 'field' }, el('span', {}, label), node);
}
function btn(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { class: `btn ${cls}` }, text) as HTMLButtonElement;
  b.addEventListener('click', onClick);
  return b;
}
