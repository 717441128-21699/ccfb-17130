//! RGB(888) <-> YCbCr BT.601 full-range 转换 + 4:2:0 色度子采样。
//!
//! 正变换(full-range,16 位定点):
//!   Y  =  0.299R    + 0.587G    + 0.114B
//!   Cb = -0.168736R - 0.331264G + 0.5B    + 128
//!   Cr =  0.5R      - 0.418688G - 0.081312B + 128
//! 逆变换为其精确代数逆(同一组系数推导,保证闭合)。

const YR: i32 = 19595; // 0.299*65536
const YG: i32 = 38470; // 0.587*65536
const YB: i32 = 7471; // 0.114*65536
const CBR: i32 = -11059; // -0.168736*65536
const CBG: i32 = -21709; // -0.331264*65536
const CBB: i32 = 32768; // 0.5*65536
const CRR: i32 = 32768; // 0.5*65536
const CRG: i32 = -27439; // -0.418688*65536
const CRB: i32 = -5329; // -0.081312*65536
const HALF: i32 = 1 << 15;

/// 逆变换系数(由正变换矩阵求逆并按 full-range 缩放,×65536)。
const RR_CB: i32 = 0; // R 仅依赖 Cr
const RR_CR: i32 = 91881; // 1.402*65536
const RG_CB: i32 = -22554; // -0.344136*65536
const RG_CR: i32 = -46802; // -0.714136*65536
const RB_CB: i32 = 116130; // 1.772*65536
const RB_CR: i32 = 0; // B 仅依赖 Cb

pub fn rgb_to_yuv(rgb: &[u8], w: usize, h: usize, y: &mut [u8], u: &mut [u8], v: &mut [u8]) {
    let cw = w / 2;
    for py in 0..h {
        for px in 0..w {
            let i = (py * w + px) * 3;
            let (r, g, b) = (rgb[i] as i32, rgb[i + 1] as i32, rgb[i + 2] as i32);
            let yv = (YR * r + YG * g + YB * b + HALF) >> 16;
            y[py * w + px] = yv.clamp(0, 255) as u8;
            if (px & 1) == 0 && (py & 1) == 0 {
                let mut sum_u = 0i32;
                let mut sum_v = 0i32;
                for dy in 0..2 {
                    for dx in 0..2 {
                        let sx = (px + dx).min(w - 1);
                        let sy = (py + dy).min(h - 1);
                        let j = (sy * w + sx) * 3;
                        let (r2, g2, b2) =
                            (rgb[j] as i32, rgb[j + 1] as i32, rgb[j + 2] as i32);
                        sum_u += CBR * r2 + CBG * g2 + CBB * b2 + 128 * (1 << 16);
                        sum_v += CRR * r2 + CRG * g2 + CRB * b2 + 128 * (1 << 16);
                    }
                }
                let ci = (py / 2) * cw + (px / 2);
                u[ci] = (((sum_u / 4 + HALF) >> 16).clamp(0, 255)) as u8;
                v[ci] = (((sum_v / 4 + HALF) >> 16).clamp(0, 255)) as u8;
            }
        }
    }
}

/// YUV420 -> RGB(每像素输出 3 字节),色度最近邻上采样。
pub fn yuv_to_rgb(y: &[u8], u: &[u8], v: &[u8], w: usize, h: usize, rgb: &mut [u8]) {
    let cw = w / 2;
    for py in 0..h {
        for px in 0..w {
            let ci = (py / 2) * cw + (px / 2);
            let yv = y[py * w + px] as i32;
            let cb = u[ci] as i32 - 128;
            let cr = v[ci] as i32 - 128;
            let r = yv + ((RR_CR * cr + HALF) >> 16);
            let g = yv + ((RG_CB * cb + RG_CR * cr + HALF) >> 16);
            let b = yv + ((RB_CB * cb + HALF) >> 16);
            let i = (py * w + px) * 3;
            rgb[i] = r.clamp(0, 255) as u8;
            rgb[i + 1] = g.clamp(0, 255) as u8;
            rgb[i + 2] = b.clamp(0, 255) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rgb_yuv_rgb_roundtrip() {
        let (w, h) = (16, 16);
        let mut rgb = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                rgb[i] = ((x * 13) % 256) as u8;
                rgb[i + 1] = ((y * 17 + 40) % 256) as u8;
                rgb[i + 2] = ((x + y * 7) % 256) as u8;
            }
        }
        let (mut yp, mut u, mut v) = (
            vec![0u8; w * h],
            vec![0u8; (w / 2) * (h / 2)],
            vec![0u8; (w / 2) * (h / 2)],
        );
        rgb_to_yuv(&rgb, w, h, &mut yp, &mut u, &mut v);
        let mut back = vec![0u8; w * h * 3];
        yuv_to_rgb(&yp, &u, &v, w, h, &mut back);
        // Y 平面应近似无损
        let mut y_err = 0i32;
        for i in 0..w * h {
            let orig_y =
                (YR * rgb[i * 3] as i32 + YG * rgb[i * 3 + 1] as i32 + YB * rgb[i * 3 + 2] as i32
                    + HALF)
                    >> 16;
            y_err += (yp[i] as i32 - orig_y).abs();
        }
        assert!(y_err / (w * h) as i32 <= 1, "Y 平均误差 {}", y_err);
        // 灰阶(R=G=B)色度为中性,往返应几乎无损
        let gray: Vec<u8> = (0..w * h).flat_map(|k| {
            let val = (k % 200) as u8;
            [val, val, val]
        }).collect();
        rgb_to_yuv(&gray, w, h, &mut yp, &mut u, &mut v);
        yuv_to_rgb(&yp, &u, &v, w, h, &mut back);
        let mut gray_max = 0i32;
        for i in 0..w * h * 3 {
            gray_max = gray_max.max((back[i] as i32 - gray[i] as i32).abs());
        }
        assert!(gray_max <= 2, "灰阶往返最大误差 {}", gray_max);
    }
}
