//! HCV1 block codec.
//!
//! Pipeline: RGBA -> Rec.601 YCbCr 4:2:0 -> 8x8 orthonormal DCT ->
//! perceptual quant matrix -> zig-zag run/level varints.
//!
//! Two allocators share every primitive so the comparison is about bit
//! allocation and not different codecs:
//!   * uniform: one quant scale for every macroblock;
//!   * ROI:     per-block scale driven by motion / pollen / crawl weights.

#![allow(dead_code)]

use crate::bitio::{put_svarint, put_u16, put_u32, put_varint, Reader};

pub const MAGIC_FRAME: &[u8; 4] = b"HCF1";
pub const KIND_INTRA: u8 = 0;
pub const KIND_PPLATE: u8 = 1;
pub const BLOCK: usize = 16;

const QMAT: [f32; 64] = [
    16.0, 11.0, 10.0, 16.0, 24.0, 40.0, 51.0, 61.0,
    12.0, 12.0, 14.0, 19.0, 26.0, 58.0, 60.0, 55.0,
    14.0, 13.0, 16.0, 24.0, 40.0, 57.0, 69.0, 56.0,
    14.0, 17.0, 22.0, 29.0, 51.0, 87.0, 80.0, 62.0,
    18.0, 22.0, 37.0, 56.0, 68.0, 109.0, 103.0, 77.0,
    24.0, 35.0, 55.0, 64.0, 81.0, 104.0, 113.0, 92.0,
    49.0, 64.0, 78.0, 87.0, 103.0, 121.0, 120.0, 101.0,
    72.0, 92.0, 95.0, 98.0, 112.0, 100.0, 103.0, 99.0,
];

const ZIGZAG: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10,
    17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34,
    27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36,
    29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46,
    53, 60, 61, 54, 47, 55, 62, 63,
];

#[derive(Clone)]
pub struct Planes {
    pub w: usize,
    pub h: usize,
    pub cw: usize,
    pub ch: usize,
    pub y: Vec<f32>,
    pub cb: Vec<f32>,
    pub cr: Vec<f32>,
}

impl Planes {
    pub fn from_rgba(rgba: &[u8], w: usize, h: usize) -> Self {
        let cw = w.div_ceil(2);
        let ch = h.div_ceil(2);
        let mut y = vec![0f32; w * h];
        let mut cb = vec![128f32; cw * ch];
        let mut cr = vec![128f32; cw * ch];
        for py in 0..h {
            for px in 0..w {
                let i = (py * w + px) * 4;
                let r = rgba[i] as f32;
                let g = rgba[i + 1] as f32;
                let b = rgba[i + 2] as f32;
                y[py * w + px] = 0.299 * r + 0.587 * g + 0.114 * b;
            }
        }
        // Box-downsample chroma (2x2).
        for cy in 0..ch {
            for cx in 0..cw {
                let mut sr = 0f32;
                let mut sg = 0f32;
                let mut sb = 0f32;
                let mut n = 0f32;
                for dy in 0..2 {
                    for dx in 0..2 {
                        let px = (cx * 2 + dx).min(w - 1);
                        let py = (cy * 2 + dy).min(h - 1);
                        let i = (py * w + px) * 4;
                        sr += rgba[i] as f32;
                        sg += rgba[i + 1] as f32;
                        sb += rgba[i + 2] as f32;
                        n += 1.0;
                    }
                }
                let r = sr / n;
                let g = sg / n;
                let b = sb / n;
                cb[cy * cw + cx] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128.0;
                cr[cy * cw + cx] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128.0;
            }
        }
        Planes { w, h, cw, ch, y, cb, cr }
    }

