// Tiny DOM helper + toast system used by the four pages.
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  props: Record<string, any> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k === 'style' && typeof v === 'string') el.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'dataset') {
      Object.assign(el.dataset, v);
    } else if (v !== null && v !== undefined) {
      (el as any)[k] = v;
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function toast(message: string, kind: '' | 'good' | 'bad' = '', ms = 3200) {
  let wrap = document.querySelector('.toast-wrap') as HTMLElement | null;
  if (!wrap) {
    wrap = h('div', { class: 'toast-wrap' });
    document.body.append(wrap);
  }
  const t = h('div', { class: `toast ${kind}` }, message);
  wrap.append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, ms - 300);
  setTimeout(() => t.remove(), ms);
}

export function canvasFromRgba(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  img.data.set(rgba as Uint8ClampedArray);
  ctx.putImageData(img, 0, 0);
  return c;
}

export function drawRgba(canvas: HTMLCanvasElement, rgba: Uint8ClampedArray | Uint8Array, w: number, h: number) {
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  img.data.set(rgba as Uint8ClampedArray);
  ctx.putImageData(img, 0, 0);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function fmtBytes(n: number): string {
  if (n > 1024 * 1024) return (n / 1048576).toFixed(2) + ' MB';
  if (n > 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}
