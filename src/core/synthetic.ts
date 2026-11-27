// 巢门录像合成器:确定性地生成带"真实运动标注"的合成序列,
// 覆盖几种光照(明亮/阴天/黄昏)与蜂流量(稀疏/正常/密集)。
//
// 场景模型:
//  - 静态巢门木板背景(低频木纹 + 巢门开口),光照随时间缓慢漂移模拟云遮日;
//  - 每只蜜蜂是一个 14x16 的椭圆体,带半透明翅膀与可选花粉团(后腿亮色点);
//  - 飞行蜂按轨迹快速平移,爬行蜂在巢门板上低速移动;
//  - 同时输出逐帧的"真实类别图"(ground-truth),供运动分析与 PSNR 评估。

import { MB, MbClass, type RawFrame, type SyntheticConfig } from './types';

interface Bee {
  x: number;
  y: number;
  vx: number;
  vy: number;
  flying: boolean;
  hasPollen: boolean;
  phase: number; // 翅膀拍动相位
}

/** 可复现的轻量 PRNG(mulberry32)。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LIGHTING_GAIN: Record<string, number> = {
  bright: 1.0,
  overcast: 0.72,
  dusk: 0.48,
};

const TRAFFIC_COUNT: Record<string, number> = {
  sparse: 3,
  normal: 7,
  dense: 14,
};

/** 光照的时间漂移(模拟云遮日的缓慢全局明暗变化),周期约 200 帧。 */
function lightingDrift(t: number): number {
  return 1 + 0.06 * Math.sin((t / 200) * Math.PI * 2);
}

export class SyntheticVideoGenerator {
  private rand: () => number;
  private bees: Bee[] = [];
  private bgBase: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  readonly fps: number;
  private gain: number;
  private entranceX: number;
  private entranceY: number;

