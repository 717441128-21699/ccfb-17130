/// <reference lib="webworker" />
// Block motion / pollen / crawl analysis. Mirrors wasm-core/src/analysis.rs so
// the UI heatmap and live allocation use the exact same features as the
// objective benchmark. Runs off the main thread on every analysed frame.

export interface AnalyzeRequest {
  type: 'analyze';
  frameId: number;
  width: number;
  height: number;
  block?: number;
  rgba: Uint8ClampedArray | Uint8Array;
  plate?: Uint8Array | null;
}

export interface AnalyzeResponse {
  type: 'analysis';
  frameId: number;
  gridW: number;
  gridH: number;
  block: number;
  motion: Float32Array;
  foreground: Float32Array;
  pollen: Float32Array;
  persistence: Float32Array;
  cls: Uint8Array;
  weights: Float32Array;
}

let W = 0, H = 0, B = 16, GW = 0, GH = 0;
let prevY: Uint8Array | null = null;
let bgY: Float32Array | null = null;
let plateY: Uint8Array | null = null;
let persist: Float32Array | null = null;
let primed = false;

function isPollen(r: number, g: number, b: number): boolean {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return r > 148 && g > 78 && b < 118 && r - b > 92 && mx - mn > 72 && r >= g;
}

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function init(width: number, height: number, block: number) {
  W = width; H = height; B = block;
  GW = Math.ceil(W / B); GH = Math.ceil(H / B);
  prevY = new Uint8Array(W * H);
  bgY = new Float32Array(W * H);
  persist = new Float32Array(GW * GH);
  primed = false;
}

function setPlate(rgba: ArrayLike<number>) {
  plateY = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    plateY[p] = luma(rgba[i], rgba[i + 1], rgba[i + 2]);
  }
}

function analyze(req: AnalyzeRequest): AnalyzeResponse {
  if (!prevY || W !== req.width || H !== req.height || B !== (req.block ?? 16)) {
    init(req.width, req.height, req.block ?? 16);
  }
  if (req.plate) setPlate(req.plate);
  const rgba = req.rgba;
  if (!primed) {
    for (let p = 0; p < W * H; p++) {
      const i = p * 4;
      const y = luma(rgba[i], rgba[i + 1], rgba[i + 2]);
      bgY![p] = y; prevY![p] = y;
    }
    primed = true;
  }

  const N = GW * GH;
  const motion = new Float32Array(N);
  const foreground = new Float32Array(N);
  const pollen = new Float32Array(N);
  const cls = new Uint8Array(N);
  const weights = new Float32Array(N);

  const rawMotion = new Float32Array(N);
  let bi = 0;
  for (let by = 0; by < GH; by++) {
    for (let bx = 0; bx < GW; bx++, bi++) {
      const x0 = bx * B, y0 = by * B;
      const x1 = Math.min(x0 + B, W), y1 = Math.min(y0 + B, H);
      let motionSum = 0, fg = 0, pol = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = y * W + x, i = p * 4;
          const yv = luma(rgba[i], rgba[i + 1], rgba[i + 2]) | 0;
          motionSum += Math.abs(yv - prevY![p]);
          const plate = plateY ? plateY[p] : bgY![p];
          if (Math.abs(yv - plate) > 30) fg++;
          if (isPollen(rgba[i], rgba[i + 1], rgba[i + 2])) pol++;
          if (!plateY) {
            const adapt = Math.abs(yv - bgY![p]) < 16 ? 0.08 : 0.006;
            bgY![p] += (yv - bgY![p]) * adapt;
          }
          prevY![p] = yv;
          n++;
        }
      }
      rawMotion[bi] = motionSum / Math.max(1, n);
      foreground[bi] = fg / Math.max(1, n);
      pollen[bi] = pol / Math.max(1, n);
      motion[bi] = rawMotion[bi];
    }
  }

  const sorted = Array.from(rawMotion).sort((a, b) => a - b);
  const noiseFloor = Math.max(1, sorted[sorted.length >> 1]);
  const fastThresh = Math.max(6.5, noiseFloor * 2.1);

  for (let i = 0; i < N; i++) {
    persist![i] = persist![i] * 0.8 + foreground[i] * 0.2;
    let c: number;
    if (pollen[i] > 0.02) c = 3;
    else if (rawMotion[i] > fastThresh && foreground[i] > 0.05) c = 2;
    else if (foreground[i] > 0.12 || persist![i] > 0.22) c = 1;
    else c = 0;
    cls[i] = c;
    weights[i] = c === 3 ? 5 + Math.min(0.2, pollen[i]) * 10
      : c === 2 ? 2.8 + Math.min(1.6, rawMotion[i] / 24)
      : c === 1 ? 1.05 + Math.min(0.4, foreground[i]) * 1.2
      : 0.32;
  }

  // Coarse neighbour dilation around strong ROI blocks.
  const near = new Uint8Array(N);
  for (let by = 0; by < GH; by++) for (let bx = 0; bx < GW; bx++) {
    const i = by * GW + bx;
    if (weights[i] >= 2) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = bx + dx, ny = by + dy;
        if (nx >= 0 && ny >= 0 && nx < GW && ny < GH) near[ny * GW + nx] = 1;
      }
    }
  }
  for (let i = 0; i < N; i++) if (weights[i] < 0.6 && near[i]) weights[i] = 0.9;

  return {
    type: 'analysis', frameId: req.frameId, gridW: GW, gridH: GH, block: B,
    motion, foreground, pollen, persistence: persist!.slice(), cls, weights,
  };
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg?.type === 'reset') { primed = false; plateY = null; return; }
  if (msg?.type === 'analyze') {
    const res = analyze(msg as AnalyzeRequest);
    const transfer = [
      res.motion.buffer, res.foreground.buffer, res.pollen.buffer,
      res.persistence.buffer, res.cls.buffer, res.weights.buffer,
    ];
    (self as unknown as Worker).postMessage(res, { transfer });
  }
};
