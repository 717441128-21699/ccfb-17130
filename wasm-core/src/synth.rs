//! Deterministic synthetic hive-entrance footage with ground-truth labels.
//!
//! The generator paints a wooden nest board, a dark entrance and three castes
//! of motion: fast flying foragers, take-off/landing bees and slowly crawling
//! bees. A subset of foragers carries bright pollen baskets. Every frame also
//! produces a pixel bee/pollen mask and per-bee motion annotations, so the
//! block analyzer can be scored against real labels rather than self-reporting.

#![allow(dead_code)]

use crate::rng::SplitMix64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lighting {
    WarmMorning,
    NeutralDay,
    CoolOvercast,
    HarshSun,
    DimEvening,
}

impl Lighting {
    pub fn all() -> [Lighting; 5] {
        [
            Lighting::WarmMorning,
            Lighting::NeutralDay,
            Lighting::CoolOvercast,
            Lighting::HarshSun,
            Lighting::DimEvening,
        ]
    }

    pub fn slug(&self) -> &'static str {
        match self {
            Lighting::WarmMorning => "warm-morning",
            Lighting::NeutralDay => "neutral-day",
            Lighting::CoolOvercast => "cool-overcast",
            Lighting::HarshSun => "harsh-sun",
            Lighting::DimEvening => "dim-evening",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Lighting::WarmMorning => "暖色晨光",
            Lighting::NeutralDay => "中性日光",
            Lighting::CoolOvercast => "冷色阴天",
            Lighting::HarshSun => "烈日高对比",
            Lighting::DimEvening => "昏暗傍晚",
        }
    }

    /// (r gain, g gain, b gain, brightness, contrast, sensor noise)
    fn grade(&self) -> (f32, f32, f32, f32, f32, f32) {
        match self {
            Lighting::WarmMorning => (1.10, 1.00, 0.80, 1.05, 1.05, 5.0),
            Lighting::NeutralDay => (1.00, 1.00, 1.00, 1.00, 1.03, 4.0),
            Lighting::CoolOvercast => (0.88, 0.96, 1.10, 0.94, 0.92, 6.0),
            Lighting::HarshSun => (1.06, 1.01, 0.88, 1.10, 1.28, 3.5),
            Lighting::DimEvening => (1.12, 0.92, 0.70, 0.68, 1.12, 11.0),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flow {
    Low,
    Medium,
    High,
}

impl Flow {
    pub fn slug(&self) -> &'static str {
        match self {
            Flow::Low => "low",
            Flow::Medium => "medium",
            Flow::High => "high",
        }
    }
    pub fn label(&self) -> &'static str {
        match self {
            Flow::Low => "低蜂流",
            Flow::Medium => "中蜂流",
            Flow::High => "高蜂流",
        }
    }
    pub fn count(&self) -> usize {
        match self {
            Flow::Low => 7,
            Flow::Medium => 20,
            Flow::High => 46,
        }
    }
    pub fn all() -> [Flow; 3] {
        [Flow::Low, Flow::Medium, Flow::High]
    }
}

#[derive(Clone, Debug)]
pub struct SynthConfig {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub lighting: Lighting,
    pub flow: Flow,
    pub seed: u64,
    /// Slow global exposure/cloud ramp across the clip, 0..1 magnitude.
    pub light_drift: f32,
}