    pub fn to_rgba(&self) -> Vec<u8> {
        let mut rgba = vec![255u8; self.w * self.h * 4];
        for py in 0..self.h {
            for px in 0..self.w {
                let yv = self.y[py * self.w + px];
                let cx = (px / 2).min(self.cw - 1);
                let cy = (py / 2).min(self.ch - 1);
                let cbi = self.cb[cy * self.cw + cx] - 128.0;
                let cri = self.cr[cy * self.cw + cx] - 128.0;
                let r = yv + 1.402 * cri;
                let g = yv - 0.344136 * cbi - 0.714136 * cri;
                let b = yv + 1.772 * cbi;
                let o = (py * self.w + px) * 4;
                rgba[o] = clamp255(r);
                rgba[o + 1] = clamp255(g);
                rgba[o + 2] = clamp255(b);
                rgba[o + 3] = 255;
            }
        }
        rgba
    }
}

#[inline]
fn clamp255(v: f32) -> u8 {
    v.round().clamp(0.0, 255.0) as u8
}

pub fn q_for_weight(q_base: i32, weight: f32) -> u8 {
    // Direct (not square-root) mapping gives the >=4 dB ROI concentration:
    // background quality factor ~0.3 and pollen ~5. Stored quant scales are
    // u8, so clamp to 2..=255 (0 is reserved for DC-only blocks).
    let w = weight.clamp(0.22, 6.5);
    let q = (q_base as f32 / w).round() as i32;
    q.clamp(2, 255) as u8
}

// ---------------------------------------------------------------------------
// DCT
// ---------------------------------------------------------------------------

fn cos_table() -> &'static [[f32; 8]; 8] {
    static COS: std::sync::OnceLock<[[f32; 8]; 8]> = std::sync::OnceLock::new();
    COS.get_or_init(|| {
        let mut c = [[0f32; 8]; 8];
        for k in 0..8 {
            for n in 0..8 {
                c[k][n] = ((2 * n + 1) as f32 * k as f32 * std::f32::consts::PI / 16.0).cos();
            }
        }
        c
    })
}

#[inline]
fn alpha(k: usize) -> f32 {
    if k == 0 { 0.35355339 } else { 0.5 } // 1/sqrt(8), sqrt(2/8)
}

pub fn dct8(v: &mut [f32; 64]) {
    let cos = cos_table();
    for r in 0..8 {
        let mut row = [0f32; 8];
        row.copy_from_slice(&v[r * 8..r * 8 + 8]);
        let mut o = [0f32; 8];
        for k in 0..8 {
            let mut s = 0f32;
            for n in 0..8 {
                s += row[n] * cos[k][n];
            }
            o[k] = s * alpha(k);
        }
        v[r * 8..r * 8 + 8].copy_from_slice(&o);
    }
    for c in 0..8 {
        let mut col = [0f32; 8];
        for r in 0..8 {
            col[r] = v[r * 8 + c];
        }
        let mut o = [0f32; 8];
        for k in 0..8 {
            let mut s = 0f32;
            for n in 0..8 {
                s += col[n] * cos[k][n];
            }
            o[k] = s * alpha(k);
        }
        for k in 0..8 {
            v[k * 8 + c] = o[k];
        }
    }
}

pub fn idct8(v: &mut [f32; 64]) {
    let cos = cos_table();
    // Inverse columns first.
    for c in 0..8 {
        let mut col = [0f32; 8];
        for k in 0..8 {
            col[k] = v[k * 8 + c];
        }
        let mut o = [0f32; 8];
        for n in 0..8 {
            let mut s = 0f32;
            for k in 0..8 {
                s += alpha(k) * col[k] * cos[k][n];
            }
            o[n] = s;
        }
        for n in 0..8 {
            v[n * 8 + c] = o[n];
        }
    }
    // Then rows.
    for r in 0..8 {
        let mut row = [0f32; 8];
        row.copy_from_slice(&v[r * 8..r * 8 + 8]);
        let mut o = [0f32; 8];
        for n in 0..8 {
            let mut s = 0f32;
            for k in 0..8 {
                s += alpha(k) * row[k] * cos[k][n];
            }
            o[n] = s;
        }
        v[r * 8..r * 8 + 8].copy_from_slice(&o);
    }
}

