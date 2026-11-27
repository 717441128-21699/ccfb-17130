// 巢门录像合成器:确定性生成带真实运动标注的测试视频。
// 纯像素渲染(不依赖 Canvas),浏览器与 Node 均可运行。
// 三种光照(stable/drift/clouds) × 三种蜂流量(low/medium/high)。

import type {
  BeeAnnotation,
  FrameAnnotation,
  LightScenario,
  SynthConfig,
  TrafficScenario,
} from './types.ts';

/** 确定性 32bit PRNG */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface BeeState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  mode: 'fly' | 'crawl' | 'pollen';
  born: number;
  life: number;
  angle: number;
  seed: number;
}

interface FrameState {
  bees: BeeState[];
  gain: number;
}

const TRAFFIC_SPAWN: Record<TrafficScenario, number> = {
  low: 70,    // 平均每 70 帧生成一只飞行蜂
  medium: 24,
  high: 8,
};

export class SynthVideo {
  readonly cfg: SynthConfig;
  private rng: () => number;
  private bg: Uint8Array;
  private states: FrameState[];
  private lutCache = new Map<number, Uint8ClampedArray>();
  readonly entrance: { x: number; y: number; w: number; h: number };

  constructor(cfg: SynthConfig) {
    this.cfg = cfg;
    this.rng = mulberry32(cfg.seed);
    const boardH = Math.round(cfg.height * 0.22);
    this.entrance = {
      x: Math.round(cfg.width * 0.38),
      y: cfg.height - boardH + Math.round(boardH * 0.32),
      w: Math.round(cfg.width * 0.24),
      h: Math.round(boardH * 0.4),
    };
    this.bg = this.renderBackground();
    this.states = this.simulate();
  }

  get width(): number { return this.cfg.width; }
  get height(): number { return this.cfg.height; }
  get fps(): number { return this.cfg.fps; }
  get frameCount(): number { return this.cfg.frames; }

  // ---------- 背景 ----------

  private renderBackground(): Uint8Array {
    const { width: w, height: h } = this.cfg;
    const rgba = new Uint8Array(w * h * 4);
    const rng = mulberry32(this.cfg.seed ^ 0x9e3779b9);
    const boardTop = h - Math.round(h * 0.22);

    for (let y = 0; y < h; y++) {
      const onBoard = y >= boardTop;
      // 木板基色:上部箱体偏暖灰,下部巢门板偏深棕
      const base = onBoard ? [124, 88, 52] : [168, 150, 120];
      const seam = onBoard && (y - boardTop) % 96 < 3;
      for (let x = 0; x < w; x++) {
        const grain = (rng() - 0.5) * 14 + Math.sin(x * 0.05 + y * 0.01) * 4;
        const i = (y * w + x) * 4;
        rgba[i] = clamp255(base[0] + grain - (seam ? 26 : 0));
        rgba[i + 1] = clamp255(base[1] + grain * 0.8 - (seam ? 22 : 0));
        rgba[i + 2] = clamp255(base[2] + grain * 0.6 - (seam ? 16 : 0));
        rgba[i + 3] = 255;
      }
    }
    // 巢门开口:深色洞口 + 上沿阴影
    const e = this.entrance;
    for (let y = e.y - 4; y < e.y + e.h; y++) {
      for (let x = e.x - 6; x < e.x + e.w + 6; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const inside = x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h;
        const i = (y * w + x) * 4;
        if (inside) {
          rgba[i] = 18; rgba[i + 1] = 14; rgba[i + 2] = 10;
        } else {
          rgba[i] = clamp255(rgba[i] - 30);
          rgba[i + 1] = clamp255(rgba[i + 1] - 26);
          rgba[i + 2] = clamp255(rgba[i + 2] - 20);
        }
      }
    }
    return rgba;
  }

  // ---------- 运动轨迹模拟 ----------

  private lightGain(n: number): number {
    const t = n / this.cfg.fps;
    const light: LightScenario = this.cfg.light;
    if (light === 'stable') return 1;
    if (light === 'drift') {
      return 1 + 0.16 * Math.sin((2 * Math.PI * t) / 40) + 0.00003 * n;
    }
    // clouds:两段低通随机云遮 + 慢正弦
    const c1 = 0.5 + 0.5 * Math.sin(t * 0.21 + 1.7) * Math.sin(t * 0.07 + 0.4);
    const c2 = 0.5 + 0.5 * Math.sin(t * 0.13 + 4.2);
    return clamp(0.72 + 0.22 * c1 * c2 + 0.08 * Math.sin(t * 0.05), 0.6, 1.08);
  }

