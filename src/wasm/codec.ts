// WebAssembly 编解码核心的 TS 封装:手工实例化纯 C ABI wasm,
// 管理线性内存分配与句柄生命周期。
import wasmUrl from '/wasm/hive_codec.wasm?url';

export interface HvcDecInfo {
  width: number;
  height: number;
  paddedWidth: number;
  paddedHeight: number;
  fps: number;
  frameCount: number;
  keyFrames: number;
  targetBitrate: bigint;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  hvc_alloc(size: number): number;
  hvc_free(ptr: number, cap: number): void;
  hvc_encoder_new(
    width: number,
    height: number,
    fps: number,
    frameCount: number,
    gop: number,
    targetBitrate: bigint,
    baseQp: number,
  ): number;
  hvc_encoder_frame_size(h: number): number;
  hvc_encoder_mb_count(h: number): number;
  hvc_encoder_write(h: number, rgb: number, classes: number): bigint;
  hvc_encoder_finish(h: number, out: number, cap: number): bigint;
  hvc_encoder_bytes_so_far(h: number): bigint;
  hvc_encoder_close(h: number): void;
  hvc_decoder_open(ptr: number, len: number): number;
  hvc_decoder_info(h: number, info: number): bigint;
  hvc_decoder_rgb_size(h: number): number;
  hvc_decoder_seek(h: number, target: number, out: number, cap: number): bigint;
  hvc_decoder_close(h: number): void;
  hvc_analyzer_new(width: number, height: number): number;
  hvc_analyzer_mb_count(h: number): number;
  hvc_analyze_frame(h: number, rgb: number, rgb_len: number, out: number, out_len: number): bigint;
  hvc_analyzer_close(h: number): void;
}

let cached: Promise<WasmExports> | null = null;

export function loadWasm(): Promise<WasmExports> {
  if (!cached) {
    cached = WebAssembly.instantiateStreaming(fetch(wasmUrl)).then((r) => {
      const e = r.instance.exports as unknown as WasmExports;
      if (typeof e.hvc_encoder_new !== 'function') {
        throw new Error('wasm 导出不完整:可能编译产物损坏');
      }
      return e;
    });
  }
  return cached;
}

/** 在 wasm 线性内存中分配一段作用域缓冲,退出时自动释放。 */
export class WasmBuffer {
  constructor(
    public readonly ptr: number,
    public readonly cap: number,
    private readonly mem: WebAssembly.Memory,
    private readonly freeFn: (p: number, c: number) => void,
  ) {}

  u8(): Uint8Array {
    return new Uint8Array(this.mem.buffer, this.ptr, this.cap);
  }

  close(): void {
    this.freeFn(this.ptr, this.cap);
  }
}

export class WasmCodec {
  private constructor(public readonly e: WasmExports) {}

  static async create(): Promise<WasmCodec> {
    return new WasmCodec(await loadWasm());
  }

  alloc(cap: number): WasmBuffer {
    const ptr = this.e.hvc_alloc(cap);
    if (!ptr) throw new Error('wasm 内存分配失败');
    return new WasmBuffer(ptr, cap, this.e.memory, this.e.hvc_free);
  }

  async createMotionAnalyzer(width: number, height: number): Promise<WasmMotionAnalyzer> {
    return WasmMotionAnalyzer.create(width, height);
  }

  createEncoder(cfg: {
    width: number;
    height: number;
    fps: number;
    frameCount: number;
    gop: number;
    targetBitrate: bigint;
    baseQp: number;
  }): HvcEncoder {
    const h = this.e.hvc_encoder_new(
      cfg.width,
      cfg.height,
      cfg.fps,
      cfg.frameCount,
      cfg.gop,
      cfg.targetBitrate,
      cfg.baseQp,
    );
    if (!h) throw new Error('编码器创建失败');
    return new HvcEncoder(this.e, h);
  }

  openDecoder(data: Uint8Array): HvcDecoder {
    const buf = this.alloc(data.length);
    buf.u8().set(data);
    const h = this.e.hvc_decoder_open(buf.ptr, data.length);
    buf.close();
    if (!h) throw new Error('解码器打开失败:文件格式错误');
    return new HvcDecoder(this.e, h);
  }
}

export class HvcEncoder {
  readonly frameSize: number;
  readonly mbCount: number;

  constructor(
    private readonly e: WasmExports,
    private readonly handle: number,
  ) {
    this.frameSize = e.hvc_encoder_frame_size(handle);
    this.mbCount = e.hvc_encoder_mb_count(handle);
  }