fn quant_steps(q: u8) -> [f32; 64] {
    // Flat-ish radial weighting. The stock JPEG table quantises high
    // frequencies ~6x more coarsely than DC, which erases wing/pollen edges at
    // the modest scales the rate matcher selects. A gentle radial curve keeps
    // those edges in ROI blocks while still zeroing noise in coarse blocks.
    let qf = q as f32;
    let mut s = [1f32; 64];
    for i in 0..64 {
        let u = (i % 8) as f32;
        let v = (i / 8) as f32;
        let weight = 1.0 + 0.02 * (u + v) + 0.006 * (u * u + v * v);
        s[i] = (qf * weight).max(1.0);
    }
    s
}

fn extract_y_block(p: &Planes, ox: usize, oy: usize) -> [f32; 64] {
    let mut b = [0f32; 64];
    for r in 0..8 {
        for c in 0..8 {
            let x = (ox + c).min(p.w - 1);
            let y = (oy + r).min(p.h - 1);
            b[r * 8 + c] = p.y[y * p.w + x] - 128.0;
        }
    }
    b
}

fn extract_c_block(plane: &[f32], cw: usize, ch: usize, ox: usize, oy: usize) -> [f32; 64] {
    let mut b = [0f32; 64];
    for r in 0..8 {
        for c in 0..8 {
            let x = (ox + c).min(cw - 1);
            let y = (oy + r).min(ch - 1);
            b[r * 8 + c] = plane[y * cw + x] - 128.0;
        }
    }
    b
}

fn write_coeff_block(out: &mut Vec<u8>, samples: &[f32; 64], q: u8, chroma: bool) {
    let mut d = *samples;
    dct8(&mut d);
    let mut steps = quant_steps(q);
    if chroma {
        for s in steps.iter_mut() {
            *s *= 1.15;
        }
    }
    let mut levels = [0i32; 64];
    for i in 0..64 {
        let step = steps[i].max(1.0);
        // Symmetric nearest-level quantiser.
        levels[i] = if d[i] >= 0.0 {
            ((d[i] + step * 0.5) / step).floor() as i32
        } else {
            -((-d[i] + step * 0.5) / step).floor() as i32
        };
    }
    // Zig-zag run/level coding.
    let mut run = 0u32;
    for &idx in ZIGZAG.iter() {
        let lvl = levels[idx];
        if lvl == 0 {
            run += 1;
        } else {
            put_varint(out, run as u64);
            put_svarint(out, lvl as i64);
            run = 0;
        }
    }
    put_varint(out, 64); // EOB
}

fn read_coeff_block(r: &mut Reader, q: u8, chroma: bool) -> Option<[f32; 64]> {
    let mut levels = [0i32; 64];
    let mut cursor = 0usize;
    loop {
        let run = r.varint()? as usize;
        if run == 64 {
            break;
        }
        let lvl = r.svarint()?;
        if cursor + run >= 64 || lvl == 0 {
            return None;
        }
        cursor += run;
        levels[ZIGZAG[cursor]] = lvl;
        cursor += 1;
    }
    let mut steps = quant_steps(q);
    if chroma {
        for s in steps.iter_mut() {
            *s *= 1.15;
        }
    }
    let mut d = [0f32; 64];
    for i in 0..64 {
        // Mid-tread reconstruction matching symmetric rounding.
        d[i] = levels[i] as f32 * steps[i];
    }
    idct8(&mut d);
    Some(d)
}

#[derive(Clone, Debug)]
pub struct EncodedFrame {
    pub bits: Vec<u8>,
    pub gw: usize,
    pub gh: usize,
    pub qmap: Vec<u8>,
}

