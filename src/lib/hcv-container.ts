// HCVX seekable container:
//   "HCVX" | u32 version | u32 indexJsonLen | index JSON bytes | frame0 | frame1 | ...
// Index: { fps, frameSize:{w,h}, entries:[{second, offset, size}] }
// Offsets are absolute from the start of the file. Each payload is a self
// contained HCV1 intra frame, so seeking to an integer second is one index
// lookup + one WASM decode (no dependency on earlier frames).

export interface HcvIndexEntry {
  second: number;
  offset: number;
  size: number;
}
export interface HcvIndex {
  fps: number;
  width: number;
  height: number;
  entries: HcvIndexEntry[];
}

const MAGIC = [0x48, 0x43, 0x56, 0x58]; // HCVX
const VERSION = 1;

export function muxHcv(index: Omit<HcvIndex, 'entries'>, frames: { second: number; bytes: Uint8Array }[]): Blob {
  // Offsets depend on the index JSON length, whose digit widths can in turn
  // depend on offsets. Iterate to a stable header length (usually 1 pass).
  let indexBytes = new TextEncoder().encode(JSON.stringify({ ...index, entries: [] }));
  let entries: HcvIndexEntry[] = [];
  for (let pass = 0; pass < 6; pass++) {
    const headerLen = 12 + indexBytes.length;
    let off = headerLen;
    entries = frames.map((f) => {
      const e: HcvIndexEntry = { second: f.second, offset: off, size: f.bytes.length };
      off += f.bytes.length;
      return e;
    });
    const next = new TextEncoder().encode(JSON.stringify({ ...index, entries }));
    if (next.length === indexBytes.length) { indexBytes = next; break; }
    indexBytes = next;
  }
  const head = new Uint8Array(12);
  head.set(MAGIC, 0);
  new DataView(head.buffer).setUint32(4, VERSION, true);
  new DataView(head.buffer).setUint32(8, indexBytes.length, true);
  const chunks: BlobPart[] = [head, indexBytes];
  for (const f of frames) chunks.push(f.bytes.slice().buffer as ArrayBuffer);
  return new Blob(chunks, { type: 'application/octet-stream' });
}

export function demuxHcv(buf: ArrayBuffer): { index: HcvIndex; frameBytes: (e: HcvIndexEntry) => Uint8Array } {
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < 4; i++) if (u8[i] !== MAGIC[i]) throw new Error('不是 HCVX 容器');
  const dv = new DataView(buf);
  const indexLen = dv.getUint32(8, true);
  const indexJson = new TextDecoder().decode(u8.subarray(12, 12 + indexLen));
  const index = JSON.parse(indexJson) as HcvIndex;
  return {
    index,
    frameBytes: (e) => u8.subarray(e.offset, e.offset + e.size),
  };
}