  /** 写入一帧:rgb 为 padded RGB,classes 为 MB 类别图。返回编码 MB 数。 */
  writeFrame(rgb: Uint8Array, classes: Uint8Array): number {
    if (rgb.length !== this.frameSize) throw new Error('rgb 尺寸不匹配');
    if (classes.length !== this.mbCount) throw new Error('类别图尺寸不匹配');
    const rgbBuf = new WasmBuffer(
      this.e.hvc_alloc(rgb.length),
      rgb.length,
      this.e.memory,
      this.e.hvc_free,
    );
    const clsBuf = new WasmBuffer(
      this.e.hvc_alloc(classes.length),
      classes.length,
      this.e.memory,
      this.e.hvc_free,
    );
    try {
      rgbBuf.u8().set(rgb);
      clsBuf.u8().set(classes);
      const r = this.e.hvc_encoder_write(this.handle, rgbBuf.ptr, clsBuf.ptr);
      if (r < 0n) throw new Error(`编码失败 code=${r}`);
      return Number(r);
    } finally {
      rgbBuf.close();
      clsBuf.close();
    }
  }

  bytesSoFar(): bigint {
    return this.e.hvc_encoder_bytes_so_far(this.handle);
  }

  /** 完成编码并取回文件字节(句柄随之关闭)。 */
  finish(): Uint8Array {
    // 先按当前大小试探,不足则按返回的需要扩容
    let cap = Math.max(Number(this.bytesSoFar()) + 4096, 1 << 16);
    for (let attempt = 0; attempt < 4; attempt++) {
      const buf = new WasmBuffer(
        this.e.hvc_alloc(cap),
        cap,
        this.e.memory,
        this.e.hvc_free,
      );
      try {
        const r = this.e.hvc_encoder_finish(this.handle, buf.ptr, cap);
        if (r >= 0n) {
          const out = buf.u8().slice(0, Number(r));
          this.e.hvc_encoder_close(this.handle);
          return out;
        }
        cap = cap * 2;
      } finally {
        buf.close();
      }
    }
    throw new Error('finish 重试次数耗尽');
  }
}

export class HvcDecoder {
  constructor(
    private readonly e: WasmExports,
    private readonly handle: number,
  ) {}

  info(): HvcDecInfo {
    // DecInfo C 布局:7 个 u32(28B)+ 4B 对齐填充 + u64(8B)= 40 字节
    const buf = new WasmBuffer(
      this.e.hvc_alloc(64),
      64,
      this.e.memory,
      this.e.hvc_free,
    );
    try {
      const rc = this.e.hvc_decoder_info(this.handle, buf.ptr);
      if (rc !== 0n) throw new Error('decoder_info 失败');
      const dv = new DataView(buf.u8().buffer, buf.ptr, 40);
      return {
        width: dv.getUint32(0, true),
        height: dv.getUint32(4, true),
        paddedWidth: dv.getUint32(8, true),
        paddedHeight: dv.getUint32(12, true),
        fps: dv.getUint32(16, true),
        frameCount: dv.getUint32(20, true),
        keyFrames: dv.getUint32(24, true),
        targetBitrate: dv.getBigUint64(32, true),
      };
    } finally {
      buf.close();
    }
  }

  rgbSize(): number {
    return this.e.hvc_decoder_rgb_size(this.handle);
  }

  /** 随机访问解码第 target 帧,返回裁剪后原始尺寸的 RGB。 */
  seek(target: number): Uint8Array {
    const need = this.rgbSize();
    const buf = new WasmBuffer(
      this.e.hvc_alloc(need),
      need,
      this.e.memory,
      this.e.hvc_free,
    );
    try {
      const rc = this.e.hvc_decoder_seek(this.handle, target, buf.ptr, need);
      if (rc !== 0n) throw new Error(`seek 解码失败 code=${rc}`);
      return buf.u8().slice();
    } finally {
      buf.close();
    }
  }

  close(): void {
    this.e.hvc_decoder_close(this.handle);
  }
}

/** WASM 原生运动分析器:与 TS MotionAnalyzer 算法等价,吞吐更高、内存占用更低。 */
export class WasmMotionAnalyzer {
  private e: WasmExports;
  private handle: number;
  readonly mbCount: number;

  private constructor(e: WasmExports, handle: number) {
    this.e = e;
    this.handle = handle;
    this.mbCount = e.hvc_analyzer_mb_count(handle);
  }

  static async create(width: number, height: number): Promise<WasmMotionAnalyzer> {
    const e = await loadWasm();
    const h = e.hvc_analyzer_new(width, height);
    if (!h) throw new Error('analyzer 创建失败');
    return new WasmMotionAnalyzer(e, h);
  }

  /** 分析一帧 RGB,返回类别图(长度 mbCount)。 */
  analyze(rgb: Uint8Array): Uint8Array {
    const e = this.e;
    const rp = e.hvc_alloc(rgb.length);
    const cp = e.hvc_alloc(this.mbCount);
    try {
      new Uint8Array(e.memory.buffer, rp, rgb.length).set(rgb);
      const rc = e.hvc_analyze_frame(this.handle, rp, rgb.length, cp, this.mbCount);
      if (rc !== 0n) throw new Error(`运动分析失败 code=${rc}`);
      return new Uint8Array(new Uint8Array(e.memory.buffer, cp, this.mbCount));
    } finally {
      e.hvc_free(rp, rgb.length);
      e.hvc_free(cp, this.mbCount);
    }
  }

  close(): void {
    this.e.hvc_analyzer_close(this.handle);
  }
}
