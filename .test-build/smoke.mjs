// src/core/types.ts
var MB = 16;

// src/core/synthetic.ts
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
var LIGHTING_GAIN = {
  bright: 1,
  overcast: 0.72,
  dusk: 0.48
};
var TRAFFIC_COUNT = {
  sparse: 3,
  normal: 7,
  dense: 14
};
function lightingDrift(t) {
  return 1 + 0.06 * Math.sin(t / 200 * Math.PI * 2);
}
var SyntheticVideoGenerator = class {
  constructor(cfg) {
    this.cfg = cfg;
    this.rand = rng(cfg.seed);
    this.width = cfg.width;
    this.height = cfg.height;
    this.frames = cfg.frames;
    this.fps = cfg.fps;
    this.gain = LIGHTING_GAIN[cfg.lighting] ?? 1;
    this.bgBase = new Uint8Array(cfg.width * cfg.height * 3);
    this.entranceX = Math.floor(cfg.width * 0.5);
    this.entranceY = Math.floor(cfg.height * 0.32);
    this.paintStaticBackground();
    this.spawnBees();
  }
  rand;
  bees = [];
  bgBase;
  width;
  height;
  frames;
  fps;
  gain;
  entranceX;
  entranceY;
  get mbCols() {
    return Math.ceil(this.width / MB);
  }
  get mbRows() {
    return Math.ceil(this.height / MB);
  }
  /** 绘制时间稳定的木板 + 巢门开口。 */
  paintStaticBackground() {
    const { width: w, height: h } = this;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        const grain = Math.floor(Math.sin(x / 9) * 8 + Math.sin(x / 23) * 5);
        const plank = Math.floor(y / 28) % 2 * 10;
        const r = 118 + grain + plank;
        const g = 86 + grain * 0.7 + plank * 0.7;
        const b = 52 + grain * 0.4;
        this.bgBase[i] = r;
        this.bgBase[i + 1] = g;
        this.bgBase[i + 2] = b;
      }
    }
    this.fillEllipse(this.entranceX, this.entranceY, w * 0.22, h * 0.12, [28, 22, 18]);
  }
  fillEllipse(cx, cy, rx, ry, col) {
    const { width: w, height: h } = this;
    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(w - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(h - 1, Math.ceil(cy + ry));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        if (nx * nx + ny * ny <= 1) {
          const i = (y * w + x) * 3;
          this.bgBase[i] = col[0];
          this.bgBase[i + 1] = col[1];
          this.bgBase[i + 2] = col[2];
        }
      }
    }
  }
  spawnBees() {
    const n = TRAFFIC_COUNT[this.cfg.traffic] ?? 7;
    for (let k = 0; k < n; k++) {
      const flying = this.rand() > 0.35;
      this.bees.push({
        x: this.rand() * this.width,
        y: flying ? this.height * (0.15 + this.rand() * 0.5) : this.height * (0.55 + this.rand() * 0.35),
        vx: (this.rand() > 0.5 ? 1 : -1) * (flying ? 1.6 + this.rand() * 2.2 : 0.15 + this.rand() * 0.3),
        vy: (this.rand() - 0.5) * (flying ? 1.2 : 0.2),
        flying,
        // 约 35% 的归巢蜂携带花粉团
        hasPollen: this.rand() < 0.35,
        phase: this.rand() * Math.PI * 2
      });
    }
  }
  /** 生成第 t 帧的 RGB、ground-truth 类别图与像素级蜜蜂掩码。 */
  generate(t) {
    const { width: w, height: h } = this;
    const data = new Uint8Array(w * h * 3);
    const pixelMask = new Uint8Array(w * h);
    const drift = lightingDrift(t);
    for (let i = 0; i < data.length; i += 3) {
      data[i] = clamp8(this.bgBase[i] * this.gain * drift);
      data[i + 1] = clamp8(this.bgBase[i + 1] * this.gain * drift);
      data[i + 2] = clamp8(this.bgBase[i + 2] * this.gain * drift);
    }
    const gt = new Uint8Array(this.mbCols * this.mbRows);
    for (const bee of this.bees) {
      this.updateBee(bee, t);
      this.drawBee(data, bee, t, pixelMask);
      this.markGroundTruth(gt, bee);
    }
    return {
      frame: { width: w, height: h, data },
      groundTruth: gt,
      pixelMask
    };
  }
  updateBee(bee, t) {
    bee.x += bee.vx;
    bee.y += bee.vy;
    bee.phase += bee.flying ? 1.4 : 0.3;
    if (bee.x < 8 || bee.x > this.width - 8) bee.vx = -bee.vx;
    if (bee.y < 8 || bee.y > this.height - 8) bee.vy = -bee.vy;
    bee.x = clamp(bee.x, 8, this.width - 8);
    bee.y = clamp(bee.y, 8, this.height - 8);
  }
  drawBee(data, bee, t, pixelMask) {
    const { width: w } = this;
    const bodyR = 7;
    const bodyH = 8;
    const mark = (x, y) => {
      if (pixelMask && x >= 0 && y >= 0 && x < w && y < this.height) pixelMask[y * w + x] = 1;
    };
    for (let dy = -bodyH; dy <= bodyH; dy++) {
      for (let dx = -bodyR; dx <= bodyR; dx++) {
        const nx = dx / bodyR;
        const ny = dy / bodyH;
        if (nx * nx + ny * ny > 1) continue;
        const x = Math.round(bee.x + dx);
        const y = Math.round(bee.y + dy);
        if (x < 0 || y < 0 || x >= w || y >= this.height) continue;
        mark(x, y);
        const stripe = Math.floor((dx + bodyR) / 3.2) % 2 === 0;
        const i = (y * w + x) * 3;
        if (stripe) {
          data[i] = 214;
          data[i + 1] = 168;
          data[i + 2] = 48;
        } else {
          data[i] = 46;
          data[i + 1] = 38;
          data[i + 2] = 28;
        }
      }
    }
    if (bee.flying) {
      const flap = Math.abs(Math.sin(bee.phase));
      const wingRx = 6;
      const wingRy = 3 + flap * 3;
      this.drawWing(data, bee.x - 4, bee.y - bodyH - 2, wingRx, wingRy);
      this.drawWing(data, bee.x + 4, bee.y - bodyH - 2, wingRx, wingRy);
    }
    if (bee.hasPollen) {
      this.drawPixel(data, bee.x - 5, bee.y + bodyH - 1, [240, 205, 70], pixelMask);
      this.drawPixel(data, bee.x + 5, bee.y + bodyH - 1, [240, 205, 70], pixelMask);
      this.drawPixel(data, bee.x - 5, bee.y + bodyH, [225, 185, 55], pixelMask);
      this.drawPixel(data, bee.x + 5, bee.y + bodyH, [225, 185, 55], pixelMask);
    }
  }
  drawWing(data, cx, cy, rx, ry) {
    const { width: w, height: h } = this;
    for (let dy = -Math.ceil(ry); dy <= Math.ceil(ry); dy++) {
      for (let dx = -Math.ceil(rx); dx <= Math.ceil(rx); dx++) {
        if (dx * dx / (rx * rx) + dy * dy / (ry * ry + 0.01) > 1) continue;
        const x = Math.round(cx + dx);
        const y = Math.round(cy + dy);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = (y * w + x) * 3;
        data[i] = clamp8(data[i] * 0.5 + 230 * 0.5);
        data[i + 1] = clamp8(data[i + 1] * 0.5 + 235 * 0.5);
        data[i + 2] = clamp8(data[i + 2] * 0.5 + 245 * 0.5);
      }
    }
  }
  drawPixel(data, x, y, col, pixelMask) {
    const { width: w, height: h } = this;
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    if (pixelMask) pixelMask[y * w + x] = 1;
    const i = (y * w + x) * 3;
    data[i] = col[0];
    data[i + 1] = col[1];
    data[i + 2] = col[2];
  }
  /** 把蜜蜂覆盖到的 MB 标记为对应类别(ground truth)。 */
  markGroundTruth(gt, bee) {
    const r = 10;
    const x0 = Math.floor((bee.x - r) / MB);
    const x1 = Math.floor((bee.x + r) / MB);
    const y0 = Math.floor((bee.y - r) / MB);
    const y1 = Math.floor((bee.y + r) / MB);
    const cls = bee.hasPollen ? 3 /* Pollen */ : bee.flying ? 2 /* Flying */ : 1 /* Crawling */;
    for (let my = y0; my <= y1; my++) {
      for (let mx = x0; mx <= x1; mx++) {
        if (mx < 0 || my < 0 || mx >= this.mbCols || my >= this.mbRows) continue;
        const idx = my * this.mbCols + mx;
        if (cls > gt[idx]) gt[idx] = cls;
      }
    }
  }
};
function clamp8(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// src/core/motion.ts
var BG_ALPHA = 0.04;
var LIGHTING_CHANGE_LUMA = 6;
var FG_SAD_PER_PIXEL = 14;
var POLLEN_SAT = 90;
var FAST_SPEED = 1.2;
var MotionAnalyzer = class _MotionAnalyzer {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.mbCols = Math.ceil(width / MB);
    this.mbRows = Math.ceil(height / MB);
    const n = width * height;
    this.bg = new Float32Array(n);
    this.tracks = Array.from({ length: this.mbCols * this.mbRows }, () => ({
      cx: 0,
      cy: 0,
      speed: 0
    }));
  }
  mbCols;
  mbRows;
  // 浮点背景模型:V8 对 Float32Array 的乘加优化优于整数除法。
  bg;
  bgReady = false;
  tracks;
  frameCount = 0;
  /** BT.601 full-range 亮度。 */
  static luma(r, g, b) {
    return 19595 * r + 38470 * g + 7471 * b + 32768 >> 16;
  }
  /** 分析一帧,返回类别图与统计。luma 单遍预计算,MB 处理复用。 */
  analyze(frame) {
    const { width: w, height: h, data } = frame;
    const n = w * h;
    const luma2 = new Uint8Array(n);
    let lumaSum = 0;
    for (let p = 0; p < n; p++) {
      const y = _MotionAnalyzer.luma(data[p * 3], data[p * 3 + 1], data[p * 3 + 2]);
      luma2[p] = y;
      lumaSum += y;
    }
    const meanLuma = lumaSum / n;
    let lightingChanged = false;
    if (this.bgReady) {
      let bgSum = 0;
      for (let p = 0; p < n; p += 16) bgSum += this.bg[p];
      const bgMean = bgSum * 16 / n;
      lightingChanged = Math.abs(meanLuma - bgMean) > LIGHTING_CHANGE_LUMA;
    } else {
      for (let p = 0; p < n; p++) this.bg[p] = luma2[p];
      this.bgReady = true;
    }
    const classMap = new Uint8Array(this.mbCols * this.mbRows);
    const counts = [0, 0, 0, 0];
    const keep = 1 - (lightingChanged ? BG_ALPHA * 4 : BG_ALPHA);
    const emaAlpha = lightingChanged ? BG_ALPHA * 4 : BG_ALPHA;
    for (let my = 0; my < this.mbRows; my++) {
      for (let mx = 0; mx < this.mbCols; mx++) {
        const m = my * this.mbCols + mx;
        const stats = this.blockStats(luma2, data, mx, my);
        const isForeground = stats.sad / stats.samples > FG_SAD_PER_PIXEL;
        if (!isForeground) {
          classMap[m] = 0 /* Background */;
          const x0 = mx * MB;
          const y0 = my * MB;
          for (let dy = 0; dy < MB; dy++) {
            const y = y0 + dy < h ? y0 + dy : h - 1;
            const rowBase = y * w;
            for (let dx = 0; dx < MB; dx++) {
              const x = x0 + dx < w ? x0 + dx : w - 1;
              const p = rowBase + x;
              this.bg[p] = this.bg[p] * keep + luma2[p] * emaAlpha;
            }
          }
        } else {
          const track = this.tracks[m];
          track.speed = this.estimateSpeed(track, stats.cx, stats.cy);
          track.cx = stats.cx;
          track.cy = stats.cy;
          if (stats.sat > POLLEN_SAT) {
            classMap[m] = 3 /* Pollen */;
          } else if (track.speed >= FAST_SPEED) {
            classMap[m] = 2 /* Flying */;
          } else {
            classMap[m] = 1 /* Crawling */;
          }
        }
        counts[classMap[m]]++;
      }
    }
    this.frameCount++;
    return {
      classMap,
      mbCols: this.mbCols,
      mbRows: this.mbRows,
      counts,
      meanLuma
    };
  }
  /** 计算一个 MB 的前景 SAD、最大饱和度与质心。 */
  blockStats(luma2, data, mx, my) {
    const { width: w, height: h } = this;
    const x0 = mx * MB;
    const y0 = my * MB;
    let sad = 0;
    let satMax = 0;
    let wx = 0;
    let wy = 0;
    let weight = 0;
    for (let dy = 0; dy < MB; dy++) {
      const y = y0 + dy < h ? y0 + dy : h - 1;
      const rowBase = y * w;
      for (let dx = 0; dx < MB; dx++) {
        const x = x0 + dx < w ? x0 + dx : w - 1;
        const p = rowBase + x;
        const diff = Math.abs(luma2[p] - this.bg[p]);
        sad += diff;
        const i = p * 3;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const s = Math.max(r, g, b) - Math.min(r, g, b);
        if (s > satMax) satMax = s;
        wx += dx * diff;
        wy += dy * diff;
        weight += diff;
      }
    }
    const samples = MB * MB;
    const cx = weight > 0 ? x0 + wx / weight : x0 + MB / 2;
    const cy = weight > 0 ? y0 + wy / weight : y0 + MB / 2;
    return { sad, sat: satMax, cx, cy, samples };
  }
  /** 基于质心位移估计块速度(指数平滑)。 */
  estimateSpeed(track, cx, cy) {
    if (this.frameCount === 0) return 0;
    const inst = Math.hypot(cx - track.cx, cy - track.cy);
    return track.speed * 0.6 + inst * 0.4;
  }
};