impl Default for SynthConfig {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: 200,
            lighting: Lighting::NeutralDay,
            flow: Flow::Medium,
            seed: 0x51_EE_51,
            light_drift: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct BeeAnnotation {
    pub id: u32,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub vx: f32,
    pub vy: f32,
    pub speed_px_s: f32,
    /// 0 = no pollen, otherwise confidence / load 1..=3.
    pub pollen: u8,
    pub crawling: bool,
}

pub struct Frame {
    pub rgba: Vec<u8>,
    /// 255 on bee body / wing / pollen pixels, 0 elsewhere.
    pub mask: Vec<u8>,
    pub bees: Vec<BeeAnnotation>,
    pub frame_index: u64,
}

#[derive(Clone)]
struct Bee {
    id: u32,
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    size: f32,
    pollen: u8,
    crawling: bool,
    wing: f32,
    wing_rate: f32,
    hue: [u8; 3],
    path: u8,
}

pub struct SyntheticSource {
    pub cfg: SynthConfig,
    rng: SplitMix64,
    bg: Vec<u8>,
    bees: Vec<Bee>,
    index: u64,
    scale: f32,
}

impl SyntheticSource {
    pub fn new(cfg: SynthConfig) -> Self {
        let scale = cfg.height as f32 / 1080.0;
        let mut rng = SplitMix64::new(cfg.seed);
        let bg = render_background(&cfg, &mut rng);
        let n = cfg.flow.count();
        let mut bees = Vec::with_capacity(n);
        for id in 0..n {
            bees.push(spawn_bee(&cfg, &mut rng, scale, id as u32, true));
        }
        Self { cfg, rng, bg, bees, index: 0, scale }
    }

    pub fn background_rgba(&self) -> &[u8] {
        &self.bg
    }

