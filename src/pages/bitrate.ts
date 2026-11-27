// 页面 ③:码率分配。设定总码率上限或固定质量,运行 WASM 编码流水线,
// 实时显示进度、逐帧字节、达到码率 vs 目标码率,并导出 .hvc 压缩文件。

import { WasmCodec } from '../wasm/codec';
import { EncodePipeline } from '../core/pipeline';
import { BitrateAllocator } from '../core/bitrate';
import { downloadBlob } from '../core/exporter';
import { store } from '../store';

function fmtBps(bps: number): string {
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(2)} Mbps`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} kbps`;
  return `${bps.toFixed(0)} bps`;
}
function fmtBytes(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

export function renderBitratePage(): HTMLElement {
  const el = document.createElement('div');
  const s = store.get();
  if (s.frames.length === 0) {
    el.innerHTML = `<div class="card"><h2>③ 码率分配</h2><p class="hint">请先在「① 录像导入」生成录像。</p></div>`;
    return el;
  }
  const cfg = s.synthCfg!;
  el.innerHTML = `
    <div class="card">
      <h2>③ 码率分配与 WASM 编码</h2>
      <p class="hint">
        蜜蜂所在的飞行/花粉块按运动速度与花粉检测获得更高码率(更小 QP),
        爬行块次之,静态背景在 P 帧零字节跳过。设定总码率上限后,滑窗码率控制自动调节帧 QP。
      </p>
      <div class="grid-2">
        <label class="field"><span>模式</span>
          <select id="m-mode">
            <option value="cbr">目标码率上限(自动调节)</option>
            <option value="cqp">固定质量(QP)</option>
          </select>
        </label>
        <label class="field"><span>目标总码率(bps)</span>
          <input id="m-bitrate" type="number" value="${s.encodeOpts.targetBitrate}" step="100000" />
        </label>
        <label class="field"><span>固定质量基准 QP(1 最精细 ~ 32 最粗)</span>
          <input id="m-qp" type="range" min="1" max="32" value="${s.encodeOpts.baseQp}" />
        </label>
        <label class="field"><span>GOP(I 帧间隔)</span>
          <input id="m-gop" type="number" value="${s.encodeOpts.gop}" min="1" max="200" />
        </label>
      </div>
      <button class="btn" id="btn-encode">开始 WASM 编码</button>
      <div class="progress"><div id="prog"></div></div>
      <div id="msg" class="hint"></div>
    </div>
    <div class="card" id="result-card" hidden>
      <h2>编码结果</h2>
      <table class="metrics" id="summary-table"></table>
      <h3>逐帧字节分布</h3>
      <canvas id="chart" width="1100" height="220" style="width:100%;background:#0d131b;border-radius:8px"></canvas>
      <div style="margin-top:14px;display:flex;gap:10px">
        <button class="btn secondary" id="btn-download-hvc">下载 .hvc 压缩文件</button>
        <button class="btn secondary" id="btn-goto-compare">前往并排对比 →</button>
      </div>
    </div>
  `;

  const modeSel = el.querySelector<HTMLSelectElement>('#m-mode')!;
  const bitrateInput = el.querySelector<HTMLInputElement>('#m-bitrate')!;
  const qpInput = el.querySelector<HTMLInputElement>('#m-qp')!;
  const gopInput = el.querySelector<HTMLInputElement>('#m-gop')!;

  el.querySelector<HTMLButtonElement>('#btn-encode')!.onclick = async () => {
    const cbr = modeSel.value === 'cbr';
    const opts = {
      fps: cfg.fps,
      gop: Number(gopInput.value),
      targetBitrate: cbr ? Number(bitrateInput.value) : 0,
      baseQp: Number(qpInput.value),
    };
    store.set({ encodeOpts: opts });
    const msg = el.querySelector<HTMLElement>('#msg')!;
    const prog = el.querySelector<HTMLDivElement>('#prog')!;
    msg.textContent = '加载 WASM 编解码核心…';
    const codec = await WasmCodec.create();
    const pipeline = new EncodePipeline(codec);
    const { file, summary } = await pipeline.run(cfg, opts, {
      onProgress: (done, total) => {
        prog.style.width = `${(done / total) * 100}%`;
        if (done % 8 === 0 || done === total)
          msg.textContent = `编码中 ${done}/${total} 帧 · 已产出 ${fmtBytes(fileLengthSafe())}`;
      },
    });
    function fileLengthSafe(): number {
      return summary?.totalBytes ?? 0;
    }
    store.set({ encodedFile: file, summary });
    prog.style.width = '100%';
    msg.textContent = '编码完成。';
    showResult(el, opts.targetBitrate);
  };

  el.querySelector<HTMLButtonElement>('#btn-goto-compare')!.onclick = () => {
    document.querySelector<HTMLButtonElement>('.tab[data-route="compare"]')?.click();
  };
  el.querySelector<HTMLButtonElement>('#btn-download-hvc')!.onclick = () => {
    const f = store.get().encodedFile;
    if (f) {
      // 拷贝到独立 ArrayBuffer,规避 TS 对 SharedArrayBuffer 的严格区分
      const buf = new Uint8Array(f.length);
      buf.set(f);
      downloadBlob(new Blob([buf.buffer], { type: 'application/octet-stream' }), 'entrance.hvc');
    }
  };

  return el;
}

function showResult(el: HTMLElement, targetBitrate: number): void {
  const s = store.get();
  const sum = s.summary!;
  el.querySelector<HTMLElement>('#result-card')!.hidden = false;
  const table = el.querySelector<HTMLTableElement>('#summary-table')!;
  const over = targetBitrate > 0 ? sum.achievedBitrate > targetBitrate : false;
  table.innerHTML = `
    <tr><th>总帧数</th><td class="num">${sum.frameCount}</td><th>分辨率(填充后)</th><td class="num">${sum.width}×${sum.height} (${sum.paddedWidth}×${sum.paddedHeight})</td></tr>
    <tr><th>压缩后大小</th><td class="num">${fmtBytes(sum.totalBytes)}</td><th>编码耗时</th><td class="num">${(sum.encodeMs / 1000).toFixed(2)} s</td></tr>
    <tr><th>目标码率</th><td class="num">${targetBitrate > 0 ? fmtBps(targetBitrate) : '固定质量'}</td>
        <th>达到码率</th><td class="num ${over ? 'warn' : 'good'}">${fmtBps(sum.achievedBitrate)}</td></tr>
    <tr><th>等效压缩比(相对原始 RGB)</th><td class="num" colspan="3">${(
      (sum.width * sum.height * 3 * sum.frameCount) /
      sum.totalBytes
    ).toFixed(1)}×</td></tr>
  `;
  drawChart(el, sum.frameStats.map((f) => f.bytes), sum.frameStats.map((f) => f.isKey));
  // 让 Allocator 的预算也展示(说明规划值)
  void new BitrateAllocator({
    fps: s.encodeOpts.fps,
    targetBitrate: targetBitrate || 1,
    width: sum.width,
    height: sum.height,
  });
}

function drawChart(el: HTMLElement, bytes: number[], isKey: boolean[]): void {
  const canvas = el.querySelector<HTMLCanvasElement>('#chart')!;
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const max = Math.max(1, ...bytes);
  const bw = W / bytes.length;
  ctx.fillStyle = '#4ea1ff';
  bytes.forEach((b, i) => {
    const h = (b / max) * (H - 30);
    ctx.fillStyle = isKey[i] ? '#f5b13d' : '#4ea1ff';
    ctx.fillRect(i * bw, H - h, Math.max(1, bw - 0.5), h);
  });
  ctx.fillStyle = '#8ba0b6';
  ctx.font = '12px sans-serif';
  ctx.fillText('金色 = I 帧(随机访问点),蓝色 = P 帧', 10, 16);
  ctx.fillText(`单帧最大 ${fmtBytes(max)}`, 10, H - 6);
}
