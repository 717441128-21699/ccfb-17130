// Canvas 像素渲染与块叠加工具
import { CLASS_COLORS, CLASS_NAMES } from '../core/types.ts';

export function rgbaToCanvas(canvas: HTMLCanvasElement, rgba: Uint8Array, w: number, h: number): void {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const clamped = new Uint8ClampedArray(
    rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.length),
  ) as unknown as Uint8ClampedArray<ArrayBuffer>;
  const img = new ImageData(clamped, w, h);
  ctx.putImageData(img, 0, 0);
}

/** 在画布上叠加 8x8 块分类半透明遮罩 */
export function overlayClasses(
  canvas: HTMLCanvasElement,
  classes: Uint8Array,
  w: number,
  h: number,
  show: boolean,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (!show) return;
  const nbw = w / 8;
  ctx.save();
  for (let by = 0; by < h / 8; by++) {
    for (let bx = 0; bx < nbw; bx++) {
      const c = classes[by * nbw + bx];
      if (c === 0) continue;
      ctx.fillStyle = CLASS_COLORS[c] + '55';
      ctx.fillRect(bx * 8, by * 8, 8, 8);
      ctx.strokeStyle = CLASS_COLORS[c];
      ctx.lineWidth = 0.5;
      ctx.strokeRect(bx * 8, by * 8, 8, 8);
    }
  }
  ctx.restore();
}

export function classLegend(): string {
  return CLASS_NAMES.map((name, i) =>
    `<span class="legend-item"><i style="background:${CLASS_COLORS[i]}"></i>${name}</span>`,
  ).join('');
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}
