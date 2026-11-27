// .hvc 容器:蜂箱专用压缩文件格式。
// 头部 + 帧序列 + 帧索引(支持 O(1) 随机定位)+ 尾部魔数。
// 块类别用 2bit RLE 内联,供对比页叠加显示,解码本身不依赖它。

export const MAGIC = 0x48564331; // 'HVC1'
export const END_MAGIC = 0x48454e44; // 'HEND'

export interface FrameIndexEntry {
  offset: number;
  payloadLen: number;
  classLen: number;
  type: number;
  trigger: number;
  lightDelta: number;
}

export interface ContainerFrame {
  type: number;
  trigger: number;
  lightDelta: number;
  payload: Uint8Array;
  classes: Uint8Array;
}

class ByteWriter {
  private chunks: Uint8Array[] = [];
  private len = 0;
  u8(v: number): void { this.chunks.push(Uint8Array.of(v & 0xff)); this.len += 1; }
  u16(v: number): void {
    this.chunks.push(Uint8Array.of((v >> 8) & 0xff, v & 0xff)); this.len += 2;
  }
  u32(v: number): void {
    this.chunks.push(Uint8Array.of(
      (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff,
    ));
    this.len += 4;
  }
  f32(v: number): void {
    const b = new ArrayBuffer(4);
    new DataView(b).setFloat32(0, v, false);
    this.chunks.push(new Uint8Array(b));
    this.len += 4;
  }
  bytes(b: Uint8Array): void { this.chunks.push(b); this.len += b.length; }
  get length(): number { return this.len; }
  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.len);
    let off = 0;
    for (const c of this.chunks) { out.set(c, off); off += c.length; }
    return out;
  }
}

export class HvcWriter {
  private w: number;
  private h: number;
  private fps: number;
  private frames: FrameIndexEntry[] = [];
  private body = new ByteWriter();

  constructor(w: number, h: number, fps: number) {
    this.w = w;
    this.h = h;
    this.fps = fps;
  }

  addFrame(
    type: number,
    payload: Uint8Array,
    classes: Uint8Array,
    lightDelta: number,
    trigger: number,
  ): void {
    const rle = encodeClassRle(classes);
    const offset = 24 + this.body.length; // 24 = 文件头长度
    this.frames.push({
      offset,
      payloadLen: payload.length,
      classLen: rle.length,
      type,
      trigger,
      lightDelta,
    });
    this.body.u8(type);
    this.body.u8(trigger);
    this.body.u16(0); // 保留
    this.body.u32(payload.length);
    this.body.u32(rle.length);
    this.body.f32(lightDelta);
    this.body.bytes(payload);
    this.body.bytes(rle);
  }

  toUint8Array(): Uint8Array {
    const out = new ByteWriter();
    out.u32(MAGIC);
    out.u32(this.w);
    out.u32(this.h);
    out.u32(this.fps);
    out.u32(this.frames.length);
    const indexOffsetPlaceholder = out.length;
    out.u32(0); // indexOffset 回填
    const body = this.body.toUint8Array();
    out.bytes(body);
    const indexOffset = out.length;
    for (const f of this.frames) {
      out.u32(f.offset);
      out.u32(f.payloadLen);
      out.u32(f.classLen);
      out.u8(f.type);
      out.u8(f.trigger);
      out.u16(0);
      out.f32(f.lightDelta); // 20 字节/条
    }
    out.u32(END_MAGIC);
    const result = out.toUint8Array();
    const dv = new DataView(result.buffer);
    dv.setUint32(20, indexOffset, false);
    return result;
  }
}

export class HvcReader {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frameCount: number;
  private buf: Uint8Array;
  private dv: DataView;
  readonly index: FrameIndexEntry[];

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (this.dv.getUint32(0, false) !== MAGIC) throw new Error('不是 .hvc 文件(魔数不匹配)');
    this.width = this.dv.getUint32(4, false);
    this.height = this.dv.getUint32(8, false);
    this.fps = this.dv.getUint32(12, false);
    this.frameCount = this.dv.getUint32(16, false);
    const indexOffset = this.dv.getUint32(20, false);
    this.index = [];
    let p = indexOffset;
    for (let i = 0; i < this.frameCount; i++) {
      const entry: FrameIndexEntry = {
        offset: this.dv.getUint32(p, false),
        payloadLen: this.dv.getUint32(p + 4, false),
        classLen: this.dv.getUint32(p + 8, false),
        type: this.dv.getUint8(p + 12),
        trigger: this.dv.getUint8(p + 13),
        lightDelta: this.dv.getFloat32(p + 16, false),
      };
      this.index.push(entry);
      p += 20;
    }
    if (this.dv.getUint32(p, false) !== END_MAGIC) throw new Error('尾部魔数损坏');
  }

  /** 给定帧号,返回其之前最近的关键帧号(O(1) 索引查询) */
  nearestKeyframe(frameNo: number): number {
    for (let i = Math.min(frameNo, this.frameCount - 1); i >= 0; i--) {
      if (this.index[i].type === 0) return i;
    }
    return 0;
  }

  readFrame(frameNo: number): ContainerFrame {
    const e = this.index[frameNo];
    const p = e.offset;
    const payloadStart = p + 16; // 帧头 16 字节
    const payload = this.buf.slice(payloadStart, payloadStart + e.payloadLen);
    const rle = this.buf.slice(
      payloadStart + e.payloadLen,
      payloadStart + e.payloadLen + e.classLen,
    );
    return {
      type: e.type,
      trigger: e.trigger,
      lightDelta: e.lightDelta,
      payload,
      classes: decodeClassRle(rle),
    };
  }

  get durationSeconds(): number {
    return this.frameCount / this.fps;
  }
}

/** 2bit RLE:每字节 = (count-1)<<2 | class,单次行程最长 64 */
export function encodeClassRle(classes: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < classes.length) {
    const c = classes[i];
    let count = 1;
    while (i + count < classes.length && classes[i + count] === c && count < 64) count++;
    out.push(((count - 1) << 2) | (c & 3));
    i += count;
  }
  return Uint8Array.from(out);
}

export function decodeClassRle(rle: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (const b of rle) {
    const count = (b >> 2) + 1;
    const c = b & 3;
    for (let k = 0; k < count; k++) out.push(c);
  }
  return Uint8Array.from(out);
}
