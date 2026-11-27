// 应用全局状态与页面路由(轻量自研,不引入框架)
import {
  DEFAULT_ANALYZE,
  DEFAULT_RATE,
  type AnalyzeParams,
  type RateConfig,
  type SynthConfig,
} from '../core/types.ts';

export type PageId = 'import' | 'motion' | 'rate' | 'compare';

export interface AppState {
  page: PageId;
  synth: SynthConfig | null;
  rateCfg: RateConfig;
  analyzeCfg: AnalyzeParams;
  mode: 'adaptive' | 'uniform';
  // 编码产物
  hvcBytes: Uint8Array | null;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  totalBytes: number;
  encodeMs: number;
  psnr: { full: number; bee: number; bg: number } | null;
  // 原始帧缓存(用于对比页),仅保留抽样帧
  originalFrames: Map<number, Uint8Array>;
}

export const state: AppState = {
  page: 'import',
  synth: null,
  rateCfg: { ...DEFAULT_RATE },
  analyzeCfg: { ...DEFAULT_ANALYZE },
  mode: 'adaptive',
  hvcBytes: null,
  width: 0,
  height: 0,
  fps: 200,
  frameCount: 0,
  totalBytes: 0,
  encodeMs: 0,
  psnr: null,
  originalFrames: new Map(),
};

export function navigate(page: PageId): void {
  state.page = page;
  location.hash = page;
  renderNav();
  const host = document.getElementById('page-host');
  if (!host) return;
  // 动态挂载页面模块
  void mountPage(page, host);
}

async function mountPage(page: PageId, host: HTMLElement): Promise<void> {
  host.innerHTML = '<div class="loading">加载页面中…</div>';
  const pages: Record<PageId, () => Promise<{ mount: (el: HTMLElement) => void }>> = {
    import: () => import('../pages/import-page.ts'),
    motion: () => import('../pages/motion-page.ts'),
    rate: () => import('../pages/rate-page.ts'),
    compare: () => import('../pages/compare-page.ts'),
  };
  const mod = await pages[page]();
  host.innerHTML = '';
  mod.mount(host);
}

export function renderNav(): void {
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
    el.classList.toggle('active', el.dataset.nav === state.page);
  });
}

export function initRouter(): void {
  const initial = (location.hash.replace('#', '') as PageId) || 'import';
  state.page = ['import', 'motion', 'rate', 'compare'].includes(initial) ? initial : 'import';
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => navigate(el.dataset.nav as PageId));
  });
  renderNav();
  const host = document.getElementById('page-host');
  if (host) void mountPage(state.page, host);
}
