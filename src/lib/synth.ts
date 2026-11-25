import { FLOWS, LIGHTINGS, type BeeAnnotation, type FlowId, type LightingId, type RenderedFrame, type SynthSettings } from './types';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface TBee {
  id: number; kind: 0 | 1 | 2; dir: number; baseY: number; amp: number; freq: number;
  phase: number; speed: number; size: number; pollen: number; hue: [number, number, number];
  duration: number; p0: number; wingRate: number;
}

export class HiveSynth {
  readonly cfg: SynthSettings;
  private bees: TBee[] = [];
  private bg: HTMLCanvasElement;
  private maskCanvas: HTMLCanvasElement;
  private mctx: CanvasRenderingContext2D;
  private overlay: string;

  constructor(cfg: SynthSettings) {
    this.cfg = cfg;
    const lighting = LIGHTINGS.find((l) => l.id === cfg.lighting)!;
    this.overlay = lighting.overlay;
    const count = FLOWS.find((f) => f.id === cfg.flow)!.count;
    const s = cfg.height / 1080;
    const rand = rng(cfg.seed ^ hash(cfg.lighting) ^ hash(cfg.flow));
    for (let id = 0; id < count; id++) this.bees.push(spawn(id, cfg, s, rand));
    this.bg = renderBackground(cfg, rand);
    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = cfg.width;
    this.maskCanvas.height = cfg.height;
    this.mctx = this.maskCanvas.getContext('2d', { willReadFrequently: true })!;
  }

  /** Render an arbitrary frame index deterministically (safe for scrubbing). */
  render(index: number): RenderedFrame {
    const { width: w, height: h, fps } = this.cfg;
    const time = index / fps;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(this.bg, 0, 0);
    this.mctx.clearRect(0, 0, w, h);
    this.mctx.fillStyle = '#fff';
    this.mctx.strokeStyle = '#fff';

    const anns: BeeAnnotation[] = [];
    for (const b of this.bees) {
      const pos = positionAt(b, time, w, h);
      drawBee(ctx, b, pos.x, pos.y, pos.angle, time);
      drawMaskBee(this.mctx, b, pos.x, pos.y, pos.angle);
      const speed = Math.hypot(pos.vx, pos.vy);
      anns.push({
        id: b.id, x: pos.x, y: pos.y, w: b.size * 3.4, h: b.size * 2.4,
        vx: pos.vx, vy: pos.vy, speedPxS: speed, pollen: b.pollen, crawling: b.kind === 2,
      });
    }
    if (this.overlay && this.overlay !== 'rgba(255,255,255,0)') {
      ctx.fillStyle = this.overlay;
      ctx.fillRect(0, 0, w, h);
    }
    const image = ctx.getImageData(0, 0, w, h);
    const maskData = this.mctx.getImageData(0, 0, w, h).data;
    const mask = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) mask[p] = maskData[p * 4 + 3] > 40 ? 255 : 0;
    return { index, rgba: image.data, mask, bees: anns };
  }

  /** Ground-truth block weights straight from synthesized labels. */
  gtWeights(mask: Uint8Array, block = 16): { weights: Float32Array; classes: Uint8Array; gridW: number; gridH: number } {
    const { width: w, height: h } = this.cfg;
    const gw = Math.ceil(w / block), gh = Math.ceil(h / block);
    const cov = new Float32Array(gw * gh);
    for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
      let hit = 0, n = 0;
      for (let y = by * block; y < Math.min(h, (by + 1) * block); y++)
        for (let x = bx * block; x < Math.min(w, (bx + 1) * block); x++) {
          hit += mask[y * w + x] ? 1 : 0; n++;
        }
      cov[by * gw + bx] = hit / n;
    }
    const weights = new Float32Array(gw * gh);
    const classes = new Uint8Array(gw * gh);
    for (let i = 0; i < gw * gh; i++) {
      const hit = cov[i] > 0.02;
      let near = false;
      const bx = i % gw, by = (i / gw) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = bx + dx, ny = by + dy;
        if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && cov[ny * gw + nx] > 0.02) near = true;
      }
      weights[i] = hit ? 5 : near ? 0.9 : 0.3;
      classes[i] = hit ? 2 : near ? 1 : 0;
    }
    return { weights, classes, gridW: gw, gridH: gh };
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function spawn(id: number, cfg: SynthSettings, s: number, rand: () => number): TBee {
  const w = cfg.width, h = cfg.height;
  const crawling = rand() < 0.34;
  const pollen = rand() < 0.32 ? 1 + ((rand() * 3) | 0) : 0;
  const hue: [number, number, number] = [
    [245, 190, 30], [240, 120, 24], [250, 226, 150], [232, 96, 20],
  ][(rand() * 4) | 0] as [number, number, number];
  const size = (15 + rand() * 9) * s;
  const dir = rand() < 0.5 ? -1 : 1;
  if (crawling) {
    return {
      id, kind: 2, dir, baseY: h * (0.64 + rand() * 0.31), amp: 0, freq: 0,
      phase: rand() * 6.28, speed: (18 + rand() * 62) * s, size, pollen, hue,
      duration: 1, p0: rand(), wingRate: 30 + rand() * 40,
    };
  }
  const fast = rand() < 0.62;
  const speed = (fast ? 620 + rand() * 730 : 160 + rand() * 260) * s;
  const distance = w + 240 * s;
  return {
    id, kind: fast ? 0 : 1, dir,
    baseY: rand() < 0.55 ? h * (0.4 + rand() * 0.2) : h * (0.12 + rand() * 0.66),
    amp: 6 + rand() * 22, freq: 1.5 + rand() * 3, phase: rand() * 6.28,
    speed, size, pollen, hue, duration: distance / speed, p0: rand(),
    wingRate: 90 + rand() * 80,
  };
}