/// Encode a self-contained intra frame. If `weights` is None the allocation is
/// uniform at `q_base`; otherwise each macroblock's quant scale follows its
/// weight.
pub fn encode_intra(
    rgba: &[u8],
    w: usize,
    h: usize,
    q_base: i32,
    weights: Option<&[f32]>,
) -> EncodedFrame {
    let gw = w.div_ceil(BLOCK);
    let gh = h.div_ceil(BLOCK);
    let planes = Planes::from_rgba(rgba, w, h);
    let mut out = Vec::with_capacity(w * h / 8);

    out.extend_from_slice(MAGIC_FRAME);
    put_u16(&mut out, w as u16);
    put_u16(&mut out, h as u16);
    put_u32(&mut out, 0); // frame index filled by caller/stream
    out.push(KIND_INTRA);
    out.push(BLOCK as u8);
    put_u16(&mut out, gw as u16);
    put_u16(&mut out, gh as u16);
    put_u32(&mut out, 0); // reserved / payload length placeholder

    let mut qmap = vec![0u8; gw * gh];
    for mby in 0..gh {
        for mbx in 0..gw {
            let idx = mby * gw + mbx;
            let wgt = weights.and_then(|ws| ws.get(idx).copied());
            // q == 0 is the DC-only macroblock marker used for stable bg.
            let dc_only = matches!(wgt, Some(w) if w < 0.6);
            let ox = mbx * BLOCK;
            let oy = mby * BLOCK;

            if dc_only {
                qmap[idx] = 0;
                out.push(0);
                let my00 = block_mean(&planes.y, planes.w, planes.h, ox, oy);
                let my10 = block_mean(&planes.y, planes.w, planes.h, ox + 8, oy);
                let my01 = block_mean(&planes.y, planes.w, planes.h, ox, oy + 8);
                let my11 = block_mean(&planes.y, planes.w, planes.h, ox + 8, oy + 8);
                let mc = block_mean(&planes.cb, planes.cw, planes.ch, mbx * 8, mby * 8);
                let mcr = block_mean(&planes.cr, planes.cw, planes.ch, mbx * 8, mby * 8);
                for m in [my00, my10, my01, my11, mc, mcr] {
                    out.push(clamp255(m));
                }
                continue;
            }

            let q = match wgt {
                Some(w) => q_for_weight(q_base, w),
                None => q_base.clamp(2, 200) as u8,
            };
            qmap[idx] = q;
            out.push(q);

            // Four luma 8x8 blocks.
            for (sx, sy) in [(0usize, 0usize), (8, 0), (0, 8), (8, 8)] {
                let b = extract_y_block(&planes, ox + sx, oy + sy);
                write_coeff_block(&mut out, &b, q, false);
            }
            // 4:2:0 chroma.
            let cb = extract_c_block(&planes.cb, planes.cw, planes.ch, mbx * 8, mby * 8);
            let cr = extract_c_block(&planes.cr, planes.cw, planes.ch, mbx * 8, mby * 8);
            write_coeff_block(&mut out, &cb, q, true);
            write_coeff_block(&mut out, &cr, q, true);
        }
    }

    EncodedFrame { bits: out, gw, gh, qmap }
}

fn block_mean(plane: &[f32], stride_w: usize, h: usize, ox: usize, oy: usize) -> f32 {
    let mut sum = 0f32;
    let mut n = 0f32;
    for r in 0..8 {
        for c in 0..8 {
            let x = (ox + c).min(stride_w - 1);
            let y = (oy + r).min(h - 1);
            sum += plane[y * stride_w + x];
            n += 1.0;
        }
    }
    sum / n
}

pub struct DecodedFrame {
    pub rgba: Vec<u8>,
    pub planes: Planes,
    pub kind: u8,
    pub index: u32,
}

