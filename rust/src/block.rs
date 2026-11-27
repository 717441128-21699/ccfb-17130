//! 块级变换编码:NxN DCT -> 量化 -> 锯齿扫描 -> (run,level) 指数哥伦布
//! 亮度块 8x8,色度块 4x4(4:2:0)

use crate::bitstream::{BitReader, BitWriter};
use crate::dct::{dequantize, quantize, quant_step, ZIGZAG};

const ZIGZAG4: [usize; 16] = [0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15];

/// 预计算的正交 DCT-II 基矩阵(编译期常量,避免运行时三角函数)。
/// C[k][n] = alpha(k) * cos(pi*(2n+1)*k/(2N))
const fn dct8_matrix() -> [[f32; 8]; 8] {
    let mut c = [[0f32; 8]; 8];
    let mut k = 0;
    while k < 8 {
        let alpha = if k == 0 { 0.3535533905932738 } else { 0.5 };
        let mut n = 0;
        while n < 8 {
            let ang = core::f32::consts::PI * (2.0 * n as f32 + 1.0) * k as f32 / 16.0;
            c[k][n] = alpha * cos_const(ang);
            n += 1;
        }
        k += 1;
    }
    c
}

const fn dct4_matrix() -> [[f32; 4]; 4] {
    let mut c = [[0f32; 4]; 4];
    let mut k = 0;
    while k < 4 {
        let alpha = if k == 0 { 0.5 } else { 0.7071067811865476 };
        let mut n = 0;
        while n < 4 {
            let ang = core::f32::consts::PI * (2.0 * n as f32 + 1.0) * k as f32 / 8.0;
            c[k][n] = alpha * cos_const(ang);
            n += 1;
        }
        k += 1;
    }
    c
}

// const fn 不支持 f32::cos,用泰勒级数在编译期求值(角度范围有限,精度足够)。
const fn cos_const(x: f32) -> f32 {
    // 归一化到 [-pi, pi]
    let mut v = x;
    while v > core::f32::consts::PI {
        v -= 2.0 * core::f32::consts::PI;
    }
    while v < -core::f32::consts::PI {
        v += 2.0 * core::f32::consts::PI;
    }
    let x2 = v * v;
    let mut term = 1.0f32;
    let mut sum = 1.0f32;
    let mut i = 1;
    while i <= 6 {
        term *= -x2 / ((2 * i - 1) as f32 * (2 * i) as f32);
        sum += term;
        i += 1;
    }
    sum
}

static DCT8: [[f32; 8]; 8] = dct8_matrix();
static DCT4: [[f32; 4]; 4] = dct4_matrix();

#[inline]
fn forward_dct<const N: usize>(res: &[i16], stride: usize, x0: usize, y0: usize) -> [f32; 64] {
    let mut x = [[0f32; 8]; 8];
    for j in 0..N {
        for i in 0..N {
            x[j][i] = res[(y0 + j) * stride + (x0 + i)] as f32;
        }
    }
    let mut f = [0f32; 64];
    if N == 8 {
        let c = &DCT8;
        // tmp = C X
        let mut tmp = [[0f32; 8]; 8];
        for k in 0..8 {
            for n in 0..8 {
                let mut acc = 0.0;
                for i in 0..8 {
                    acc += c[k][i] * x[i][n];
                }
                tmp[k][n] = acc;
            }
        }
        for k in 0..8 {
            for l in 0..8 {
                let mut acc = 0.0;
                for n in 0..8 {
                    acc += tmp[k][n] * c[l][n];
                }
                f[k * 8 + l] = acc;
            }
        }
    } else {
        let c = &DCT4;
        let mut tmp = [[0f32; 4]; 4];
        for k in 0..4 {
            for n in 0..4 {
                let mut acc = 0.0;
                for i in 0..4 {
                    acc += c[k][i] * x[i][n];
                }
                tmp[k][n] = acc;
            }
        }
        for k in 0..4 {
            for l in 0..4 {
                let mut acc = 0.0;
                for n in 0..4 {
                    acc += tmp[k][n] * c[l][n];
                }
                f[k * 8 + l] = acc;
            }
        }
    }
    f
}

