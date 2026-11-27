//! 量化步长、正反量化与 8x8 锯齿扫描表。
//! DCT 变换本体在 block.rs 用编译期常量基矩阵实现。

/// H.264 风格量化步长:qstep = 2^((qp-4)/6)
#[inline]
pub fn quant_step(qp: i32) -> f32 {
    2f32.powf((qp as f32 - 4.0) / 6.0)
}

#[inline]
fn round_half_away(v: f32) -> i32 {
    if v >= 0.0 {
        (v + 0.5) as i32
    } else {
        -((-v) + 0.5) as i32
    }
}

/// 量化:系数 -> 整型 level
#[inline]
pub fn quantize(coeff: f32, qstep: f32) -> i32 {
    round_half_away(coeff / qstep)
}

/// 反量化
#[inline]
pub fn dequantize(level: i32, qstep: f32) -> f32 {
    level as f32 * qstep
}

/// 锯齿形扫描顺序
pub const ZIGZAG: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10,
    17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34,
    27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36,
    29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46,
    53, 60, 61, 54, 47, 55, 62, 63,
];
