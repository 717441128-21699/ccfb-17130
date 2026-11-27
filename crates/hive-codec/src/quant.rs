//! Zigzag 扫描与量化表。
//!
//! 量化表为正交归一化 DCT(见 dct.rs)重新标定:标准 JPEG 表假设未归一化系数,
//! 其二维 AC 比正交系数大、DC 也大。这里把 JPEG 基准表按位置缩放回正交尺度,
//! 使量化步长与实际系数量级匹配。

pub const QP_MAX: u8 = 32;

/// 行优先索引 -> zigzag 顺序索引(标准 JPEG/libjpeg 64 位置换)。
pub const ZIGZAG: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27,
    20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58,
    59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

const JPEG_LUMA_BASE: [i32; 64] = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69,
    56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104,
    113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

const JPEG_CHROMA_BASE: [i32; 64] = [
    17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99,
    99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

/// 二维位置 (u,v) 的未归一化/正交尺度因子(2 的幂,精确)。
/// 正交 DCT 系数相对 JPEG 未归一化系数:DC 小 8 倍,纯 AC 小 4 倍,
/// 单方向频率(边缘)近似小 8 倍。量化步长同比例缩小以匹配。
#[inline]
fn ortho_divisor(u: usize, v: usize) -> i32 {
    match (u > 0) as i32 + (v > 0) as i32 {
        0 => 8, // DC
        1 => 8, // 边缘频率
        _ => 4, // 纯 AC
    }
}

/// 全部量化表:`qtables[is_chroma as usize][qp-1][zigzag位置]`。
pub struct QT {
    pub fwd: [[[i32; 64]; QP_MAX as usize]; 2],
    pub inv: [[[i32; 64]; QP_MAX as usize]; 2],
}

impl QT {
    pub fn build() -> Self {
        let mut fwd = [[[0i32; 64]; QP_MAX as usize]; 2];
        let mut inv = [[[0i32; 64]; QP_MAX as usize]; 2];
        for qp in 1..=QP_MAX as i32 {
            // x264 风格指数缩放:QP 每增加 6,量化步长翻倍(2^((qp-1)/6)),
            // 在 1..32 范围内提供约 2^(31/6)≈34 倍的动态范围,
            // 使精细/粗粝档位对应可测量的明显 PSNR 差异。
            let scale = (1i32 << ((qp - 1) / 6)) as f64
                * (1.0 + 0.1225 * (((qp - 1) % 6) as f64));
            let scale100 = (scale * 100.0).round() as i32;
            for (chroma, base) in [false, true].iter().enumerate() {
                let base_tab = if *base {
                    &JPEG_CHROMA_BASE
                } else {
                    &JPEG_LUMA_BASE
                };
                for k in 0..64 {
                    let idx = ZIGZAG[k]; // 行优先位置
                    let (u, v) = (idx / 8, idx % 8);
                    // 先缩放到正交 DCT 尺度,再施加指数 QP 缩放
                    let ortho_base = (base_tab[idx] / ortho_divisor(u, v)).max(1);
                    let mut q = (ortho_base * scale100 + 50) / 100;
                    q = q.clamp(1, 32767);
                    fwd[chroma][qp as usize - 1][k] = q;
                    inv[chroma][qp as usize - 1][k] = q;
                }
            }
        }
        QT { fwd, inv }
    }
}

/// 量化(除法带四舍五入),输入/输出均为 zigzag 顺序的 64 系数。
#[inline]
pub fn quantize(coef_zz: &[i32; 64], table: &[i32; 64], out: &mut [i16; 64]) {
    for k in 0..64 {
        let v = coef_zz[k];
        let q = table[k];
        out[k] = if v >= 0 {
            ((v + q / 2) / q) as i16
        } else {
            -((-v + q / 2) / q) as i16
        };
    }
}

/// 反量化。
#[inline]
pub fn dequantize(levels: &[i16; 64], table: &[i32; 64], out: &mut [i32; 64]) {
    for k in 0..64 {
        out[k] = levels[k] as i32 * table[k];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zigzag_is_permutation() {
        let mut seen = [false; 64];
        for &v in ZIGZAG.iter() {
            assert!(!seen[v], "duplicate {}", v);
            seen[v] = true;
        }
        assert!(seen.iter().all(|&x| x));
    }

    #[test]
    fn qtables_monotonic_and_bounded() {
        let qt = QT::build();
        for chroma in 0..2 {
            for qp in 1..QP_MAX as usize {
                for k in 0..64 {
                    // QP 越大量化步长越大
                    assert!(qt.fwd[chroma][qp][k] >= qt.fwd[chroma][qp - 1][k]);
                    assert!(qt.fwd[chroma][qp][k] >= 1);
                    assert_eq!(qt.fwd[chroma][qp][k], qt.inv[chroma][qp][k]);
                }
            }
        }
    }
}
