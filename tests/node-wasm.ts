// Node 环境下的 WASM 加载器(基准测试用),与浏览器端 src/wasm/codec.ts 同 ABI。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// 打包后文件位于 .bench-build,优先用环境变量,再尝试项目根的相对路径
const wasmPath =
  process.env.HVC_WASM_PATH ??
  resolve(here, '../../public/wasm/hive_codec.wasm');

export interface NodeWasmExports {
  memory: WebAssembly.Memory;
  hvc_alloc(size: number): number;
  hvc_free(ptr: number, cap: number): void;
  hvc_encoder_new(
    width: number, height: number, fps: number, frameCount: number,
    gop: number, targetBitrate: bigint, baseQp: number,
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

export async function loadNodeWasm(): Promise<NodeWasmExports> {
  const bytes = readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports as unknown as NodeWasmExports;
}

/** 与浏览器端 HvcEncoder 等价的 Node 封装。 */
export class NodeEncoder {
  readonly frameSize: number;
  readonly mbCount: number;
  constructor(private e: NodeWasmExports, private handle: number) {
    this.frameSize = e.hvc_encoder_frame_size(handle);
    this.mbCount = e.hvc_encoder_mb_count(handle);
  }

  static create(
    e: NodeWasmExports,
    cfg: {
      width: number; height: number; fps: number; frameCount: number;
      gop: number; targetBitrate: bigint; baseQp: number;
    },
  ): NodeEncoder {
    const h = e.hvc_encoder_new(
      cfg.width, cfg.height, cfg.fps, cfg.frameCount,
      cfg.gop, cfg.targetBitrate, cfg.baseQp,
    );
    if (!h) throw new Error('encoder_new failed');
    return new NodeEncoder(e, h);
  }

  writeFrame(rgb: Uint8Array, classes: Uint8Array): number {
    const e = this.e;
    const rp = e.hvc_alloc(rgb.length);
    const cp = e.hvc_alloc(classes.length);
    try {
      new Uint8Array(e.memory.buffer, rp, rgb.length).set(rgb);
      new Uint8Array(e.memory.buffer, cp, classes.length).set(classes);
      const r = e.hvc_encoder_write(this.handle, rp, cp);
      if (r < 0n) throw new Error(`write failed ${r}`);
      return Number(r);
    } finally {
      e.hvc_free(rp, rgb.length);
      e.hvc_free(cp, classes.length);
    }
  }

  bytesSoFar(): number {
    return Number(this.e.hvc_encoder_bytes_so_far(this.handle));
  }

  finish(): Uint8Array {
    const e = this.e;
    let cap = Math.max(this.bytesSoFar() + 4096, 1 << 16);
    for (let i = 0; i < 5; i++) {
      const p = e.hvc_alloc(cap);
      try {
        const r = e.hvc_encoder_finish(this.handle, p, cap);
        if (r >= 0n) {
          const out = new Uint8Array(new Uint8Array(e.memory.buffer, p, Number(r)));
          e.hvc_encoder_close(this.handle);
          return out;
        }
        cap *= 2;
      } finally {
        e.hvc_free(p, cap);
      }
    }
    throw new Error('finish retry exhausted');
  }
}

export class NodeDecoder {
  constructor(private e: NodeWasmExports, private handle: number) {}

  static open(e: NodeWasmExports, data: Uint8Array): NodeDecoder {
    const p = e.hvc_alloc(data.length);
    new Uint8Array(e.memory.buffer, p, data.length).set(data);
    const h = e.hvc_decoder_open(p, data.length);
    e.hvc_free(p, data.length);
    if (!h) throw new Error('decoder open failed');
    return new NodeDecoder(e, h);
  }

  info(): { width: number; height: number; frameCount: number; keyFrames: number } {
    const e = this.e;
    const p = e.hvc_alloc(64);
    try {
      const rc = e.hvc_decoder_info(this.handle, p);
      if (rc !== 0n) throw new Error('info failed');
      const dv = new DataView(e.memory.buffer, p, 40);
      return {
        width: dv.getUint32(0, true),
        height: dv.getUint32(4, true),
        frameCount: dv.getUint32(20, true),
        keyFrames: dv.getUint32(24, true),
      };
    } finally {
      e.hvc_free(p, 64);
    }
  }

  seek(target: number): Uint8Array {
    const e = this.e;
    const need = e.hvc_decoder_rgb_size(this.handle);
    const p = e.hvc_alloc(need);
    try {
      const rc = e.hvc_decoder_seek(this.handle, target, p, need);
      if (rc !== 0n) throw new Error(`seek failed ${rc}`);
      return new Uint8Array(new Uint8Array(e.memory.buffer, p, need));
    } finally {
      e.hvc_free(p, need);
    }
  }

  close(): void {
    this.e.hvc_decoder_close(this.handle);
  }
}

/** WASM 原生运动分析器(性能优于 TS 实现)。 */
export class NodeMotionAnalyzer {
  readonly mbCount: number;
  constructor(private e: NodeWasmExports, private handle: number, width: number, height: number) {
    this.mbCount = e.hvc_analyzer_mb_count(handle);
    void width;
    void height;
  }

  static create(e: NodeWasmExports, width: number, height: number): NodeMotionAnalyzer {
    const h = e.hvc_analyzer_new(width, height);
    if (!h) throw new Error('analyzer_new failed');
    return new NodeMotionAnalyzer(e, h, width, height);
  }

  analyze(rgb: Uint8Array): Uint8Array {
    const e = this.e;
    const rp = e.hvc_alloc(rgb.length);
    const cp = e.hvc_alloc(this.mbCount);
    try {
      new Uint8Array(e.memory.buffer, rp, rgb.length).set(rgb);
      const rc = e.hvc_analyze_frame(this.handle, rp, rgb.length, cp, this.mbCount);
      if (rc !== 0n) throw new Error(`analyze failed ${rc}`);
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