  private simulate(): FrameState[] {
    const rng = this.rng;
    const spawnEvery = TRAFFIC_SPAWN[this.cfg.traffic];
    const active: BeeState[] = [];
    const out: FrameState[] = [];
    const { width: w, height: h } = this.cfg;
    const boardTop = h - Math.round(h * 0.22);

    for (let n = 0; n < this.cfg.frames; n++) {
      // 生成飞行蜂(从画面边缘飞向巢门)
      if (n % spawnEvery === 0 && rng() < 0.9) {
        const fromLeft = rng() < 0.5;
        const speed = 14 + rng() * 22; // 14~36 px/帧
        const targetX = this.entrance.x + rng() * this.entrance.w;
        const targetY = this.entrance.y + rng() * this.entrance.h * 0.5;
        const sx = fromLeft ? -20 : w + 20;
        const sy = h * 0.15 + rng() * h * 0.55;
        const dx = targetX - sx;
        const dy = targetY - sy;
        const len = Math.hypot(dx, dy);
        const pollen = rng() < 0.3;
        active.push({
          x: sx, y: sy,
          vx: (dx / len) * speed,
          vy: (dy / len) * speed,
          mode: pollen ? 'pollen' : 'fly',
          born: n,
          life: Math.ceil(len / speed) + 8,
          angle: Math.atan2(dy, dx),
          seed: Math.floor(rng() * 1e9),
        });
      }
      // 少量爬行蜂在巢门板上随机游走(长生命周期)
      if (n % 140 === 0 && active.filter((b) => b.mode === 'crawl').length < 3) {
        active.push({
          x: this.entrance.x + rng() * this.entrance.w,
          y: boardTop + 12 + rng() * (h - boardTop - 24),
          vx: (rng() - 0.5) * 2.4,
          vy: (rng() - 0.5) * 1.6,
          mode: 'crawl',
          born: n,
          life: 300 + Math.floor(rng() * 500),
          angle: 0,
          seed: Math.floor(rng() * 1e9),
        });
      }

      for (const b of active) {
        b.x += b.vx;
        b.y += b.vy;
        if (b.mode === 'crawl') {
          // 随机游走 + 边界反弹
          b.vx = clamp(b.vx + (rng() - 0.5) * 0.8, -3, 3);
          b.vy = clamp(b.vy + (rng() - 0.5) * 0.6, -2, 2);
          if (b.x < 12 || b.x > w - 12) b.vx *= -1;
          if (b.y < boardTop + 8 || b.y > h - 8) b.vy *= -1;
          b.angle = Math.atan2(b.vy, b.vx);
        } else {
          b.angle = Math.atan2(b.vy, b.vx);
        }
      }
      // 回收
      for (let i = active.length - 1; i >= 0; i--) {
        const b = active[i];
        const age = n - b.born;
        const flownOut = b.mode !== 'crawl' && (b.x < -40 || b.x > w + 40 || b.y < -40 || b.y > h + 40);
        if (age > b.life || flownOut) active.splice(i, 1);
      }
      out.push({ bees: active.map((b) => ({ ...b })), gain: this.lightGain(n) });
    }
    return out;
  }

  // ---------- 光照 LUT ----------

  private gainLut(gain: number): Uint8ClampedArray {
    const key = Math.round(gain * 32);
    let lut = this.lutCache.get(key);
    if (!lut) {
      const g = key / 32;
      lut = new Uint8ClampedArray(256);
      for (let i = 0; i < 256; i++) lut[i] = clamp255(i * g);
      this.lutCache.set(key, lut);
    }
    return lut;
  }

  // ---------- 帧渲染 ----------

  renderFrame(n: number): { rgba: Uint8Array; annotation: FrameAnnotation } {
    const { width: w, height: h } = this.cfg;
    const rgba = new Uint8Array(this.bg); // 拷贝背景
    const st = this.states[n];
    const bees: BeeAnnotation[] = [];

    for (const b of st.bees) {
      const box = b.mode === 'crawl'
        ? this.drawCrawler(rgba, w, h, b)
        : this.drawFlier(rgba, w, h, b);
      bees.push(box);
    }

    // 全局光照增益(LUT)
    const lut = this.gainLut(st.gain);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = lut[rgba[i]];
      rgba[i + 1] = lut[rgba[i + 1]];
      rgba[i + 2] = lut[rgba[i + 2]];
    }