// tests/node-wasm.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
var here = dirname(fileURLToPath(import.meta.url));
var wasmPath = process.env.HVC_WASM_PATH ?? resolve(here, "../../public/wasm/hive_codec.wasm");
async function loadNodeWasm() {
  const bytes = readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports;
}
var NodeEncoder = class _NodeEncoder {
  constructor(e, handle) {
    this.e = e;
    this.handle = handle;
    this.frameSize = e.hvc_encoder_frame_size(handle);
    this.mbCount = e.hvc_encoder_mb_count(handle);
  }
  frameSize;
  mbCount;
  static create(e, cfg) {
    const h = e.hvc_encoder_new(
      cfg.width,
      cfg.height,
      cfg.fps,
      cfg.frameCount,
      cfg.gop,
      cfg.targetBitrate,
      cfg.baseQp
    );
    if (!h) throw new Error("encoder_new failed");
    return new _NodeEncoder(e, h);
  }
  writeFrame(rgb, classes) {
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
  bytesSoFar() {
    return Number(this.e.hvc_encoder_bytes_so_far(this.handle));
  }
  finish() {
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
    throw new Error("finish retry exhausted");
  }
};
var NodeDecoder = class _NodeDecoder {
  constructor(e, handle) {
    this.e = e;
    this.handle = handle;
  }
  static open(e, data) {
    const p = e.hvc_alloc(data.length);
    new Uint8Array(e.memory.buffer, p, data.length).set(data);
    const h = e.hvc_decoder_open(p, data.length);
    e.hvc_free(p, data.length);
    if (!h) throw new Error("decoder open failed");
    return new _NodeDecoder(e, h);
  }
  info() {
    const e = this.e;
    const p = e.hvc_alloc(64);
    try {
      const rc = e.hvc_decoder_info(this.handle, p);
      if (rc !== 0n) throw new Error("info failed");
      const dv = new DataView(e.memory.buffer, p, 40);
      return {
        width: dv.getUint32(0, true),
        height: dv.getUint32(4, true),
        frameCount: dv.getUint32(20, true),
        keyFrames: dv.getUint32(24, true)
      };
    } finally {
      e.hvc_free(p, 64);
    }
  }
  seek(target) {
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
  close() {
    this.e.hvc_decoder_close(this.handle);
  }
};
var NodeMotionAnalyzer = class _NodeMotionAnalyzer {
  constructor(e, handle, width, height) {
    this.e = e;
    this.handle = handle;
    this.mbCount = e.hvc_analyzer_mb_count(handle);
  }
  mbCount;
  static create(e, width, height) {
    const h = e.hvc_analyzer_new(width, height);
    if (!h) throw new Error("analyzer_new failed");
    return new _NodeMotionAnalyzer(e, h, width, height);
  }
  analyze(rgb) {
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
  close() {
    this.e.hvc_analyzer_close(this.handle);
  }
};

// tests/smoke-run.ts
var wasm = await loadNodeWasm();
function pad(frame, pw, ph) {
  const out = new Uint8Array(pw * ph * 3);
  for (let y = 0; y < frame.height; y++) {
    out.set(frame.data.subarray(y * frame.width * 3, (y + 1) * frame.width * 3), y * pw * 3);
  }
  return out;
}
async function smokeCodecRoundtrip() {
  const W = 160;
  const H = 128;
  const N = 40;
  const FPS = 200;
  const cfg = { width: W, height: H, frames: N, fps: FPS, lighting: "bright", traffic: "normal", seed: 42 };
  const gen = new SyntheticVideoGenerator(cfg);
  const analyzer = new MotionAnalyzer(W, H);
  const mbCols = gen.mbCols;
  const pw = mbCols * MB;
  const ph = gen.mbRows * MB;
  const enc = NodeEncoder.create(wasm, {
    width: W,
    height: H,
    fps: FPS,
    frameCount: N,
    gop: 10,
    targetBitrate: 0n,
    baseQp: 6
  });
  const frames = [];
  const maps = [];
  for (let t = 0; t < N; t++) {
    const { frame } = gen.generate(t);
    frames.push(frame);
    maps.push(analyzer.analyze(frame).classMap);
    enc.writeFrame(pad(frame, pw, ph), maps[t]);
  }
  const file = enc.finish();
  const dec = NodeDecoder.open(wasm, file);
  assertInfo(dec.info(), N);
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
        if (map[m] !== 0) continue;
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
    backgroundPsnr: 10 * Math.log10(255 * 255 / (se / n)),
    fileBytes: file.length
  };
}
async function smokeAnalyzerParity() {
  const W = 160;
  const H = 128;
  const N = 30;
  const cfg = { width: W, height: H, frames: N, fps: 200, lighting: "overcast", traffic: "dense", seed: 9 };
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
function assertInfo(info, n) {
  if (info.frameCount !== n) throw new Error(`frameCount \u5931\u914D:${info.frameCount}`);
  if (info.keyFrames < 1) throw new Error("\u5E94\u81F3\u5C11\u6709\u4E00\u4E2A\u5173\u952E\u5E27");
}
function luma(r, g, b) {
  return 19595 * r + 38470 * g + 7471 * b + 32768 >> 16;
}
export {
  smokeAnalyzerParity,
  smokeCodecRoundtrip
};
