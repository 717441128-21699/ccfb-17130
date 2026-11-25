//! Block-level motion / pollen / crawl analysis.
//!
//! This is the same rule set that the TypeScript Web Worker runs for the UI;
//! keeping a copy in Rust lets the objective benchmark drive allocation from
//! *measured* features and score those features against ground truth.

#![allow(dead_code)]

use crate::synth::clamp_u8;

pub const CLASS_BG: u8 = 0;
pub const CLASS_CRAWL: u8 = 1;
pub const CLASS_FAST: u8 = 2;
pub const CLASS_POLLEN: u8 = 3;

#[derive(Clone, Debug)]
pub struct BlockInfo {
    pub bx: usize,
    pub by: usize,
    pub x0: usize,
    pub y0: usize,
    pub x1: usize,
    pub y1: usize,
    /// Mean absolute luma difference vs previous frame, 0..255.
    pub motion: f32,
    /// Fraction of pixels that differ from the stable background plate.
    pub foreground: f32,
    /// Fraction of pollen-coloured pixels.
    pub pollen: f32,
    /// Smoothed persistent foreground [0..1].
    pub persistence: f32,
    pub class: u8,
    /// Allocation quality factor; larger => finer quantizer / more bytes.
    pub weight: f32,
}

struct RawBlock {
    motion: f32,
    foreground: f32,
    pollen: f32,
}

pub struct Analyzer {
    w: usize,
    h: usize,
    block: usize,
    gw: usize,
    gh: usize,
    prev_y: Vec<u8>,
    plate_y: Option<Vec<u8>>,
    bg_y: Vec<f32>,
    persistence: Vec<f32>,
    have_prev: bool,
    primed: bool,
}

impl Analyzer {
    pub fn new(w: usize, h: usize, block: usize) -> Self {
        let n = w * h;
        Self {
            w,
            h,
            block,
            gw: w.div_ceil(block),
            gh: h.div_ceil(block),
            prev_y: vec![128; n],
            plate_y: None,
            bg_y: vec![128.0; n],
            persistence: vec![0.0; w.div_ceil(block) * h.div_ceil(block)],
            have_prev: false,
            primed: false,
        }
    }

    pub fn grid(&self) -> (usize, usize) {
        (self.gw, self.gh)
    }

    /// Supply a stable background plate (synthetic truth or a temporal median).
    pub fn set_plate_rgba(&mut self, rgba: &[u8]) {
        let mut y = vec![128u8; self.w * self.h];
        for p in 0..self.w * self.h {
            let i = p * 4;
            y[p] = (0.299 * rgba[i] as f32
                + 0.587 * rgba[i + 1] as f32
                + 0.114 * rgba[i + 2] as f32) as u8;
        }
        self.plate_y = Some(y);
    }