    return {
      rgba,
      annotation: { frame: n, bees, lightGain: st.gain },
    };
  }

  private setPx(rgba: Uint8Array, w: number, h: number, x: number, y: number,
                r: number, g: number, b2: number, alpha = 1): void {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    if (alpha >= 1) {
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b2;
    } else {
      rgba[i] = rgba[i] * (1 - alpha) + r * alpha;
      rgba[i + 1] = rgba[i + 1] * (1 - alpha) + g * alpha;
      rgba[i + 2] = rgba[i + 2] * (1 - alpha) + b2 * alpha;
    }
  }

  /** 画一只蜂的身体(局部坐标,cos/sin 旋转),返回包围盒 */
  private drawBody(
    rgba: Uint8Array, w: number, h: number,
    cx: number, cy: number, angle: number,
    pollen: boolean, alpha: number, wing: boolean,
  ): { minX: number; minY: number; maxX: number; maxY: number } {
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    const put = (lx: number, ly: number, r: number, g: number, b: number, a = alpha): void => {
      const x = Math.round(cx + lx * ca - ly * sa);
      const y = Math.round(cy + lx * sa + ly * ca);
      this.setPx(rgba, w, h, x, y, r, g, b, a);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    };

    for (let ly = -8; ly <= 8; ly++) {
      for (let lx = -11; lx <= 11; lx++) {
        const d = (lx * lx) / (11 * 11) + (ly * ly) / (8 * 8);
        if (d > 1) continue;
        let r: number; let g: number; let b: number;
        if (lx < -2) {
          // 腹部:黄黑条纹
          const stripe = Math.floor((lx + 11) / 3.2) % 2 === 0;
          if (stripe) { r = 228; g = 178; b = 46; } else { r = 42; g = 34; b = 24; }
        } else if (lx < 4) {
          // 胸部:深棕绒毛
          r = 96; g = 66; b = 38;
        } else {
          // 头部
          r = 38; g = 30; b = 22;
        }
        put(lx, ly, r, g, b);
      }
    }
    if (wing) {
      // 两片半透明翅膀
      for (let ly = -10; ly <= -4; ly++) {
        for (let lx = -3; lx <= 5; lx++) {
          const d = ((lx - 1) * (lx - 1)) / 20 + ((ly + 7) * (ly + 7)) / 12;
          if (d <= 1) put(lx, ly, 225, 232, 240, 0.42 * alpha);
        }
      }
      for (let ly = 4; ly <= 10; ly++) {
        for (let lx = -3; lx <= 5; lx++) {
          const d = ((lx - 1) * (lx - 1)) / 20 + ((ly - 7) * (ly - 7)) / 12;
          if (d <= 1) put(lx, ly, 225, 232, 240, 0.42 * alpha);
        }
      }
    }
    if (pollen) {
      // 后腿花粉团:高饱和橙黄色(V 通道显著偏高)
      const pollenSpots: ReadonlyArray<readonly [number, number]> = [[-7, -7], [-7, 7]];
      for (const [px, py] of pollenSpots) {
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (dx * dx + dy * dy <= 5) {
              put(px + dx, py + dy, 244, 162, 42);
            }
          }
        }
      }
    }
    return { minX, minY, maxX, maxY };
  }

  private drawFlier(rgba: Uint8Array, w: number, h: number, b: BeeState): BeeAnnotation {
    const speed = Math.hypot(b.vx, b.vy);
    const blurSteps = 3;
    let box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (let k = blurSteps; k >= 1; k--) {
      const t = k / blurSteps;
      const cx = b.x - b.vx * t * 0.55;
      const cy = b.y - b.vy * t * 0.55;
      const a = 0.35 + (1 - t) * 0.65;
      const r = this.drawBody(
        rgba, w, h, cx, cy, b.angle,
        b.mode === 'pollen', a, true,
      );
      box = union(box, r);
    }
    return {
      x: box.minX, y: box.minY,
      w: box.maxX - box.minX + 1, h: box.maxY - box.minY + 1,
      mode: b.mode, vx: speed, vy: 0,
    };
  }

  private drawCrawler(rgba: Uint8Array, w: number, h: number, b: BeeState): BeeAnnotation {
    const r = this.drawBody(rgba, w, h, b.x, b.y, b.angle, false, 1, false);
    return {
      x: r.minX, y: r.minY,
      w: r.maxX - r.minX + 1, h: r.maxY - r.minY + 1,
      mode: 'crawl', vx: b.vx, vy: b.vy,
    };
  }
}

function union(a: { minX: number; minY: number; maxX: number; maxY: number },
               b: { minX: number; minY: number; maxX: number; maxY: number }) {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