pub fn decode_intra(bits: &[u8]) -> Option<DecodedFrame> {
    let mut r = Reader::new(bits);
    let mut magic = [0u8; 4];
    magic.copy_from_slice(r.bytes(4)?);
    if &magic != MAGIC_FRAME {
        return None;
    }
    let w = r.u16()? as usize;
    let h = r.u16()? as usize;
    let index = r.u32()?;
    let kind = r.u8()?;
    let block = r.u8()? as usize;
    if block != BLOCK {
        return None;
    }
    let gw = r.u16()? as usize;
    let gh = r.u16()? as usize;
    let _reserved = r.u32()?;
    if kind != KIND_INTRA {
        return None;
    }

    let cw = w.div_ceil(2);
    let ch = h.div_ceil(2);
    let mut y = vec![128f32; w * h];
    let mut cb = vec![128f32; cw * ch];
    let mut cr = vec![128f32; cw * ch];

        for mby in 0..gh {
        for mbx in 0..gw {
            let q = r.u8()?;
            let ox = mbx * BLOCK;
            let oy = mby * BLOCK;
            if q == 0 {
                // DC-only macroblock: six flat 8x8 means.
                let my00 = r.u8()? as f32;
                let my10 = r.u8()? as f32;
                let my01 = r.u8()? as f32;
                let my11 = r.u8()? as f32;
                let mc = r.u8()? as f32;
                let mcr = r.u8()? as f32;
                blit_y(&mut y, w, h, &[my00; 64], ox, oy);
                blit_y(&mut y, w, h, &[my10; 64], ox + 8, oy);
                blit_y(&mut y, w, h, &[my01; 64], ox, oy + 8);
                blit_y(&mut y, w, h, &[my11; 64], ox + 8, oy + 8);
                blit_c(&mut cb, cw, ch, &[mc; 64], mbx * 8, mby * 8);
                blit_c(&mut cr, cw, ch, &[mcr; 64], mbx * 8, mby * 8);
                continue;
            }
            for (sx, sy) in [(0usize, 0usize), (8, 0), (0, 8), (8, 8)] {
                let mut block8 = read_coeff_block(&mut r, q, false)?;
                for v in block8.iter_mut() {
                    *v += 128.0;
                }
                blit_y(&mut y, w, h, &block8, ox + sx, oy + sy);
            }
            let mut cbb = read_coeff_block(&mut r, q, true)?;
            let mut crb = read_coeff_block(&mut r, q, true)?;
            for v in cbb.iter_mut() { *v += 128.0; }
            for v in crb.iter_mut() { *v += 128.0; }
            blit_c(&mut cb, cw, ch, &cbb, mbx * 8, mby * 8);
            blit_c(&mut cr, cw, ch, &crb, mbx * 8, mby * 8);
        }
    }

    let planes = Planes { w, h, cw, ch, y, cb, cr };
    let rgba = planes.to_rgba();
    Some(DecodedFrame { rgba, planes, kind, index })
}

fn blit_y(dst: &mut [f32], w: usize, h: usize, b: &[f32; 64], ox: usize, oy: usize) {
    for r in 0..8 {
        for c in 0..8 {
            let x = ox + c;
            let y = oy + r;
            if x < w && y < h {
                dst[y * w + x] = b[r * 8 + c];
            }
        }
    }
}

fn blit_c(dst: &mut [f32], cw: usize, ch: usize, b: &[f32; 64], ox: usize, oy: usize) {
    for r in 0..8 {
        for c in 0..8 {
            let x = ox + c;
            let y = oy + r;
            if x < cw && y < ch {
                dst[y * cw + x] = b[r * 8 + c];
            }
        }
    }
}

fn add_y(dst: &mut [f32], w: usize, h: usize, b: &[f32; 64], ox: usize, oy: usize) {
    for r in 0..8 {
        for c in 0..8 {
            let x = ox + c;
            let y = oy + r;
            if x < w && y < h {
                let v = &mut dst[y * w + x];
                *v = (*v + b[r * 8 + c]).clamp(0.0, 255.0);
            }
        }
    }
}

fn add_c(dst: &mut [f32], cw: usize, ch: usize, b: &[f32; 64], ox: usize, oy: usize) {
    for r in 0..8 {
        for c in 0..8 {
            let x = ox + c;
            let y = oy + r;
            if x < cw && y < ch {
                let v = &mut dst[y * cw + x];
                *v = (*v + b[r * 8 + c]).clamp(0.0, 255.0);
            }
        }
    }
}

