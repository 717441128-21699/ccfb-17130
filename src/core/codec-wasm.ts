// WebAssembly 编解码核心的 TS 封装:线性内存管理 + 持久平面缓冲。
// 浏览器与 Node(>=20,全局 WebAssembly)均可使用。

import {
  CLASS_BG,
  type AnalyzeParams,
  type BlockClass,
} from './types.ts';

export interface WasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  hive_malloc(size: number): number;
  hive_free(ptr: number, size: number): void;
  hive_rgba_to_yuv(
    rgba: number, len: number, w: number, h: number,
    y: number, u: number, v: number,
  ): number;
  hive_yuv_to_rgba(
    y: number, u: number, v: number, w: number, h: number,
    rgba: number, len: number,
  ): number;
  hive_analyze(
    bgY: number, curY: number, curU: number, curV: number,
    w: number, h: number, classes: number, sads: number,
    sadActive: number, sadFast: number, pollenV: number, pollenSat: number,
  ): number;
  hive_update_bg(
    bgY: number, bgU: number, bgV: number,
    curY: number, curU: number, curV: number,
    classes: number, w: number, h: number, alpha: number,
  ): number;
  hive_enc_keyframe(
    y: number, u: number, v: number, w: number, h: number,
    qp: number, out: number, cap: number,
  ): number;
  hive_enc_foreground(
    curY: number, curU: number, curV: number,
    bgY: number, bgU: number, bgV: number,
    qpMap: number, active: number, w: number, h: number,
    out: number, cap: number,
  ): number;
  hive_dec_keyframe(
    payload: number, len: number,
    outY: number, outU: number, outV: number, w: number, h: number,
  ): number;
  hive_dec_foreground(
    payload: number, len: number,
    bgY: number, bgU: number, bgV: number,
    outY: number, outU: number, outV: number, w: number, h: number,
  ): number;
  hive_psnr_multi(
    a: number, b: number, w: number, h: number,
    classes: number, mask: number, maskLen: number,
  ): number;
  hive_psnr_full(a: number, b: number, w: number, h: number): number;
}

export async function instantiateWasm(bytes: Uint8Array): Promise<WasmExports> {
  const { instance } = await WebAssembly.instantiate(
    bytes as unknown as BufferSource, {},
  );
  return instance.exports as unknown as WasmExports;
}

export class WasmCodec {
  readonly w: number;
  readonly h: number;
  readonly nblk: number;
  readonly x: WasmExports;

  // 持久缓冲指针
  readonly bgY: number;
  readonly bgU: number;
  readonly bgV: number;
  readonly curY: number;
  readonly curU: number;
  readonly curV: number;
  readonly decY: number;
  readonly decU: number;
  readonly decV: number;
  // 独立的背景参考平面(解码链中冻结,关键帧时更新)
  readonly refY: number;
  readonly refU: number;
  readonly refV: number;
  readonly classesPtr: number;
  readonly sadsPtr: number;
  readonly qpMapPtr: number;
  readonly rgbaPtr: number;
  private outPtr: number;
  private outCap: number;
  private scratchPtr: number;
  private scratchCap: number;
  private maskPtr: number;

  constructor(x: WasmExports, w: number, h: number) {
    if (w % 8 !== 0 || h % 8 !== 0) throw new Error('宽高必须为 8 的倍数');
    this.x = x;
    this.w = w;
    this.h = h;
    this.nblk = (w / 8) * (h / 8);
    const ySize = w * h * 2;
    const cSize = (w / 2) * (h / 2) * 2;
    const rgbaSize = w * h * 4;

    this.bgY = x.hive_malloc(ySize);
    this.bgU = x.hive_malloc(cSize);
    this.bgV = x.hive_malloc(cSize);
    this.curY = x.hive_malloc(ySize);
    this.curU = x.hive_malloc(cSize);
    this.curV = x.hive_malloc(cSize);
    this.decY = x.hive_malloc(ySize);
    this.decU = x.hive_malloc(cSize);
    this.decV = x.hive_malloc(cSize);
    this.refY = x.hive_malloc(ySize);
    this.refU = x.hive_malloc(cSize);
    this.refV = x.hive_malloc(cSize);
    this.classesPtr = x.hive_malloc(this.nblk);
    this.sadsPtr = x.hive_malloc(this.nblk * 4);
    this.qpMapPtr = x.hive_malloc(this.nblk);
    this.rgbaPtr = x.hive_malloc(rgbaSize);
    this.outCap = 4 * 1024 * 1024;
    this.outPtr = x.hive_malloc(this.outCap);
    this.scratchCap = 512 * 1024;
    this.scratchPtr = x.hive_malloc(this.scratchCap);
    this.maskPtr = x.hive_malloc(4);
  }

