//! 分块运动分析:静止 / 爬行 / 快速飞行 / 携粉 四类,
//! 以及光照变化检测与背景 EMA 更新。

pub const CLASS_BG: u8 = 0;
pub const CLASS_CRAWL: u8 = 1;
pub const CLASS_FAST: u8 = 2;
pub const CLASS_POLLEN: u8 = 3;

pub struct AnalyzeParams {
    pub sad_active: u32,
    pub sad_fast: u32,
    pub pollen_v: i32,
    pub pollen_sat: i32,
}

/// 对整帧按 8x8 块分析。
/// 输出:classes(每块 1 字节)、sad(每块 u32)。
/// 返回全局亮度漂移(定点 Q8,正为变亮),绝对值超阈值由上层判定光照变化。
pub fn analyze_frame(
    bg_y: &[i16],
    cur_y: &[i16],
    cur_u: &[i16],
    cur_v: &[i16],
    w: usize,
    h: usize,
    classes: &mut [u8],
    sads: &mut [u32],
    p: &AnalyzeParams,
) -> i32 {
    let nbw = w / 8;
    let nbh = h / 8;
    let cw = w / 2;

    // 全局光照漂移与块 SAD 在同一块循环内累计,避免对 Y 平面的第二次全帧遍历。
    // 截断 |d|>40 的离群点(蜜蜂等前景),剩余像素均值即整体光照变化(Q8)。
    let mut drift_sum: i64 = 0;
    let mut drift_cnt: u64 = 0;

    for by in 0..nbh {
        for bx in 0..nbw {
            let x0 = bx * 8;
            let y0 = by * 8;
            let mut sad: u32 = 0;
            let mut changed: u32 = 0;
            for j in 0..8 {
                let row = (y0 + j) * w;
                for i in 0..8 {
                    let idx = row + x0 + i;
                    let d = cur_y[idx] as i32 - bg_y[idx] as i32;
                    let ad = d.unsigned_abs();
                    sad += ad;
                    if ad > 10 {
                        changed += 1;
                    }
                    if d.abs() <= 40 {
                        drift_sum += d as i64;
                        drift_cnt += 1;
                    }
                }
            }
            let bi = by * nbw + bx;
            sads[bi] = sad;

            let class = if sad < p.sad_active {
                CLASS_BG
            } else {
                // 色度均值只对活动块计算(背景块不需要携粉判定)
                let cx0 = bx * 4;
                let cy0 = by * 4;
                let mut mu: i64 = 0;
                let mut mv: i64 = 0;
                for j in 0..4 {
                    for i in 0..4 {
                        let ci = (cy0 + j) * cw + (cx0 + i);
                        mu += cur_u[ci] as i64;
                        mv += cur_v[ci] as i64;
                    }
                }
                mu /= 16;
                mv /= 16;
                let pollen = (mv - 128) > p.pollen_v as i64
                    && (mv - mu) > p.pollen_sat as i64
                    && sad > p.sad_active * 2;
                if pollen {
                    CLASS_POLLEN
                } else if sad >= p.sad_fast || changed >= 40 {
                    CLASS_FAST
                } else {
                    CLASS_CRAWL
                }
            };
            classes[bi] = class;
        }
    }

    if drift_cnt > 0 {
        ((drift_sum as f64 / drift_cnt as f64) * 256.0).round() as i32
    } else {
        0
    }
}

/// 光照变化后对背景做 EMA 更新:仅更新静止块,alpha 为 Q8 定点(0..256)。
pub fn update_background(
    bg_y: &mut [i16],
    bg_u: &mut [i16],
    bg_v: &mut [i16],
    cur_y: &[i16],
    cur_u: &[i16],
    cur_v: &[i16],
    classes: &[u8],
    w: usize,
    h: usize,
    alpha_q8: u32,
) {
    let nbw = w / 8;
    let nbh = h / 8;
    let cw = w / 2;
    for by in 0..nbh {
        for bx in 0..nbw {
            if classes[by * nbw + bx] != CLASS_BG {
                continue;
            }
            let x0 = bx * 8;
            let y0 = by * 8;
            for j in 0..8 {
                for i in 0..8 {
                    let idx = (y0 + j) * w + (x0 + i);
                    let old = bg_y[idx] as i32;
                    let new = cur_y[idx] as i32;
                    bg_y[idx] = ((old * (256 - alpha_q8 as i32) + new * alpha_q8 as i32) >> 8)
                        .clamp(0, 255) as i16;
                }
            }
            let cx0 = bx * 4;
            let cy0 = by * 4;
            for j in 0..4 {
                for i in 0..4 {
                    let ci = (cy0 + j) * cw + (cx0 + i);
                    for (bg, cur) in [
                        (&mut bg_u[ci], cur_u[ci]),
                        (&mut bg_v[ci], cur_v[ci]),
                    ] {
                        let old = *bg as i32;
                        let new = cur as i32;
                        *bg = ((old * (256 - alpha_q8 as i32) + new * alpha_q8 as i32) >> 8)
                            .clamp(0, 255) as i16;
                    }
                }
            }
        }
    }
}

/// PSNR(亮度分量,0..255)。mask 为 None 统计全图,否则只统计指定类别块。
pub fn psnr_y(
    a: &[i16],
    b: &[i16],
    w: usize,
    h: usize,
    classes: Option<&[u8]>,
    sel: u8,
) -> f32 {
    let nbw = w / 8;
    let mut se: u64 = 0;
    let mut n: u64 = 0;
    if let Some(cls) = classes {
        for by in 0..(h / 8) {
            for bx in 0..nbw {
                if cls[by * nbw + bx] != sel {
                    continue;
                }
                let x0 = bx * 8;
                let y0 = by * 8;
                for j in 0..8 {
                    for i in 0..8 {
                        let idx = (y0 + j) * w + (x0 + i);
                        let d = a[idx] as i32 - b[idx] as i32;
                        se += (d * d) as u64;
                        n += 1;
                    }
                }
            }
        }
    } else {
        for i in 0..a.len() {
            let d = a[i] as i32 - b[i] as i32;
            se += (d * d) as u64;
        }
        n = a.len() as u64;
    }
    if n == 0 || se == 0 {
        return 99.0;
    }
    let mse = se as f64 / n as f64;
    (10.0 * (255.0f64 * 255.0 / mse).log10()) as f32
}

/// 多类别 PSNR:统计 classes 落在 mask[0..mask_len) 内的块。
pub fn psnr_y_multi(
    a: &[i16],
    b: &[i16],
    w: usize,
    h: usize,
    classes: &[u8],
    mask: &[u8],
) -> f32 {
    let nbw = w / 8;
    let mut se: u64 = 0;
    let mut n: u64 = 0;
    for by in 0..(h / 8) {
        for bx in 0..nbw {
            let c = classes[by * nbw + bx];
            if !mask.contains(&c) {
                continue;
            }
            let x0 = bx * 8;
            let y0 = by * 8;
            for j in 0..8 {
                for i in 0..8 {
                    let idx = (y0 + j) * w + (x0 + i);
                    let d = a[idx] as i32 - b[idx] as i32;
                    se += (d * d) as u64;
                    n += 1;
                }
            }
        }
    }
    if n == 0 || se == 0 {
        return 99.0;
    }
    let mse = se as f64 / n as f64;
    (10.0 * (255.0f64 * 255.0 / mse).log10()) as f32
}