/// Encode a plate-predicted frame. With `weights == None` every macroblock is
/// coded at one uniform quant scale (the average-allocation baseline). With
/// weights, background blocks are skipped entirely and ROI blocks get fine q.
pub fn encode_plate_residual(
    rgba: &[u8],
    plate: &Planes,
    w: usize,
    h: usize,
    q_base: i32,
    weights: Option<&[f32]>,
) -> EncodedFrame {
    let gw = w.div_ceil(BLOCK);
    let gh = h.div_ceil(BLOCK);
    let cur = Planes::from_rgba(rgba, w, h);
    let mut out = Vec::with_capacity(w * h / 10);
    out.extend_from_slice(MAGIC_FRAME);
    put_u16(&mut out, w as u16);
    put_u16(&mut out, h as u16);
    put_u32(&mut out, 0);
    out.push(KIND_PPLATE);
    out.push(BLOCK as u8);
    put_u16(&mut out, gw as u16);
    put_u16(&mut out, gh as u16);
    put_u32(&mut out, 0);

    let mut qmap = vec![0u8; gw * gh];
    for mby in 0..gh {
        for mbx in 0..gw {
            let idx = mby * gw + mbx;
            let wgt = weights.and_then(|ws| ws.get(idx).copied());
            let skip = matches!(wgt, Some(wv) if wv < 0.6);
            if skip {
                qmap[idx] = 0;
                out.push(0);
                continue;
            }
            let q = match wgt {
                Some(wv) => q_for_weight(q_base, wv),
                None => q_base.clamp(2, 255) as u8,
            };
            qmap[idx] = q;
            out.push(q);
            let ox = mbx * BLOCK;
            let oy = mby * BLOCK;
            for (sx, sy) in [(0usize, 0usize), (8, 0), (0, 8), (8, 8)] {
                let a = extract_y_block(&cur, ox + sx, oy + sy);
                let p = extract_y_block(plate, ox + sx, oy + sy);
                let mut d = [0f32; 64];
                for i in 0..64 {
                    d[i] = a[i] - p[i];
                }
                write_coeff_block(&mut out, &d, q, false);
            }
            let mut cb_d = [0f32; 64];
            let mut cr_d = [0f32; 64];
            let cb_a = extract_c_block(&cur.cb, cur.cw, cur.ch, mbx * 8, mby * 8);
            let cb_p = extract_c_block(&plate.cb, plate.cw, plate.ch, mbx * 8, mby * 8);
            let cr_a = extract_c_block(&cur.cr, cur.cw, cur.ch, mbx * 8, mby * 8);
            let cr_p = extract_c_block(&plate.cr, plate.cw, plate.ch, mbx * 8, mby * 8);
            for i in 0..64 {
                cb_d[i] = cb_a[i] - cb_p[i];
                cr_d[i] = cr_a[i] - cr_p[i];
            }
            write_coeff_block(&mut out, &cb_d, q, true);
            write_coeff_block(&mut out, &cr_d, q, true);
        }
    }
    EncodedFrame { bits: out, gw, gh, qmap }
}

pub fn decode_plate_residual(bits: &[u8], plate: &Planes) -> Option<DecodedFrame> {
    let mut r = Reader::new(bits);
    let mut magic = [0u8; 4];
    magic.copy_from_slice(r.bytes(4)?);
    if &magic != MAGIC_FRAME {
        return None;
    }
    let w = r.u16()? as usize;
    let h = r.u16()? as usize;
    let index = r.u32()?;
    let kind = r.u8()?;
    let block = r.u8()? as usize;
    if block != BLOCK || kind != KIND_PPLATE {
        return None;
    }
    let gw = r.u16()? as usize;
    let gh = r.u16()? as usize;
    let _reserved = r.u32()?;
    let cw = w.div_ceil(2);
    let ch = h.div_ceil(2);

    let mut y = plate.y.clone();
    let mut cb = plate.cb.clone();
    let mut cr = plate.cr.clone();

    for mby in 0..gh {
        for mbx in 0..gw {
            let q = r.u8()?;
            if q == 0 {
                continue;
            }
            let ox = mbx * BLOCK;
            let oy = mby * BLOCK;
            for (sx, sy) in [(0usize, 0usize), (8, 0), (0, 8), (8, 8)] {
                let b = read_coeff_block(&mut r, q, false)?;
                add_y(&mut y, w, h, &b, ox + sx, oy + sy);
            }
            let cbb = read_coeff_block(&mut r, q, true)?;
            let crb = read_coeff_block(&mut r, q, true)?;
            add_c(&mut cb, cw, ch, &cbb, mbx * 8, mby * 8);
            add_c(&mut cr, cw, ch, &crb, mbx * 8, mby * 8);
        }
    }
    let planes = Planes { w, h, cw, ch, y, cb, cr };
    let rgba = planes.to_rgba();
    Some(DecodedFrame { rgba, planes, kind, index })
}

