// 图像质量指标:PSNR(峰值信噪比),支持按区域(蜜蜂区/背景区/整帧)分别计算。

import { MB, MbClass, type PsnrResult, type RawFrame } from './types';

/** 计算两段等长亮度数据的 PSNR(dB),MSE 为 0 时返回 Infinity。 */
export function psnrY(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  mask?: (x: number, y: number) => boolean,
): number {
  let se = 0;
  let n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask && !mask(x, y)) continue;
      const i = (y * width + x) * 3;
      const d = a[i] - b[i]; // Y 近似用 R 通道会偏,这里用真实亮度
      void d;
      const ya = luma(a[i], a[i + 1], a[i + 2]);
      const yb = luma(b[i], b[i + 1], b[i + 2]);
      const e = ya - yb;
      se += e * e;
      n++;
    }
  }
  if (n === 0) return Infinity;
  const mse = se / n;
  if (mse === 0) return Infinity;
  return 10 * Math.log10((255 * 255) / mse);
}

function luma(r: number, g: number, b: number): number {
  return (19595 * r + 38470 * g + 7471 * b + 32768) >> 16;
}

/** 依据像素级掩码计算 PSNR:mask=1 的像素纳入统计(用于精确的蜜蜂身体区)。 */
export function psnrYWithPixelMask(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  mask: Uint8Array,
  select: 0 | 1,
): number {
  let se = 0;
  let n = 0;
  for (let p = 0; p < width * height; p++) {
    if (mask[p] !== select) continue;
    const i = p * 3;
    const e = luma(a[i], a[i + 1], a[i + 2]) - luma(b[i], b[i + 1], b[i + 2]);
    se += e * e;
    n++;
  }
  if (n === 0) return Infinity;
  const mse = se / n;
  if (mse === 0) return Infinity;
  return 10 * Math.log10((255 * 255) / mse);
}

/** 依据类别图把像素划分为蜜蜂区(非背景 MB)与背景区。 */
export function regionPsnr(
  original: RawFrame,
  decoded: RawFrame,
  classMap: Uint8Array,
  mbCols: number,
): PsnrResult {
  const { width: w, height: h } = original;
  const beeMask = (x: number, y: number) =>
    classMap[Math.floor(y / MB) * mbCols + Math.floor(x / MB)] !== MbClass.Background;
  const bgMask = (x: number, y: number) =>
    classMap[Math.floor(y / MB) * mbCols + Math.floor(x / MB)] === MbClass.Background;
  return {
    beeRegion: psnrY(original.data, decoded.data, w, h, beeMask),
    background: psnrY(original.data, decoded.data, w, h, bgMask),
    wholeFrame: psnrY(original.data, decoded.data, w, h),
  };
}
