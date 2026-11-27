//! 正交归一化 8 点 DCT-II / DCT-III,14 位定点查表实现(正逆严格转置)。
//!
//! 平坦块(120)的二维 DC ≈ 均值*8 ≈ 960,与 JPEG 系数量化表量级兼容。

/// 定点缩放因子(矩阵 T 的系数已按此因子预算为整数常量)。
#[allow(dead_code)]
const Q: i32 = 1 << 14;

/// 正交 DCT-II 矩阵 T[k][n] = round(Q * α(k) * cos((2n+1)kπ/16))。
const T: [[i32; 8]; 8] = [
    [5793, 5793, 5793, 5793, 5793, 5793, 5793, 5793],
    [8035, 6811, 4551, 1598, -1598, -4551, -6811, -8035],
    [7568, 3135, -3135, -7568, -7568, -3135, 3135, 7568],
    [6811, -1598, -8035, -4551, 4551, 8035, 1598, -6811],
    [5793, -5793, -5793, 5793, 5793, -5793, -5793, 5793],
    [4551, -8035, 1598, 6811, -6811, -1598, 8035, -4551],
    [3135, -7568, 7568, -3135, -3135, 7568, -7568, 3135],
    [1598, -4551, 6811, -8035, 8035, -6811, 4551, -1598],
];

#[inline]
fn rshr(v: i64, n: u32) -> i32 {
    // 对称四舍五入(正负一致)
    let half = 1i64 << (n - 1);
    if v >= 0 {
        ((v + half) >> n) as i32
    } else {
        ((v - half) >> n) as i32
    }
}

/// 一维正变换 F[k] = Σ_n T[k][n]·x[n] / Q。
fn fdct1d(x: &[i32; 8]) -> [i32; 8] {
    let mut out = [0i32; 8];
    for k in 0..8 {
        let mut acc = 0i64;
        for n in 0..8 {
            acc += T[k][n] as i64 * x[n] as i64;
        }
        out[k] = rshr(acc, 14);
    }
    out
}

/// 一维逆变换 x[n] = Σ_k T[k][n]·F[k] / Q(正变换的转置)。
fn idct1d(f: &[i32; 8]) -> [i32; 8] {
    let mut out = [0i32; 8];
    for n in 0..8 {
        let mut acc = 0i64;
        for k in 0..8 {
            acc += T[k][n] as i64 * f[k] as i64;
        }
        out[n] = rshr(acc, 14);
    }
    out
}

/// 二维正变换:64 像素(行优先)-> 64 正交系数(行优先)。
pub fn fdct(block: &[i16; 64]) -> [i32; 64] {
    let mut tmp = [[0i32; 8]; 8];
    for r in 0..8 {
        let row = [
            block[r * 8] as i32,
            block[r * 8 + 1] as i32,
            block[r * 8 + 2] as i32,
            block[r * 8 + 3] as i32,
            block[r * 8 + 4] as i32,
            block[r * 8 + 5] as i32,
            block[r * 8 + 6] as i32,
            block[r * 8 + 7] as i32,
        ];
        let o = fdct1d(&row);
        for c in 0..8 {
            tmp[r][c] = o[c];
        }
    }
    let mut out = [0i32; 64];
    for c in 0..8 {
        let col = [
            tmp[0][c], tmp[1][c], tmp[2][c], tmp[3][c],
            tmp[4][c], tmp[5][c], tmp[6][c], tmp[7][c],
        ];
        let res = fdct1d(&col);
        for r in 0..8 {
            out[r * 8 + c] = res[r];
        }
    }
    out
}

/// 二维逆变换:64 系数 -> 64 level-shift 域像素(范围约 -128..127,不裁剪)。
/// 调用方负责在加回 128 后再 clamp 到 0..255。
pub fn idct(coef: &[i32; 64]) -> [i16; 64] {
    let mut tmp = [[0i32; 8]; 8];
    for r in 0..8 {
        let row = [
            coef[r * 8], coef[r * 8 + 1], coef[r * 8 + 2], coef[r * 8 + 3],
            coef[r * 8 + 4], coef[r * 8 + 5], coef[r * 8 + 6], coef[r * 8 + 7],
        ];
        let o = idct1d(&row);
        for c in 0..8 {
            tmp[r][c] = o[c];
        }
    }
    let mut out = [0i16; 64];
    for c in 0..8 {
        let col = [
            tmp[0][c], tmp[1][c], tmp[2][c], tmp[3][c],
            tmp[4][c], tmp[5][c], tmp[6][c], tmp[7][c],
        ];
        let res = idct1d(&col);
        for r in 0..8 {
            // 不裁剪:level-shift 域允许负值
            out[r * 8 + c] = res[r] as i16;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn d1_roundtrip() {
        let v = [12, 200, -50, 77, 3, 250, 64, 90];
        let f = fdct1d(&v);
        let back = idct1d(&f);
        let max_err = v
            .iter()
            .zip(back.iter())
            .map(|(a, b)| (a - b).abs())
            .max()
            .unwrap();
        assert!(max_err <= 3, "1d max err {}: {:?}", max_err, back);
    }

    #[test]
    fn flat_dc_is_eight_times_mean() {
        let block = [120i16; 64];
        let c = fdct(&block);
        assert!((c[0] - 960).abs() <= 4, "dc = {}", c[0]);
        for i in 1..64 {
            assert!(c[i].abs() <= 2, "ac {} = {}", i, c[i]);
        }
        let back = idct(&c);
        for v in back {
            assert!((v as i32 - 120).abs() <= 2);
        }
    }

    #[test]
    fn roundtrip_ramp() {
        let mut block = [0i16; 64];
        for i in 0..64 {
            block[i] = ((i * 7 + (i / 8) * 13) % 256) as i16;
        }
        let c = fdct(&block);
        let back = idct(&c);
        let max_err = block
            .iter()
            .zip(back.iter())
            .map(|(a, b)| (a - b).abs())
            .max()
            .unwrap();
        // 双轮 14 位定点矩阵乘的累积误差,远小于量化引入的失真
        assert!(max_err <= 8, "max err {}", max_err);
    }

    #[test]
    fn roundtrip_impulse() {
        let mut block = [0i16; 64];
        block[9] = 230;
        block[40] = 40;
        let c = fdct(&block);
        let back = idct(&c);
        let max_err = block
            .iter()
            .zip(back.iter())
            .map(|(a, b)| (a - b).abs())
            .max()
            .unwrap();
        // 双轮 14 位定点矩阵乘的累积误差,远小于量化引入的失真
        assert!(max_err <= 8, "max err {}", max_err);
    }
}
