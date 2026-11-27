// 应用入口:加载 WASM 核心、挂载四个页面的标签路由。

import './styles.css';
import { WasmCodec } from './wasm/codec';
import { store } from './store';
import { renderImportPage } from './pages/import';
import { renderMotionPage } from './pages/motion';
import { renderBitratePage } from './pages/bitrate';
import { renderComparePage } from './pages/compare';

type Route = 'import' | 'motion' | 'bitrate' | 'compare';
const ROUTES: Record<Route, () => HTMLElement> = {
  import: renderImportPage,
  motion: renderMotionPage,
  bitrate: renderBitratePage,
  compare: renderComparePage,
};

const view = document.getElementById('view')!;
const statusEl = document.getElementById('status')!;

function navigate(route: Route): void {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.route === route);
  });
  view.innerHTML = '';
  view.appendChild(ROUTES[route]());
}

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => {
  b.addEventListener('click', () => navigate(b.dataset.route as Route));
});

// 启动:异步加载 WASM,先渲染导入页避免白屏
navigate('import');
WasmCodec.create()
  .then(() => {
    store.set({ wasmReady: true });
    statusEl.textContent = '就绪 · WASM 编解码核心已加载';
  })
  .catch((err) => {
    statusEl.textContent = `WASM 加载失败:${err instanceof Error ? err.message : String(err)}`;
  });