function positionAt(b: TBee, t: number, w: number, h: number) {
  if (b.kind === 2) {
    const x = w / 2 + Math.sin(t * (0.12 + b.speed / 9000) + b.phase) * w * 0.42;
    const vx = Math.cos(t * 0.2 + b.phase) * w * 0.42 * 0.2;
    const y = b.baseY + Math.sin(t * 1.7 + b.phase) * 5;
    return { x, y, vx, vy: 0, angle: vx >= 0 ? 0 : Math.PI };
  }
  const prog = (t / b.duration + b.p0) % 1;
  const m = 120 * (h / 1080);
  const travel = w + 2 * m;
  const x = b.dir > 0 ? -m + prog * travel : w + m - prog * travel;
  const y = b.baseY + Math.sin(t * b.freq + b.phase) * b.amp;
  const vx = b.dir * b.speed;
  const vy = Math.cos(t * b.freq + b.phase) * b.amp * b.freq;
  return { x, y, vx, vy, angle: Math.atan2(vy, vx) };
}

function drawBee(ctx: CanvasRenderingContext2D, b: TBee, x: number, y: number, angle: number, t: number) {
  const s = b.size;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const wing = 0.55 + 0.45 * Math.abs(Math.sin(t * b.wingRate + b.phase));

  // wings
  ctx.fillStyle = 'rgba(214,228,238,0.5)';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(s * 0.15, side * -s * (0.55 + 0.25 * wing), s * (1.25 * wing + 0.35), s * 0.42, side * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // pollen baskets
  if (b.pollen) {
    ctx.fillStyle = `rgb(${b.hue[0]},${b.hue[1]},${b.hue[2]})`;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.42, side * s * 1.05, s * (0.3 + 0.08 * b.pollen), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // body
  const rx = s * 1.55, ry = s * 0.92;
  const grad = ctx.createRadialGradient(-s * 0.3, -s * 0.3, s * 0.2, 0, 0, rx);
  grad.addColorStop(0, '#f4c34a'); grad.addColorStop(1, '#c98a1c');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  // stripes
  ctx.strokeStyle = 'rgba(38,27,16,0.9)'; ctx.lineWidth = s * 0.34;
  for (const ox of [-s * 0.55, s * 0.05, s * 0.62]) {
    ctx.beginPath(); ctx.moveTo(ox, -ry * 0.8); ctx.lineTo(ox, ry * 0.8); ctx.stroke();
  }
  // head
  ctx.fillStyle = '#1e160f';
  ctx.beginPath(); ctx.arc(rx * 0.92, 0, s * 0.6, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawMaskBee(ctx: CanvasRenderingContext2D, b: TBee, x: number, y: number, angle: number) {
  const s = b.size;
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(s * 0.15, side * -s * 0.7, s * 1.3, s * 0.45, side * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
  if (b.pollen) for (const side of [-1, 1]) { ctx.beginPath(); ctx.arc(s * 0.42, side * s, s * 0.5, 0, Math.PI * 2); ctx.fill(); }
  ctx.beginPath(); ctx.ellipse(0, 0, s * 1.55, s * 0.95, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(s * 1.4, 0, s * 0.62, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function renderBackground(cfg: SynthSettings, rand: () => number): HTMLCanvasElement {
  const { width: w, height: h } = cfg;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const plankH = h / 5.5;
  for (let y = 0; y < h; y++) {
    const plank = Math.floor(y / plankH);
    const tone = 0.82 + hash01(plank, cfg.seed) * 0.3;
    const inPlank = y % plankH;
    const seam = Math.min(inPlank, plankH - inPlank) < 3 ? 0.5 : 1;
    const board = y >= h * 0.6 ? 1.08 + ((y - h * 0.6) / h) * 0.1 : 1;
    const grain = (Math.sin(y * 0.35 + Math.sin(0) * 6) * 0.5 + 0.5) * 0.1;
    const r = 146 * tone * (0.9 + grain) * seam * board;
    const g = 104 * tone * (0.9 + grain) * seam * board;
    const b = 66 * tone * (0.9 + grain) * seam * board;
    ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
    ctx.fillRect(0, y, w, 1);
  }
  // grain streaks
  ctx.globalAlpha = 0.18;
  for (let i = 0; i < 220; i++) {
    const y = rand() * h; const x = rand() * w; const len = 40 + rand() * 260;
    ctx.strokeStyle = rand() > 0.5 ? '#3a2814' : '#c79a5e';
    ctx.lineWidth = 1 + rand() * 1.4;
    ctx.beginPath(); ctx.moveTo(x, y);
    ctx.bezierCurveTo(x + len * 0.3, y + (rand() - 0.5) * 8, x + len * 0.7, y + (rand() - 0.5) * 8, x + len, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // entrance arch
  const cx = w * 0.5, ew = w * 0.15, top = h * 0.3, bottom = h * 0.605;
  ctx.fillStyle = '#18110c';
  ctx.beginPath();
  ctx.moveTo(cx - ew / 2, bottom);
  ctx.lineTo(cx - ew / 2, top + ew / 2);
  ctx.arc(cx, top + ew / 2, ew / 2, Math.PI, 0);
  ctx.lineTo(cx + ew / 2, bottom);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#b08456'; ctx.lineWidth = Math.max(4, w * 0.004); ctx.stroke();
  // landing board edge
  ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(0, h * 0.6, w, 6);
  return c;
}

function hash01(n: number, seed: number): number {
  let x = (Math.imul(n | 0, 0x9e3779b1) ^ seed) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

export function synthSettings(partial: Partial<SynthSettings> = {}): SynthSettings {
  return {
    source: 'synthetic', lighting: 'neutral-day', flow: 'medium',
    width: 1280, height: 720, fps: 200, durationSeconds: 2, seed: 0x51ee51, ...partial,
  };
}

export type { LightingId, FlowId };
