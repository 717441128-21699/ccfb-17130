// Canvas 绘制工具:RGB 帧渲染、类别叠加层、对比分栏。

import { CLASS_META, MB, MbClass, type ClassMap, type RawFrame } from '../core/types';

export function putRGB(ctx: CanvasRenderingContext2D, frame: RawFrame): void;
export function putRGB(
  ctx: CanvasRenderingContext2D,
  data: Uint8Array,
  width: number,
  height: number,
): void;
export function putRGB(
  ctx: CanvasRenderingContext2D,
  arg1: RawFrame | Uint8Array,
  width?: number,
  height?: number,
): void {
  let data: Uint8Array;
  let w: number;
  let h: number;
  if (arg1 instanceof Uint8Array) {
    data = arg1;
    w = width!;
    h = height!;
  } else {
    data = arg1.data;
    w = arg1.width;
    h = arg1.height;
  }
  const img = ctx.createImageData(w, h);
  for (let p = 0, j = 0; p < data.length; p += 3, j += 4) {
    img.data[j] = data[p];
    img.data[j + 1] = data[p + 1];
    img.data[j + 2] = data[p + 2];
    img.data[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** 在画布上叠加类别图的半透明色块与图例描边。 */
export function drawClassOverlay(
  ctx: CanvasRenderingContext2D,
  classMap: ClassMap,
  mbCols: number,
  mbRows: number,
): void {
  for (let my = 0; my < mbRows; my++) {
    for (let mx = 0; mx < mbCols; mx++) {
      const cls = classMap[my * mbCols + mx] as MbClass;
      if (cls === MbClass.Background) continue;
      const meta = CLASS_META[cls];
      ctx.fillStyle = meta.color;
      ctx.fillRect(mx * MB, my * MB, MB, MB);
      ctx.strokeStyle = meta.color.replace(/[\d.]+\)$/, '0.9)');
      ctx.lineWidth = 1;
      ctx.strokeRect(mx * MB + 0.5, my * MB + 0.5, MB - 1, MB - 1);
    }
  }
}

/** 创建并返回一个尺寸确定的离屏 canvas 上下文。 */
export function makeCanvas(width: number, height: number): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  return { canvas, ctx };
}