    pub fn next_frame(&mut self) -> Frame {
        let idx = self.index;
        let dt = 1.0 / self.cfg.fps as f32;
        let w = self.cfg.width as f32;
        let h = self.cfg.height as f32;

        // Slow global light drift (cloud / sun beam).
        let drift = if self.cfg.light_drift > 0.0 {
            1.0 + self.cfg.light_drift
                * 0.18
                * (idx as f32 / self.cfg.fps as f32 * 0.21).sin()
        } else {
            1.0
        };

        let mut rgba = self.bg.clone();
        let mut mask = vec![0u8; (self.cfg.width * self.cfg.height) as usize];

        for bee in self.bees.iter_mut() {
            bee.wing += dt * bee.wing_rate;
            bee.x += bee.vx * dt;
            bee.y += bee.vy * dt;
            if bee.crawling {
                // Crawlers wander with a little heading noise.
                bee.vy += (self.rng.next_f32() - 0.5) * 18.0 * self.scale;
                bee.vy = bee.vy.clamp(-35.0 * self.scale, 35.0 * self.scale);
                bee.x += (self.rng.next_f32() - 0.5) * 10.0 * self.scale * dt * 60.0;
                let board_top = h * 0.60;
                if bee.y < board_top {
                    bee.y = board_top;
                    bee.vy = bee.vy.abs();
                }
                if bee.y > h * 0.97 {
                    bee.y = h * 0.97;
                    bee.vy = -bee.vy.abs();
                }
            } else {
                // Gentle sinusoidal bob for flyers.
                bee.y += (bee.wing * 0.9).sin() * 0.6 * self.scale;
            }

            // Recycle bees that leave the stage.
            let m = 120.0 * self.scale;
            if bee.x < -m || bee.x > w + m || bee.y < -m || bee.y > h + m {
                *bee = spawn_bee(&self.cfg, &mut self.rng, self.scale, bee.id, false);
            }

            draw_bee(&mut rgba, &mut mask, self.cfg.width, self.cfg.height, bee, drift);
        }

        apply_grade_and_noise(&mut rgba, &self.cfg, idx, drift);

        let annotations = self
            .bees
            .iter()
            .map(|b| {
                let speed = (b.vx * b.vx + b.vy * b.vy).sqrt();
                BeeAnnotation {
                    id: b.id,
                    x: b.x,
                    y: b.y,
                    w: b.size * 3.4,
                    h: b.size * 2.4,
                    vx: b.vx,
                    vy: b.vy,
                    speed_px_s: speed,
                    pollen: b.pollen,
                    crawling: b.crawling,
                }
            })
            .collect();

        self.index += 1;
        Frame { rgba, mask, bees: annotations, frame_index: idx }
    }
}

fn spawn_bee(cfg: &SynthConfig, rng: &mut SplitMix64, s: f32, id: u32, anywhere: bool) -> Bee {
    let w = cfg.width as f32;
    let h = cfg.height as f32;
    let crawling = rng.chance(0.34);
    let pollen = if rng.chance(0.32) { 1 + (rng.below(3) as u8) } else { 0 };
    let hue = match rng.below(4) {
        0 => [245, 190, 30],  // yellow
        1 => [240, 120, 24],  // orange
        2 => [250, 226, 150], // cream
        _ => [232, 96, 20],   // deep orange
    };
    let size = (15.0 + rng.next_f32() * 9.0) * s;

    if crawling {
        let x = if anywhere { rng.range_f(40.0, w - 40.0) } else { -60.0 * s };
        let y = rng.range_f(h * 0.64, h * 0.95);
        let dir = if rng.chance(0.5) { -1.0 } else { 1.0 };
        let speed = rng.range_f(18.0, 80.0) * s;
        Bee {
            id, x, y,
            vx: dir * speed,
            vy: rng.range_f(-10.0, 10.0) * s,
            size, pollen, crawling: true,
            wing: rng.next_f32() * 6.28,
            wing_rate: rng.range_f(30.0, 70.0),
            hue, path: 2,
        }
    } else {
        // Fast through-flight vs slower landing/take-off.
        let fast = rng.chance(0.62);
        let dir = if rng.chance(0.5) { 1.0 } else { -1.0 };
        let speed = if fast {
            rng.range_f(620.0, 1350.0) * s
        } else {
            rng.range_f(160.0, 420.0) * s
        };
        let x = if anywhere {
            rng.range_f(0.0, w)
        } else if dir > 0.0 {
            -80.0 * s
        } else {
            w + 80.0 * s
        };
        // Bias toward the entrance band.
        let y = if rng.chance(0.55) {
            h * rng.range_f(0.40, 0.60)
        } else {
            h * rng.range_f(0.12, 0.78)
        };
        Bee {
            id, x, y,
            vx: dir * speed,
            vy: rng.range_f(-60.0, 60.0) * s,
            size, pollen, crawling: false,
            wing: rng.next_f32() * 6.28,
            wing_rate: rng.range_f(90.0, 170.0),
            hue, path: if fast { 0 } else { 1 },
        }
    }
}

fn render_background(cfg: &SynthConfig, rng: &mut SplitMix64) -> Vec<u8> {
    let w = cfg.width as i32;
    let h = cfg.height as i32;
    let mut buf = vec![0u8; (w * h * 4) as usize];

    let plank_h = (h as f32 / 5.5) as i32;
    let seed = cfg.seed;
    for y in 0..h {
        let plank = y / plank_h;
        let in_plank = y % plank_h;
        let plank_tone = 0.82 + hash01(plank as i64, seed) * 0.30;
        let seam_dist = in_plank.min(plank_h - in_plank);
        for x in 0..w {
            // Horizontal wood grain.
            let grain = ((y as f32 * 0.35 + (x as f32 * 0.012).sin() * 6.0).sin() * 0.5 + 0.5)
                * 0.10
                + ((y as f32 * 0.085 + hash01((y / 3) as i64, seed) * 40.0).sin() * 0.5 + 0.5)
                    * 0.08;
            let pore = hash01((x / 2 + y * 97) as i64, seed.wrapping_add(7)) * 0.07;
            let seam = if seam_dist < 3 {
                0.45 + seam_dist as f32 * 0.12
            } else {
                1.0
            };
            let tone = plank_tone * (0.86 + grain + pore) * seam;

            // Lower landing board gets a warmer, slightly brighter face.
            let board_top = (h as f32 * 0.60) as i32;
            let board = if y >= board_top {
                1.08 + ((y - board_top) as f32 / h as f32) * 0.10
            } else {
                1.0
            };

            let mut r = 146.0 * tone * board;
            let mut g = 104.0 * tone * board;
            let mut b = 66.0 * tone * board;

            // Entrance: dark rounded arch around the board line.
            let cx = w as f32 * 0.5;
            let ew = w as f32 * 0.15;
            let top = h as f32 * 0.30;
            let bottom = h as f32 * 0.605;
            let dx = (x as f32 - cx).abs();
            let in_shaft = y as f32 > top + ew * 0.5 && y as f32 <= bottom && dx < ew * 0.5;
            let arch_dy = (y as f32 - (top + ew * 0.5)) / (ew * 0.5);
            let arch_dx = dx / (ew * 0.5);
            let in_arch = y as f32 <= top + ew * 0.5
                && y as f32 >= top
                && arch_dx * arch_dx + arch_dy * arch_dy <= 1.0;
            if in_shaft || in_arch {
                let depth = 0.55 + 0.45 * ((y as f32 - top) / (bottom - top)).min(1.0);
                r = 24.0 * depth;
                g = 17.0 * depth;
                b = 12.0 * depth;
            }
            // Entrance rim highlight.
            let rim = ((dx - ew * 0.5).abs() < 4.0
                && (y as f32) > top
                && (y as f32) < bottom)
                || ((y as f32 - bottom).abs() < 5.0 && dx < ew * 0.55);
            if rim {
                r = 176.0;
                g = 132.0;
                b = 86.0;
            }

            let i = ((y * w + x) * 4) as usize;
            buf[i] = clamp_u8(r);
            buf[i + 1] = clamp_u8(g);
            buf[i + 2] = clamp_u8(b);
            buf[i + 3] = 255;
        }
    }
    let _ = rng;
    buf
}

fn apply_grade_and_noise(rgba: &mut [u8], cfg: &SynthConfig, frame: u64, drift: f32) {
    let (gr, gg, gb, bright, contrast, noise) = cfg.lighting.grade();
    let b = bright * drift;
    let w = cfg.width as usize;
    // Cheap deterministic per-frame noise seed.
    let mut rng = SplitMix64::new(cfg.seed ^ frame.wrapping_mul(0x9E3779B97F4A7C15));
    for y in 0..cfg.height as usize {
        // Vertical vignette.
        let vy = (y as f32 / cfg.height as f32 - 0.5).abs() * 2.0;
        let vig = 1.0 - vy * vy * 0.18;
        for x in 0..w {
            let i = (y * w + x) * 4;
            let vx = (x as f32 / cfg.width as f32 - 0.5).abs() * 2.0;
            let vigx = 1.0 - vx * vx * 0.10;
            let vig = vig * vigx;
            let n = (rng.next_f32() - 0.5) * noise * 2.0;
            for c in 0..3 {
                let gain = [gr, gg, gb][c];
                let v = rgba[i + c] as f32;
                let v = (v - 128.0) * contrast + 128.0;
                let v = v * gain * b * vig + n;
                rgba[i + c] = clamp_u8(v);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn draw_bee(
    rgba: &mut [u8],
    mask: &mut [u8],
    w: u32,
    h: u32,
    bee: &Bee,
    light_drift: f32,
) {
    let theta = bee.vy.atan2(bee.vx);
    let cos = theta.cos();
    let sin = theta.sin();
    let s = bee.size;
    let rx = s * 1.55;
    let ry = s * 0.92;
    let x0 = (bee.x - s * 3.2).max(0.0) as i32;
    let x1 = (bee.x + s * 3.2).min(w as f32 - 1.0) as i32;
    let y0 = (bee.y - s * 2.6).max(0.0) as i32;
    let y1 = (bee.y + s * 2.6).min(h as f32 - 1.0) as i32;

    // Wing openness oscillates rapidly.
    let wing_open = 0.55 + 0.45 * bee.wing.sin().abs();

    for py in y0..=y1 {
        for px in x0..=x1 {
            let dx = px as f32 + 0.5 - bee.x;
            let dy = py as f32 + 0.5 - bee.y;
            let lx = dx * cos + dy * sin;
            let ly = -dx * sin + dy * cos;

            // Wings: two long thin ellipses above/below body axis.
            let mut cover: f32 = 0.0;
            let mut color = [214u8, 226, 235];
            let mut alpha = 0.0f32;
            for side in [-1.0f32, 1.0f32] {
                let wlx = lx + s * 0.15;
                let wly = ly - side * s * (0.55 + 0.25 * wing_open);
                let wrx = s * 1.25 * wing_open + s * 0.35;
                let wry = s * 0.42;
                let d = (wlx / wrx).powi(2) + (wly / wry).powi(2);
                if d <= 1.0 {
                    let a = (1.0 - d) * 0.5 + 0.18;
                    if a > alpha {
                        alpha = a.min(0.62);
                        color = [216, 228, 238];
                    }
                }
            }

            // Pollen baskets (bright, saturated) at rear-lateral legs.
            let mut pollen_hit = false;
            if bee.pollen > 0 {
                for side in [-1.0f32, 1.0f32] {
                    let plx = lx + rx * 0.42;
                    let ply = ly - side * ry * 1.15;
                    let pr = s * (0.30 + 0.08 * bee.pollen as f32);
                    if (plx / pr).powi(2) + (ply / (pr * 0.85)).powi(2) <= 1.0 {
                        pollen_hit = true;
                        alpha = 0.96;
                        color = bee.hue;
                        cover = 1.0;
                    }
                }
            }

            // Body ellipse.
            let body_d = (lx / rx).powi(2) + (ly / ry).powi(2);
            if body_d <= 1.0 {
                cover = 1.0;
                // Stripes along body axis.
                let stripe = ((lx / s + 0.3).rem_euclid(1.15)) < 0.42;
                let edge = body_d > 0.82;
                if pollen_hit {
                    // keep pollen color
                } else if edge {
                    color = [34, 24, 16];
                    alpha = 1.0;
                } else if stripe {
                    color = [38, 27, 16];
                    alpha = 1.0;
                } else {
                    let shade = 0.85 + 0.3 * (1.0 - body_d);
                    color = [
                        clamp_u8(226.0 * shade),
                        clamp_u8(168.0 * shade),
                        clamp_u8(34.0 * shade),
                    ];
                    alpha = 1.0;
                }
            }

            // Head.
            let hx = lx + rx * 0.92;
            let hd = (hx / (s * 0.62)).powi(2) + (ly / (s * 0.62)).powi(2);
            if hd <= 1.0 && !pollen_hit {
                color = [30, 22, 15];
                alpha = 1.0;
                cover = 1.0;
            }

            if alpha <= 0.01 {
                continue;
            }
            let idx = ((py * w as i32 + px) * 4) as usize;
            let a = alpha * light_drift.min(1.15);
            for c in 0..3 {
                let dst = rgba[idx + c] as f32;
                let src = color[c] as f32;
                rgba[idx + c] = clamp_u8(dst * (1.0 - a) + src * a);
            }
            if cover > 0.0 || alpha > 0.3 {
                mask[idx / 4] = 255;
            }
        }
    }
}

fn hash01(n: i64, seed: u64) -> f32 {
    let mut x = (n as u64)
        .wrapping_mul(0x9E3779B97F4A7C15)
        .wrapping_add(seed)
        .wrapping_mul(0xBF58476D1CE4E5B9);
    x ^= x >> 30;
    x = x.wrapping_mul(0x94D049BB133111EB);
    x ^= x >> 31;
    (x >> 11) as f32 / (1u64 << 53) as f32
}

#[inline]
pub fn clamp_u8(v: f32) -> u8 {
    v.round().clamp(0.0, 255.0) as u8
}
