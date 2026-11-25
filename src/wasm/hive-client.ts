// Typed wrapper around the raw-C-ABI HCV1 WebAssembly module.
import wasmUrl from './hive_codec.wasm?url';

export interface FrameProcessResult {
  stats: FrameStats;
  uniformRgba: Uint8ClampedArray;
  roiRgba: Uint8ClampedArray;
  qmap: Uint8Array;
  gridW: number;
  gridH: number;
  roiBits: Uint8Array;
}

export interface FrameStats {
  uniformBytes: number;
  roiBytes: number;
  byteRatio: number;
  qRoi: number;
  gridW: number;
  gridH: number;
  overallUniformPsnr: number;
  overallRoiPsnr: number;
  beeUniformPsnr: number;
  beeRoiPsnr: number;
  deltaBeeDb: number;
  bgUniformPsnr: number;
  bgRoiPsnr: number;
}

type WasmExports = Record<string, (...args: any[]) => number> & {
  memory: WebAssembly.Memory;
};

export class HiveWasm {
  private ex: WasmExports;

  private constructor(instance: WebAssembly.Instance) {
    this.ex = instance.exports as unknown as WasmExports;
  }

  static async load(url: string = wasmUrl): Promise<HiveWasm> {
    const resp = await fetch(url);
    const bytes = await resp.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const api = new HiveWasm(instance);
    if (api.ex.hc_ping() !== 0x48433130) {
      throw new Error('WASM 核心校验失败 (hc_ping magic mismatch)');
    }
    return api;
  }

  private u8(): Uint8Array {
    return new Uint8Array(this.ex.memory.buffer);
  }

  /** Allocate + write a byte/string payload. Returns pointer; caller frees. */
  private writeBytes(data: ArrayLike<number> | string): { ptr: number; len: number } {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const len = bytes.length;
    const ptr = this.ex.hc_alloc(len);
    new Uint8Array(this.ex.memory.buffer).set(bytes as Uint8Array, ptr);
    return { ptr, len };
  }

  private readJson(ptrFn: string, lenFn: string, len: number): any {
    const ptr = this.ex[ptrFn]();
    const text = new TextDecoder().decode(this.u8().subarray(ptr, ptr + len));
    return JSON.parse(text);
  }

  benchmark(spec: string): any {
    const s = this.writeBytes(spec);
    const n = this.ex.hc_benchmark(s.ptr, s.len);
    this.ex.hc_dealloc(s.ptr, s.len);
    return this.readJson('hc_json_ptr', 'hc_json_len', n);
  }

  throughput(spec: string): any {
    const s = this.writeBytes(spec);
    const n = this.ex.hc_throughput(s.ptr, s.len);
    this.ex.hc_dealloc(s.ptr, s.len);
    return this.readJson('hc_json_ptr', 'hc_json_len', n);
  }

  processFrame(opts: {
    rgba: Uint8ClampedArray | Uint8Array;
    width: number;
    height: number;
    qUniform: number;
    weights?: Float32Array | number[];
    mask?: Uint8Array | null;
  }): FrameProcessResult {
    const { width: w, height: h } = opts;
    const rgbaLen = w * h * 4;
    const rgbaPtr = this.ex.hc_alloc(rgbaLen);
    this.u8().set(opts.rgba as ArrayLike<number>, rgbaPtr);

    let maskPtr = 0;
    if (opts.mask) {
      maskPtr = this.ex.hc_alloc(w * h);
      this.u8().set(opts.mask, maskPtr);
    }

    const gw = Math.ceil(w / 16);
    const gh = Math.ceil(h / 16);
    const nW = gw * gh;
    let wPtr = 0;
    if (opts.weights) {
      wPtr = this.ex.hc_alloc(nW * 4);
      const f32 = new Float32Array(this.ex.memory.buffer, wPtr, nW);
      f32.set(opts.weights as ArrayLike<number>);
    }

    const status = this.ex.hc_process_frame(
      rgbaPtr, maskPtr, w, h, opts.qUniform | 0, wPtr, nW,
    );

    this.ex.hc_dealloc(rgbaPtr, rgbaLen);
    if (maskPtr) this.ex.hc_dealloc(maskPtr, w * h);
    if (wPtr) this.ex.hc_dealloc(wPtr, nW * 4);
    if (status !== 0) throw new Error(`hc_process_frame failed: ${status}`);

    const jsonLen = this.ex.hc_json_len();
    const stats = this.readJson('hc_json_ptr', 'hc_json_len', jsonLen) as FrameStats;

    const copyOut = (ptrFn: string, lenFn: string): Uint8Array => {
      const p = this.ex[ptrFn]();
      const n = this.ex[lenFn]();
      return this.u8().slice(p, p + n);
    };

    const uniformRgba = new Uint8ClampedArray(copyOut('hc_uniform_rgba_ptr', 'hc_uniform_rgba_len'));
    const roiRgba = new Uint8ClampedArray(copyOut('hc_roi_rgba_ptr', 'hc_roi_rgba_len'));
    const qmap = copyOut('hc_qmap_ptr', 'hc_qmap_len');
    const roiBits = copyOut('hc_bits_ptr', 'hc_bits_len');
    const gridW = this.ex.hc_grid_w();
    const gridH = this.ex.hc_grid_h();

    return { stats, uniformRgba, roiRgba, qmap, gridW, gridH, roiBits };
  }

  /** Decode HCV1 intra bytes; times the call when requested by caller. */
  decodeIntra(data: Uint8Array): { rgba: Uint8ClampedArray; width: number; height: number } {
    const ptr = this.ex.hc_alloc(data.length);
    this.u8().set(data, ptr);
    const status = this.ex.hc_decode_intra(ptr, data.length);
    this.ex.hc_dealloc(ptr, data.length);
    if (status !== 0) throw new Error(`hc_decode_intra failed: ${status}`);
    const p = this.ex.hc_decoded_ptr();
    const n = this.ex.hc_decoded_len();
    const rgba = new Uint8ClampedArray(this.u8().slice(p, p + n));
    return { rgba, width: this.ex.hc_decoded_w(), height: this.ex.hc_decoded_h() };
  }
}
