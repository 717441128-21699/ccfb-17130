import './style.css';
import { studio } from './studio';
import { HiveWasm } from './wasm/hive-client';
import { renderImport } from './pages/import';
import { renderMotion } from './pages/motion';
import { renderBitrate } from './pages/bitrate';
import { renderCompare } from './pages/compare';

const view = document.getElementById('view')!;
const statusEl = document.getElementById('wasm-status')!;
const footerSpec = document.getElementById('footer-spec')!;
footerSpec.textContent = `当前工程 ${studio.settings.width}×${studio.settings.height}@${studio.settings.fps}fps · 宏块 16px`;

type Tab = 'import' | 'motion' | 'bitrate' | 'compare';
const TABS: Tab[] = ['import', 'motion', 'bitrate', 'compare'];

function tabFromHash(): Tab {
  const h = location.hash.replace('#/', '').replace('#', '') as Tab;
  return TABS.includes(h) ? h : 'import';
}

function route(tab: Tab) {
  if (location.hash !== `#/${tab}`) history.replaceState(null, '', `#/${tab}`);
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.tab === tab));
  view.innerHTML = '';
  if (tab === 'import') renderImport(view);
  if (tab === 'motion') renderMotion(view);
  if (tab === 'bitrate') renderBitrate(view);
  if (tab === 'compare') renderCompare(view);
}

document.querySelectorAll('.tab').forEach((b) => {
  b.addEventListener('click', () => route((b as HTMLElement).dataset.tab as Tab));
});
window.addEventListener('hashchange', () => route(tabFromHash()));

studio.subscribe(() => {
  footerSpec.textContent = `当前工程 ${studio.settings.width}×${studio.settings.height}@${studio.settings.fps}fps · 宏块 16px · 分配来源 ${studio.allocationSource === 'gt' ? '真实标注' : 'Worker 分析'}`;
});

// Warm up WASM once so the status pill reflects core readiness.
HiveWasm.load()
  .then(() => {
    studio.wasmReady = true;
    statusEl.textContent = 'WASM 核心就绪 · HCV1';
    statusEl.className = 'status-pill status-ready';
    // Eagerly construct the codec worker too.
    studio.initCodecWorker();
  })
  .catch((err) => {
    statusEl.textContent = 'WASM 加载失败：' + err.message;
    statusEl.className = 'status-pill status-error';
  });

route(tabFromHash());

// Automated headless smoke: ?smoke=1 compresses one frame through the codec
// worker and reports outcome in document.title / #smoke-out.
if (new URLSearchParams(location.search).has('smoke')) {
  const out = document.createElement('div');
  out.id = 'smoke-out';
  out.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99;background:#000;color:#0f0;font:12px monospace;padding:6px 10px;border-radius:6px';
  out.textContent = 'SMOKE_RUNNING';
  document.body.append(out);
  (async () => {
    try {
      studio.frameIndex = 14;
      studio.renderCurrent();
      const r = await studio.processCurrent();
      const ms = await studio.decodeAtSecond(0).catch(() => -1);
      const delta = r.stats.deltaBeeDb;
      const ok = Number.isFinite(delta) && delta >= 4 && ms >= 0 && ms <= 500;
      out.textContent = `${ok ? 'SMOKE_PASS' : 'SMOKE_WEAK'} delta=${delta.toFixed(2)} decodeMs=${ms.toFixed(1)} roiBytes=${r.stats.roiBytes}`;
      document.title = out.textContent;
    } catch (e) {
      out.textContent = 'SMOKE_FAIL ' + (e as Error).message;
      document.title = out.textContent;
    }
  })();
}

// Expose a tiny debug handle for automated smoke checks.
(window as any).__hive = { studio, route };