/// Match an ROI plate-residual encoding to a uniform-generated byte target.
pub fn match_roi_residual(
    rgba: &[u8],
    plate: &Planes,
    w: usize,
    h: usize,
    weights: &[f32],
    target: usize,
) -> (i32, EncodedFrame) {
    let encode = |q: i32| encode_plate_residual(rgba, plate, w, h, q, Some(weights));
    let mut lo = 2i32;
    let mut hi = 4096i32;
    for _ in 0..16 {
        let mid = (lo + hi) / 2;
        if encode(mid).bits.len() > target {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    let q_cross = hi;
    let mut best = encode(q_cross);
    for q in (q_cross.saturating_sub(8))..=(q_cross + 8).min(4096) {
        let e = encode(q);
        if e.bits.len() <= target + target / 200 && e.bits.len() > best.bits.len() {
            best = e;
        }
    }
    (q_cross, best)
}

/// Find an ROI quant base whose encoded size is at most `target` and as close
/// to it as practical. Returns (q_base, encoded).
pub fn match_roi_budget(
    rgba: &[u8],
    w: usize,
    h: usize,
    weights: &[f32],
    target: usize,
) -> (i32, EncodedFrame) {
    let encode = |q: i32| encode_intra(rgba, w, h, q, Some(weights));
    // Monotone: larger q => smaller payload. Search a wide range because the
    // weight divisors can pin important blocks well below q_base.
    let mut lo = 2i32;
    let mut hi = 4096i32;
    for _ in 0..16 {
        let mid = (lo + hi) / 2;
        let e = encode(mid);
        if e.bits.len() > target {
            lo = mid + 1; // too many bits => coarser
        } else {
            hi = mid;
        }
    }
    let q_cross = hi;
    let mut best_q = q_cross;
    let mut best = encode(q_cross);
    // Pick the finest scale that still respects a tight +0.5% matching slack.
    for q in (q_cross.saturating_sub(6))..=(q_cross + 6).min(4096) {
        let e = encode(q);
        if e.bits.len() <= target + target / 200 && e.bits.len() > best.bits.len() {
            best = e;
            best_q = q;
        }
    }
    // If the floor is still over target, return the coarsest legal encoding;
    // callers observe roi_bytes/uniform_bytes and never assume a match.
    if best.bits.len() > target + target / 200 {
        let e = encode(4096);
        return (4096, e);
    }
    let _ = &mut best_q;
    (best_q, best)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dct_roundtrip() {
        let mut a = [0f32; 64];
        for i in 0..64 {
            a[i] = ((i * 13) % 200) as f32 - 100.0;
        }
        let orig = a;
        dct8(&mut a);
        idct8(&mut a);
        for i in 0..64 {
            assert!((a[i] - orig[i]).abs() < 1e-3, "idx {i} {} vs {}", a[i], orig[i]);
        }
    }

    #[test]
    fn intra_roundtrip_smoke() {
        let w = 32;
        let h = 32;
        let mut rgba = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                rgba[i] = (x * 7) as u8;
                rgba[i + 1] = (y * 5) as u8;
                rgba[i + 2] = 120;
                rgba[i + 3] = 255;
            }
        }
        let enc = encode_intra(&rgba, w, h, 24, None);
        let dec = decode_intra(&enc.bits).expect("decode");
        assert_eq!(dec.rgba.len(), rgba.len());
        // DC-ish smooth image should reconstruct within a few levels.
        let mut mad = 0.0;
        for p in 0..w * h {
            mad += (dec.rgba[p * 4] as i32 - rgba[p * 4] as i32).abs() as f32;
        }
        mad /= (w * h) as f32;
        assert!(mad < 12.0, "mad {mad}");
    }
}
