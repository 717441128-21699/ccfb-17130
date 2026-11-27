// 冒烟测试执行体(经 esbuild 打包,在 Node 实例化同一 wasm)。
import { SyntheticVideoGenerator } from '../src/core/synthetic';
import { MotionAnalyzer } from '../src/core/motion';
import { MB } from '../src/core/types';
import { loadNodeWasm, NodeDecoder, NodeEncoder, NodeMotionAnalyzer } from './node-wasm';

const wasm = await loadNodeWasm();

function pad(frame: { data: Uint8Array; width: number; height: number }, pw: number, ph: number): Uint8Array {
  const out = new Uint8Array(pw * ph * 3);
  for (let y = 0; y < frame.height; y++) {
    out.set(frame.data.subarray(y * frame.width * 3, (y + 1) * frame.width * 3), y * pw * 3);
  }
  return out;
}

export async function smokeCodecRoundtrip() {
  const W = 160;
  const H = 128;
  const N = 40;
  const FPS = 200;
  const cfg = { width: W, height: H, frames: N, fps: FPS, lighting: 'bright' as const, traffic: 'normal' as const, seed: 42 };
  const gen = new SyntheticVideoGenerator(cfg);
  const analyzer = new MotionAnalyzer(W, H);
  const mbCols = gen.mbCols;
  const pw = mbCols * MB;
  const ph = gen.mbRows * MB;

  const enc = NodeEncoder.create(wasm, {
    width: W, height: H, fps: FPS, frameCount: N, gop: 10,
    targetBitrate: 0n, baseQp: 6,
  });
  const frames: { data: Uint8Array; width: number; height: number }[] = [];
  const maps: Uint8Array[] = [];
  for (let t = 0; t < N; t++) {
    const { frame } = gen.generate(t);
    frames.push(frame);
    maps.push(analyzer.analyze(frame).classMap);
    enc.writeFrame(pad(frame, pw, ph), maps[t]);
  }
  const file = enc.finish();
  const dec = NodeDecoder.open(wasm, file);
  assertInfo(dec.info(), N);

  // 随机 seek 多个目标,测延迟与背景 PSNR
  const targets = [0, 10, 20, 39];
  let maxSeekMs = 0;
  let se = 0;
  let n = 0;
  for (const tg of targets) {
    const t0 = performance.now();
    const rgb = dec.seek(tg);
    maxSeekMs = Math.max(maxSeekMs, performance.now() - t0);
    const map = maps[tg];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const m = Math.floor(y / MB) * mbCols + Math.floor(x / MB);
        if (map[m] !== 0) continue; // 仅背景像素
        const i = (y * W + x) * 3;
        const d = luma(rgb[i], rgb[i + 1], rgb[i + 2]) - luma(frames[tg].data[i], frames[tg].data[i + 1], frames[tg].data[i + 2]);
        se += d * d;
        n++;
      }
    }
  }
  dec.close();
  return {
    frameCount: N,
    maxSeekMs,
    backgroundPsnr: 10 * Math.log10((255 * 255) / (se / n)),
    fileBytes: file.length,
  };
}

export async function smokeAnalyzerParity() {
  const W = 160;
  const H = 128;
  const N = 30;
  const cfg = { width: W, height: H, frames: N, fps: 200, lighting: 'overcast' as const, traffic: 'dense' as const, seed: 9 };
  const gen = new SyntheticVideoGenerator(cfg);
  const ts = new MotionAnalyzer(W, H);
  const wa = NodeMotionAnalyzer.create(wasm, W, H);
  let agree = 0;
  let total = 0;
  for (let t = 0; t < N; t++) {
    const { frame } = gen.generate(t);
    const tm = ts.analyze(frame).classMap;
    const wm = wa.analyze(frame.data);
    for (let m = 0; m < tm.length; m++) {
      if (tm[m] === wm[m]) agree++;
      total++;
    }
  }
  wa.close();
  return { agreement: agree / total };
}

function assertInfo(info: { frameCount: number; keyFrames: number }, n: number) {
  if (info.frameCount !== n) throw new Error(`frameCount 失配:${info.frameCount}`);
  if (info.keyFrames < 1) throw new Error('应至少有一个关键帧');
}

function luma(r: number, g: number, b: number): number {
  return (19595 * r + 38470 * g + 7471 * b + 32768) >> 16;
}