    pub fn analyze(&mut self, rgba: &[u8]) -> Vec<BlockInfo> {
        let b = self.block;

        // Prime the fallback background from the first real frame so large
        // dark/bright static regions do not sit at the 128 initial value.
        if !self.primed {
            for p in 0..self.w * self.h {
                let i = p * 4;
                let yv = 0.299 * rgba[i] as f32
                    + 0.587 * rgba[i + 1] as f32
                    + 0.114 * rgba[i + 2] as f32;
                self.bg_y[p] = yv;
                self.prev_y[p] = yv as u8;
            }
            self.primed = true;
            self.have_prev = true;
        }

        let mut raw: Vec<RawBlock> = Vec::with_capacity(self.gw * self.gh);
        for by in 0..self.gh {
            for bx in 0..self.gw {
                let x0 = bx * b;
                let y0 = by * b;
                let x1 = (x0 + b).min(self.w);
                let y1 = (y0 + b).min(self.h);
                let mut motion_sum = 0u64;
                let mut fg = 0u64;
                let mut pollen = 0u64;
                let mut n = 0u64;
                for y in y0..y1 {
                    for x in x0..x1 {
                        let p = y * self.w + x;
                        let i = p * 4;
                        let r = rgba[i] as f32;
                        let g = rgba[i + 1] as f32;
                        let bl = rgba[i + 2] as f32;
                        let yv = (0.299 * r + 0.587 * g + 0.114 * bl) as u8;
                        motion_sum +=
                            (yv as i32 - self.prev_y[p] as i32).unsigned_abs() as u64;
                        let plate = if let Some(pl) = &self.plate_y {
                            pl[p] as f32
                        } else {
                            self.bg_y[p]
                        };
                        if (yv as f32 - plate).abs() > 30.0 {
                            fg += 1;
                        }
                        if is_pollen(rgba[i], rgba[i + 1], rgba[i + 2]) {
                            pollen += 1;
                        }
                        if self.plate_y.is_none() {
                            let adapt =
                                if (yv as f32 - self.bg_y[p]).abs() < 16.0 { 0.08 } else { 0.006 };
                            self.bg_y[p] += (yv as f32 - self.bg_y[p]) * adapt;
                        }
                        self.prev_y[p] = yv;
                        n += 1;
                    }
                }
                raw.push(RawBlock {
                    motion: motion_sum as f32 / n.max(1) as f32,
                    foreground: fg as f32 / n.max(1) as f32,
                    pollen: pollen as f32 / n.max(1) as f32,
                });
            }
        }

        // Adaptive noise floor: median motion across the (mostly static) grid.
        let mut motions: Vec<f32> = raw.iter().map(|r| r.motion).collect();
        motions.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let noise_floor = motions[motions.len() / 2].max(1.0);
        let fast_thresh = (noise_floor * 2.1).max(6.5);

        let mut infos: Vec<BlockInfo> = Vec::with_capacity(self.gw * self.gh);
        for (idx, r) in raw.iter().enumerate() {
            let bx = idx % self.gw;
            let by = idx / self.gw;
            let pers = &mut self.persistence[idx];
            *pers = *pers * 0.8 + r.foreground * 0.2;

            let class = if r.pollen > 0.02 {
                CLASS_POLLEN
            } else if r.motion > fast_thresh && r.foreground > 0.05 {
                CLASS_FAST
            } else if r.foreground > 0.12 || *pers > 0.22 {
                CLASS_CRAWL
            } else {
                CLASS_BG
            };

            let weight = match class {
                CLASS_POLLEN => 5.0 + r.pollen.min(0.2) * 10.0,
                CLASS_FAST => 2.8 + (r.motion / 24.0).min(1.6),
                CLASS_CRAWL => 1.05 + r.foreground.min(0.4) * 1.2,
                _ => 0.32,
            };

            infos.push(BlockInfo {
                bx, by,
                x0: bx * b, y0: by * b,
                x1: (bx * b + b).min(self.w),
                y1: (by * b + b).min(self.h),
                motion: r.motion,
                foreground: r.foreground,
                pollen: r.pollen,
                persistence: *pers,
                class,
                weight,
            });
        }

        // Give boundary neighbours a *coarse* coded weight rather than copying
        // the full ROI weight: bee edges that straddle a block still get bits,
        // but dilation does not triple the fine-quant budget.
        let base: Vec<f32> = infos.iter().map(|i| i.weight).collect();
        let mut near = vec![false; self.gw * self.gh];
        for by in 0..self.gh {
            for bx in 0..self.gw {
                let idx = by * self.gw + bx;
                if base[idx] >= 2.0 {
                    for dy in [-1i32, 0, 1] {
                        for dx in [-1i32, 0, 1] {
                            let nx = bx as i32 + dx;
                            let ny = by as i32 + dy;
                            if nx >= 0 && ny >= 0 && nx < self.gw as i32 && ny < self.gh as i32 {
                                near[ny as usize * self.gw + nx as usize] = true;
                            }
                        }
                    }
                }
            }
        }
        for idx in 0..self.gw * self.gh {
            if base[idx] < 0.6 && near[idx] {
                infos[idx].weight = 0.9;
            }
        }
        self.have_prev = true;
        infos
    }
}

pub fn is_pollen(r: u8, g: u8, b: u8) -> bool {
    let (ri, gi, bi) = (r as i32, g as i32, b as i32);
    let mx = ri.max(gi).max(bi);
    let mn = ri.min(gi).min(bi);
    // Vivid yellow/orange baskets. Thresholds stay hue/saturation gated so
    // dimmed pollen still qualifies while weathered wood does not.
    ri > 148
        && gi > 78
        && bi < 118
        && ri - bi > 92
        && mx - mn > 72
        && ri >= gi
}

/// Fraction of each block covered by ground-truth bee mask (for validation).
pub fn gt_coverage(mask: &[u8], w: usize, h: usize, b: usize) -> Vec<f32> {
    let gw = w.div_ceil(b);
    let gh = h.div_ceil(b);
    let mut out = vec![0f32; gw * gh];
    for by in 0..gh {
        for bx in 0..gw {
            let mut hit = 0usize;
            let mut n = 0usize;
            for y in by * b..((by + 1) * b).min(h) {
                for x in bx * b..((bx + 1) * b).min(w) {
                    hit += (mask[y * w + x] != 0) as usize;
                    n += 1;
                }
            }
            out[by * gw + bx] = hit as f32 / n as f32;
        }
    }
    out
}

/// Build a clean background plate from a set of RGBA frames using a per-pixel
/// temporal median to reject moving bees.
pub fn estimate_plate(frames: &[Vec<u8>], w: usize, h: usize) -> Vec<u8> {
    if frames.is_empty() {
        return vec![128u8; w * h * 4];
    }
    let k = frames.len().min(9);
    let step = frames.len() / k.max(1);
    let mut plate = vec![0u8; w * h * 4];
    for p in 0..w * h {
        for c in 0..4 {
            if c == 3 {
                plate[p * 4 + 3] = 255;
                continue;
            }
            let mut vals: Vec<u8> = (0..k)
                .map(|i| frames[(i * step).min(frames.len() - 1)][p * 4 + c])
                .collect();
            vals.sort_unstable();
            plate[p * 4 + c] = vals[vals.len() / 2];
        }
    }
    plate
}

pub fn pack_classes(infos: &[BlockInfo]) -> Vec<u8> {
    infos.iter().map(|b| b.class).collect()
}

pub fn pack_weights(infos: &[BlockInfo]) -> Vec<f32> {
    infos.iter().map(|b| b.weight).collect()
}

/// Quantize an f32 weight map to the ABI's 0..255 priority byte channel.
pub fn weights_to_bytes(weights: &[f32]) -> Vec<u8> {
    weights
        .iter()
        .map(|w| clamp_u8((w.clamp(0.0, 6.0) * 40.0) + 8.0))
        .collect()
}
