//! PSNR and temporal flicker metrics. All PSNR is computed on Rec.601 luma
//! unless an RGB triple is returned.

pub fn luma(r: u8, g: u8, b: u8) -> f64 {
    0.299 * r as f64 + 0.587 * g as f64 + 0.114 * b as f64
}

pub struct RegionStats {
    pub psnr_y: f64,
    pub mse: f64,
    pub samples: usize,
}

pub fn psnr_masked_y(orig: &[u8], dec: &[u8], mask: Option<&[u8]>, w: usize, h: usize) -> RegionStats {
    debug_assert_eq!(orig.len(), w * h * 4);
    debug_assert_eq!(dec.len(), w * h * 4);
    let mut se = 0.0f64;
    let mut n = 0usize;
    for y in 0..h {
        for x in 0..w {
            let p = y * w + x;
            if let Some(m) = mask {
                if m[p] == 0 {
                    continue;
                }
            }
            let i = p * 4;
            let a = luma(orig[i], orig[i + 1], orig[i + 2]);
            let b = luma(dec[i], dec[i + 1], dec[i + 2]);
            let d = a - b;
            se += d * d;
            n += 1;
        }
    }
    if n == 0 {
        return RegionStats { psnr_y: f64::INFINITY, mse: 0.0, samples: 0 };
    }
    let mse = se / n as f64;
    let psnr = if mse < 1e-12 {
        f64::INFINITY
    } else {
        10.0 * (255.0 * 255.0 / mse).log10()
    };
    RegionStats { psnr_y: psnr, mse, samples: n }
}

/// Mean absolute temporal change of the *decoded* background between two
/// frames, restricted to background pixels. Stable copied blocks yield zero.
pub fn background_temporal_mad(
    dec_a: &[u8],
    dec_b: &[u8],
    bee_mask: &[u8],
    w: usize,
    h: usize,
) -> f64 {
    let mut sum = 0.0f64;
    let mut n = 0usize;
    for p in 0..w * h {
        if bee_mask[p] != 0 {
            continue;
        }
        let i = p * 4;
        let a = luma(dec_a[i], dec_a[i + 1], dec_a[i + 2]);
        let b = luma(dec_b[i], dec_b[i + 1], dec_b[i + 2]);
        sum += (a - b).abs();
        n += 1;
    }
    if n == 0 { 0.0 } else { sum / n as f64 }
}

/// Block flicker score: frame-to-frame luma change aggregated at block means,
/// which catches 16x16 blocks that pop/shift even when per-pixel MAD is modest.
pub fn block_flicker(
    dec_a: &[u8],
    dec_b: &[u8],
    bee_mask: &[u8],
    w: usize,
    h: usize,
    block: usize,
) -> f64 {
    let gw = w.div_ceil(block);
    let gh = h.div_ceil(block);
    let mut score = 0.0f64;
    let mut nb = 0usize;
    for by in 0..gh {
        for bx in 0..gw {
            let mut sa = 0.0;
            let mut sb = 0.0;
            let mut n = 0usize;
            let mut bee = 0usize;
            for y in by * block..((by + 1) * block).min(h) {
                for x in bx * block..((bx + 1) * block).min(w) {
                    let p = y * w + x;
                    if bee_mask[p] != 0 {
                        bee += 1;
                        continue;
                    }
                    let i = p * 4;
                    sa += luma(dec_a[i], dec_a[i + 1], dec_a[i + 2]);
                    sb += luma(dec_b[i], dec_b[i + 1], dec_b[i + 2]);
                    n += 1;
                }
            }
            // Only score blocks that are overwhelmingly background.
            let block_px = block * block;
            if n > block_px / 2 && bee * 4 < block_px {
                score += ((sa - sb) / n.max(1) as f64).abs();
                nb += 1;
            }
        }
    }
    if nb == 0 { 0.0 } else { score / nb as f64 }
}