  constructor(private cfg: SyntheticConfig) {
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

  get mbCols(): number {
    return Math.ceil(this.width / MB);
  }
  get mbRows(): number {
    return Math.ceil(this.height / MB);
  }

  /** 绘制时间稳定的木板 + 巢门开口。 */
  private paintStaticBackground(): void {
    const { width: w, height: h } = this;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        // 木纹:横向低频条纹 + 轻微纵向梯度
        const grain = Math.floor(Math.sin(x / 9.0) * 8 + Math.sin(x / 23.0) * 5);
        const plank = (Math.floor(y / 28) % 2) * 10;
        const r = 118 + grain + plank;
        const g = 86 + grain * 0.7 + plank * 0.7;
        const b = 52 + grain * 0.4;
        this.bgBase[i] = r;
        this.bgBase[i + 1] = g;
        this.bgBase[i + 2] = b;
      }
    }
    // 巢门开口:深色椭圆区域
    this.fillEllipse(this.entranceX, this.entranceY, w * 0.22, h * 0.12, [28, 22, 18]);
  }

  private fillEllipse(cx: number, cy: number, rx: number, ry: number, col: [number, number, number]): void {
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

  private spawnBees(): void {
    const n = TRAFFIC_COUNT[this.cfg.traffic] ?? 7;
    for (let k = 0; k < n; k++) {
      const flying = this.rand() > 0.35;
      this.bees.push({
        x: this.rand() * this.width,
        y: flying
          ? this.height * (0.15 + this.rand() * 0.5)
          : this.height * (0.55 + this.rand() * 0.35),
        vx: (this.rand() > 0.5 ? 1 : -1) * (flying ? 1.6 + this.rand() * 2.2 : 0.15 + this.rand() * 0.3),
        vy: (this.rand() - 0.5) * (flying ? 1.2 : 0.2),
        flying,
        // 约 35% 的归巢蜂携带花粉团
        hasPollen: this.rand() < 0.35,
        phase: this.rand() * Math.PI * 2,
      });
    }
  }

  /** 生成第 t 帧的 RGB、ground-truth 类别图与像素级蜜蜂掩码。 */
  generate(t: number): {
    frame: RawFrame;
    groundTruth: Uint8Array;
    /** 逐像素:1=蜜蜂身体/翅膀覆盖,0=背景。用于精确的分区 PSNR。 */
    pixelMask: Uint8Array;
  } {
    const { width: w, height: h } = this;
    const data = new Uint8Array(w * h * 3);
    const pixelMask = new Uint8Array(w * h);
    const drift = lightingDrift(t);
    // 背景:静态基底 × 光照增益 × 时间漂移
    for (let i = 0; i < data.length; i += 3) {
      data[i] = clamp8(this.bgBase[i] * this.gain * drift);
      data[i + 1] = clamp8(this.bgBase[i + 1] * this.gain * drift);
      data[i + 2] = clamp8(this.bgBase[i + 2] * this.gain * drift);
    }

    const gt = new Uint8Array(this.mbCols * this.mbRows); // 默认 0 = Background
    // 更新并绘制蜜蜂
    for (const bee of this.bees) {
      this.updateBee(bee, t);
      this.drawBee(data, bee, t, pixelMask);
      this.markGroundTruth(gt, bee);
    }

    return {
      frame: { width: w, height: h, data },
      groundTruth: gt,
      pixelMask,
    };
  }

  private updateBee(bee: Bee, t: number): void {
    bee.x += bee.vx;
    bee.y += bee.vy;
    bee.phase += bee.flying ? 1.4 : 0.3;
    // 边界回弹(保持在画面内,便于标注与评估)
    if (bee.x < 8 || bee.x > this.width - 8) bee.vx = -bee.vx;
    if (bee.y < 8 || bee.y > this.height - 8) bee.vy = -bee.vy;
    bee.x = clamp(bee.x, 8, this.width - 8);
    bee.y = clamp(bee.y, 8, this.height - 8);
    void t;
  }

  private drawBee(data: Uint8Array, bee: Bee, t: number, pixelMask?: Uint8Array): void {
    const { width: w } = this;
    const bodyR = 7;
    const bodyH = 8;
    const mark = (x: number, y: number) => {
      if (pixelMask && x >= 0 && y >= 0 && x < w && y < this.height) pixelMask[y * w + x] = 1;
    };
    // 身体(黄黑条纹椭圆)
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
    // 翅膀:飞行蜂高频拍动的半透明椭圆,随相位变化。
    // 翅膀不写入 bodyMask(半透明混合,计入 PSNR 会引入与编码无关的误差)。
    if (bee.flying) {
      const flap = Math.abs(Math.sin(bee.phase));
      const wingRx = 6;
      const wingRy = 3 + flap * 3;
      this.drawWing(data, bee.x - 4, bee.y - bodyH - 2, wingRx, wingRy);
      this.drawWing(data, bee.x + 4, bee.y - bodyH - 2, wingRx, wingRy);
    }
    // 花粉团:后腿两个亮黄/橙色点(高饱和,供花粉检测)
    if (bee.hasPollen) {
      this.drawPixel(data, bee.x - 5, bee.y + bodyH - 1, [240, 205, 70], pixelMask);
      this.drawPixel(data, bee.x + 5, bee.y + bodyH - 1, [240, 205, 70], pixelMask);
      this.drawPixel(data, bee.x - 5, bee.y + bodyH, [225, 185, 55], pixelMask);
      this.drawPixel(data, bee.x + 5, bee.y + bodyH, [225, 185, 55], pixelMask);
    }
    void t;
  }

  private drawWing(data: Uint8Array, cx: number, cy: number, rx: number, ry: number): void {
    const { width: w, height: h } = this;
    for (let dy = -Math.ceil(ry); dy <= Math.ceil(ry); dy++) {
      for (let dx = -Math.ceil(rx); dx <= Math.ceil(rx); dx++) {
        if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry + 0.01) > 1) continue;
        const x = Math.round(cx + dx);
        const y = Math.round(cy + dy);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = (y * w + x) * 3;
        // 半透明混合
        data[i] = clamp8(data[i] * 0.5 + 230 * 0.5);
        data[i + 1] = clamp8(data[i + 1] * 0.5 + 235 * 0.5);
        data[i + 2] = clamp8(data[i + 2] * 0.5 + 245 * 0.5);
      }
    }
  }

  private drawPixel(
    data: Uint8Array,
    x: number,
    y: number,
    col: [number, number, number],
    pixelMask?: Uint8Array,
  ): void {
    const { width: w, height: h } = this;
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    if (pixelMask) pixelMask[y * w + x] = 1;
    const i = (y * w + x) * 3;
    data[i] = col[0];
    data[i + 1] = col[1];
    data[i + 2] = col[2];
  }

  /** 把蜜蜂覆盖到的 MB 标记为对应类别(ground truth)。 */
  private markGroundTruth(gt: Uint8Array, bee: Bee): void {
    const r = 10;
    const x0 = Math.floor((bee.x - r) / MB);
    const x1 = Math.floor((bee.x + r) / MB);
    const y0 = Math.floor((bee.y - r) / MB);
    const y1 = Math.floor((bee.y + r) / MB);
    const cls = bee.hasPollen
      ? MbClass.Pollen
      : bee.flying
        ? MbClass.Flying
        : MbClass.Crawling;
    for (let my = y0; my <= y1; my++) {
      for (let mx = x0; mx <= x1; mx++) {
        if (mx < 0 || my < 0 || mx >= this.mbCols || my >= this.mbRows) continue;
        const idx = my * this.mbCols + mx;
        // 花粉优先级最高,其次飞行,再次爬行
        if (cls > gt[idx]) gt[idx] = cls;
      }
    }
  }
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