  private u8(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.x.memory.buffer, ptr, len);
  }

  private i16(ptr: number, len: number): Int16Array {
    return new Int16Array(this.x.memory.buffer, ptr, len);
  }

  private growOut(need: number): number {
    if (need <= this.outCap) return this.outPtr;
    this.x.hive_free(this.outPtr, this.outCap);
    this.outCap = Math.max(need, this.outCap * 2);
    this.outPtr = this.x.hive_malloc(this.outCap);
    return this.outPtr;
  }

  private growScratch(need: number): number {
    if (need <= this.scratchCap) return this.scratchPtr;
    this.x.hive_free(this.scratchPtr, this.scratchCap);
    this.scratchCap = Math.max(need, this.scratchCap * 2);
    this.scratchPtr = this.x.hive_malloc(this.scratchCap);
    return this.scratchPtr;
  }

  /** RGBA 像素 -> 当前帧 YUV 平面 */
  rgbaToYuv(rgba: Uint8Array | Uint8ClampedArray): void {
    const dst = this.u8(this.rgbaPtr, rgba.length);
    dst.set(rgba);
    const rc = this.x.hive_rgba_to_yuv(
      this.rgbaPtr, rgba.length, this.w, this.h,
      this.curY, this.curU, this.curV,
    );
    if (rc !== 0) throw new Error(`rgba_to_yuv 失败: ${rc}`);
  }

  /** YUV 平面 -> RGBA(默认输出解码平面) */
  yuvToRgba(yPtr = this.decY, uPtr = this.decU, vPtr = this.decV): Uint8Array {
    const rc = this.x.hive_yuv_to_rgba(
      yPtr, uPtr, vPtr, this.w, this.h,
      this.rgbaPtr, this.w * this.h * 4,
    );
    if (rc !== 0) throw new Error(`yuv_to_rgba 失败: ${rc}`);
    return this.u8(this.rgbaPtr, this.w * this.h * 4).slice();
  }

  /** 分块运动分析,返回亮度漂移(亮度级数,正=变亮) */
  analyze(p: AnalyzeParams): { classes: Uint8Array; sads: Uint32Array; delta: number } {
    const delta = this.x.hive_analyze(
      this.bgY, this.curY, this.curU, this.curV,
      this.w, this.h, this.classesPtr, this.sadsPtr,
      p.sadActive, p.sadFast, p.pollenV, p.pollenSat,
    );
    return {
      classes: this.u8(this.classesPtr, this.nblk).slice(),
      sads: new Uint32Array(
        this.x.memory.buffer.slice(this.sadsPtr, this.sadsPtr + this.nblk * 4),
      ),
      delta: delta / 256,
    };
  }

  /** 仅对静止块做背景 EMA 更新,alpha 为 0..1 */
  updateBackground(classes: Uint8Array, alpha: number): void {
    this.u8(this.classesPtr, this.nblk).set(classes);
    const rc = this.x.hive_update_bg(
      this.bgY, this.bgU, this.bgV,
      this.curY, this.curU, this.curV,
      this.classesPtr, this.w, this.h, Math.round(alpha * 256),
    );
    if (rc !== 0) throw new Error('update_background 失败');
  }

  /** 当前帧提升为背景(关键帧后调用) */
  promoteBackground(): void {
    const nY = this.w * this.h;
    const nC = (this.w / 2) * (this.h / 2);
    this.u8(this.bgY, nY * 2).set(this.u8(this.curY, nY * 2));
    this.u8(this.bgU, nC * 2).set(this.u8(this.curU, nC * 2));
    this.u8(this.bgV, nC * 2).set(this.u8(this.curV, nC * 2));
  }

  encodeKeyframe(qp: number): Uint8Array {
    const cap = this.growOut(1024);
    const need = this.x.hive_enc_keyframe(
      this.curY, this.curU, this.curV, this.w, this.h, qp,
      this.outPtr, this.outCap,
    );
    if (need > this.outCap) {
      this.growOut(need);
      const need2 = this.x.hive_enc_keyframe(
        this.curY, this.curU, this.curV, this.w, this.h, qp,
        this.outPtr, this.outCap,
      );
      if (need2 !== need) throw new Error('关键帧编码长度不一致');
    }
    return this.u8(this.outPtr, need).slice();
  }

  encodeForeground(classes: Uint8Array, qpMap: Uint8Array): Uint8Array {
    const active = new Uint8Array(this.nblk);
    for (let i = 0; i < this.nblk; i++) active[i] = classes[i] === CLASS_BG ? 0 : 1;
    this.u8(this.classesPtr, this.nblk).set(active);
    this.u8(this.qpMapPtr, this.nblk).set(qpMap);
    this.growOut(1024);
    let need = this.x.hive_enc_foreground(
      this.curY, this.curU, this.curV,
      this.bgY, this.bgU, this.bgV,
      this.qpMapPtr, this.classesPtr, this.w, this.h,
      this.outPtr, this.outCap,
    );
    if (need > this.outCap) {
      this.growOut(need);
      need = this.x.hive_enc_foreground(
        this.curY, this.curU, this.curV,
        this.bgY, this.bgU, this.bgV,
        this.qpMapPtr, this.classesPtr, this.w, this.h,
        this.outPtr, this.outCap,
      );
    }
    return this.u8(this.outPtr, need).slice();
  }

  private copyIn(payload: Uint8Array): number {
    const ptr = this.growScratch(payload.length);
    this.u8(ptr, payload.length).set(payload);
    return ptr;
  }

  /** 解码关键帧到 dec 平面 */
  decodeKeyframe(payload: Uint8Array): void {
    const ptr = this.copyIn(payload);
    const rc = this.x.hive_dec_keyframe(
      ptr, payload.length, this.decY, this.decU, this.decV, this.w, this.h,
    );
    if (rc !== 0) throw new Error(`关键帧解码失败: ${rc}`);
  }

  /** 以独立 ref 背景平面为参考解码前景帧到 dec 平面 */
  decodeForeground(payload: Uint8Array, bgY: number, bgU: number, bgV: number): void {
    const ptr = this.copyIn(payload);
    const rc = this.x.hive_dec_foreground(
      ptr, payload.length, bgY, bgU, bgV,
      this.decY, this.decU, this.decV, this.w, this.h,
    );
    if (rc !== 0) throw new Error(`前景帧解码失败: ${rc}`);
  }

  /** 关键帧解码后,把重建结果固化为背景参考(解码链用) */
  setRefFromDecoded(): void {
    const nY = this.w * this.h;
    const nC = (this.w / 2) * (this.h / 2);
    this.u8(this.refY, nY * 2).set(this.u8(this.decY, nY * 2));
    this.u8(this.refU, nC * 2).set(this.u8(this.decU, nC * 2));
    this.u8(this.refV, nC * 2).set(this.u8(this.decV, nC * 2));
  }

  /** 把某个 dec/背景平面复制为背景(随机访问链解码用) */
  copyDecToBackground(): void {
    const nY = this.w * this.h;
    const nC = (this.w / 2) * (this.h / 2);
    this.u8(this.bgY, nY * 2).set(this.u8(this.decY, nY * 2));
    this.u8(this.bgU, nC * 2).set(this.u8(this.decU, nC * 2));
    this.u8(this.bgV, nC * 2).set(this.u8(this.decV, nC * 2));
  }

  get decodedRgba(): Uint8Array {
    return this.yuvToRgba(this.decY, this.decU, this.decV);
  }

  get backgroundRgba(): Uint8Array {
    return this.yuvToRgba(this.bgY, this.bgU, this.bgV);
  }

  /** 当前帧(原始)Y 平面副本,用于 PSNR 对照 */
  get currentY(): Int16Array {
    return this.i16(this.curY, this.w * this.h).slice();
  }

  get decodedY(): Int16Array {
    return this.i16(this.decY, this.w * this.h).slice();
  }

  /** 区域 PSNR:mask 为类别白名单(如蜜蜂区 = 爬行+飞行+携粉) */
  psnrRegion(classes: Uint8Array, mask: number[]): number {
    this.u8(this.classesPtr, this.nblk).set(classes);
    this.u8(this.maskPtr, 4).set(Uint8Array.from([...mask, 0, 0, 0, 0].slice(0, 4)));
    return this.x.hive_psnr_multi(
      this.curY, this.decY, this.w, this.h,
      this.classesPtr, this.maskPtr, mask.length,
    );
  }

  /** 全图 PSNR */
  psnrFull(): number {
    return this.x.hive_psnr_full(this.curY, this.decY, this.w, this.h);
  }

  /** 供速率控制读取块 SAD 与类别视图 */
  blockViews(): { classes: Uint8Array; sads: Uint32Array } {
    return {
      classes: this.u8(this.classesPtr, this.nblk),
      sads: new Uint32Array(
        this.x.memory.buffer, this.sadsPtr, this.nblk,
      ),
    };
  }

  /** 导出 YUV 平面的独立 ArrayBuffer 副本,供 Worker 分块分析 */
  yuvPlaneBuffers(): { bgY: ArrayBuffer; curY: ArrayBuffer; curU: ArrayBuffer; curV: ArrayBuffer } {
    const nY = this.w * this.h * 2;
    const nC = (this.w / 2) * (this.h / 2) * 2;
    return {
      bgY: this.u8(this.bgY, nY).slice().buffer,
      curY: this.u8(this.curY, nY).slice().buffer,
      curU: this.u8(this.curU, nC).slice().buffer,
      curV: this.u8(this.curV, nC).slice().buffer,
    };
  }

  writeQpMap(qp: Uint8Array): void {
    this.u8(this.qpMapPtr, this.nblk).set(qp);
  }
}