#[inline]
fn inverse_dct<const N: usize>(coeff: &[f32; 64]) -> [i16; 64] {
    let mut f = [[0f32; 8]; 8];
    for j in 0..N {
        for i in 0..N {
            f[j][i] = coeff[j * 8 + i];
        }
    }
    let mut out = [0i16; 64];
    if N == 8 {
        let c = &DCT8;
        let mut tmp = [[0f32; 8]; 8];
        for n in 0..8 {
            for l in 0..8 {
                let mut acc = 0.0;
                for k in 0..8 {
                    acc += c[k][n] * f[k][l];
                }
                tmp[n][l] = acc;
            }
        }
        for i in 0..8 {
            for j in 0..8 {
                let mut acc = 0.0;
                for l in 0..8 {
                    acc += tmp[i][l] * c[l][j];
                }
                out[i * 8 + j] = acc.round().clamp(-255.0, 255.0) as i16;
            }
        }
    } else {
        let c = &DCT4;
        let mut tmp = [[0f32; 4]; 4];
        for n in 0..4 {
            for l in 0..4 {
                let mut acc = 0.0;
                for k in 0..4 {
                    acc += c[k][n] * f[k][l];
                }
                tmp[n][l] = acc;
            }
        }
        for i in 0..4 {
            for j in 0..4 {
                let mut acc = 0.0;
                for l in 0..4 {
                    acc += tmp[i][l] * c[l][j];
                }
                out[i * 8 + j] = acc.round().clamp(-255.0, 255.0) as i16;
            }
        }
    }
    out
}

/// 把块编码写入共享 BitWriter(连续比特流,无长度前缀、无块间对齐)。
/// 块结构自界定:ue(qp) ue(nz) + nz 个系数内的 run-level 序列。
pub fn encode_block_into<const N: usize>(
    plane: &[i16],
    stride: usize,
    x0: usize,
    y0: usize,
    qp: i32,
    level_shift: i16,
    w: &mut BitWriter,
) {
    let coeff = forward_dct::<N>(plane, stride, x0, y0);
    let qstep = quant_step(qp);
    let table: &[usize] = if N == 8 { &ZIGZAG } else { &ZIGZAG4 };

    // 量化 + 锯齿扫描
    let mut levels = [0i32; 64];
    let mut nz = 0usize;
    for (scan_idx, &pos) in table.iter().enumerate().take(N * N) {
        let shifted = if level_shift != 0 && pos == 0 {
            coeff[0] - (level_shift as f32 * (N * N) as f32)
        } else {
            coeff[pos]
        };
        let lvl = quantize(shifted, qstep);
        levels[scan_idx] = lvl;
        if lvl != 0 {
            nz = scan_idx + 1;
        }
    }

    w.write_ue(qp as u32);
    w.write_ue(nz as u32);
    let mut run = 0u32;
    for idx in 0..nz {
        let lvl = levels[idx];
        if lvl == 0 {
            run += 1;
        } else {
            w.write_ue(run);
            w.write_se(lvl);
            run = 0;
        }
    }
}

/// 解码一个块,输出重建残差/像素到 out(行优先,步长 8)
pub fn decode_block<const N: usize>(r: &mut BitReader, level_shift: i16) -> [i16; 64] {
    let qp = r.read_ue() as i32;
    let nz = r.read_ue() as usize;
    let qstep = quant_step(qp);
    let table: &[usize] = if N == 8 { &ZIGZAG } else { &ZIGZAG4 };

    let mut scanned = [0i32; 64];
    let mut idx = 0usize;
    while idx < nz {
        let run = r.read_ue() as usize;
        let level = r.read_se();
        idx += run;
        scanned[idx] = level;
        idx += 1;
    }

    let mut coeff = [0f32; 64];
    for (scan_idx, &pos) in table.iter().enumerate().take(N * N) {
        let mut v = dequantize(scanned[scan_idx], qstep);
        if level_shift != 0 && pos == 0 {
            v += level_shift as f32 * (N * N) as f32;
        }
        coeff[pos] = v;
    }
    inverse_dct::<N>(&coeff)
}

/// 把解码出的 8 步长块写回完整平面
pub fn put_block<const N: usize>(plane: &mut [i16], stride: usize, x0: usize, y0: usize, blk: &[i16; 64]) {
    for j in 0..N {
        for i in 0..N {
            plane[(y0 + j) * stride + (x0 + i)] = blk[j * 8 + i].clamp(0, 255);
        }
    }
}

/// 残差叠加: cur = bg + blk
pub fn add_block<const N: usize>(
    plane: &mut [i16],
    stride: usize,
    x0: usize,
    y0: usize,
    blk: &[i16; 64],
) {
    for j in 0..N {
        for i in 0..N {
            let v = plane[(y0 + j) * stride + (x0 + i)] + blk[j * 8 + i];
            plane[(y0 + j) * stride + (x0 + i)] = v.clamp(0, 255);
        }
    }
}
