//! 整帧编码引擎:关键帧(全帧绝对编码)与前景帧(背景残差,仅活动块)
//!
//! 容器内布局(全部大端定长头部 + 自界定连续比特流):
//! 关键帧: u16 w | u16 h | u32 lumaBits | luma 流 | u32 chromaBits | (u+v) 流
//! 前景帧: u16 nActive | 每活动块 { u16 bx, u16 by, 块比特流(luma+2chroma) }
//! 前景帧整体为一个连续 BitWriter,仅在帧尾字节对齐。

use crate::bitstream::{BitReader, BitWriter};
use crate::block::{add_block, decode_block, encode_block_into, put_block};
use crate::motion::CLASS_BG;

#[inline]
fn u16be(v: usize) -> [u8; 2] {
    [(v >> 8) as u8, (v & 0xff) as u8]
}

#[inline]
fn u32be(v: usize) -> [u8; 4] {
    [
        (v >> 24) as u8,
        (v >> 16) as u8,
        (v >> 8) as u8,
        v as u8,
    ]
}

/// 关键帧 payload
pub fn encode_keyframe(y: &[i16], u: &[i16], v: &[i16], w: usize, h: usize, qp: i32) -> Vec<u8> {
    let nbw = w / 8;
    let nbh = h / 8;
    let cw = w / 2;
    let ch = h / 2;
    let mut out = Vec::with_capacity(w * h / 6);
    out.extend_from_slice(&u16be(w));
    out.extend_from_slice(&u16be(h));

    // 亮度连续流
    let mut lw = BitWriter::new();
    for by in 0..nbh {
        for bx in 0..nbw {
            encode_block_into::<8>(y, w, bx * 8, by * 8, qp, 128, &mut lw);
        }
    }
    let luma_bytes = lw.bit_count();
    let luma = lw.into_bytes();
    out.extend_from_slice(&u32be(luma_bytes));
    out.extend_from_slice(&luma);

    // 色度连续流(u、v 平面依次写入同一流)
    let mut cw_ = BitWriter::new();
    for plane in [u, v] {
        for cy in 0..(ch / 4) {
            for cx in 0..(cw / 4) {
                encode_block_into::<4>(plane, cw, cx * 4, cy * 4, (qp + 2).clamp(1, 63), 128, &mut cw_);
            }
        }
    }
    let chroma_bits = cw_.bit_count();
    let chroma = cw_.into_bytes();
    out.extend_from_slice(&u32be(chroma_bits));
    out.extend_from_slice(&chroma);
    out
}

pub fn decode_keyframe(payload: &[u8]) -> Option<(usize, usize, Vec<i16>, Vec<i16>, Vec<i16>)> {
    let w = ((payload[0] as usize) << 8) | payload[1] as usize;
    let h = ((payload[2] as usize) << 8) | payload[3] as usize;
    let nbw = w / 8;
    let nbh = h / 8;
    let cw = w / 2;
    let ch = h / 2;

    let luma_bits = u32_at(payload, 4) as usize;
    let luma_byte_len = luma_bits.div_ceil(8);
    let luma_stream = &payload[8..8 + luma_byte_len];
    let p = 8 + luma_byte_len;

    let chroma_bits = u32_at(payload, p) as usize;
    let chroma_byte_len = chroma_bits.div_ceil(8);
    let chroma_stream = &payload[p + 4..p + 4 + chroma_byte_len];

    let mut y = vec![0i16; w * h];
    let mut u = vec![0i16; cw * ch];
    let mut v = vec![0i16; cw * ch];

    let mut lr = BitReader::new(luma_stream);
    for by in 0..nbh {
        for bx in 0..nbw {
            let blk = decode_block::<8>(&mut lr, 128);
            put_block::<8>(&mut y, w, bx * 8, by * 8, &blk);
        }
    }

    let mut cr = BitReader::new(chroma_stream);
    for plane in [&mut u, &mut v] {
        for cy in 0..(ch / 4) {
            for cx in 0..(cw / 4) {
                let blk = decode_block::<4>(&mut cr, 128);
                put_block::<4>(plane, cw, cx * 4, cy * 4, &blk);
            }
        }
    }
    Some((w, h, y, u, v))
}

/// 前景帧 payload:头部 + 一个覆盖全部活动块的连续比特流
pub fn encode_foreground(
    cur_y: &[i16],
    cur_u: &[i16],
    cur_v: &[i16],
    bg_y: &[i16],
    bg_u: &[i16],
    bg_v: &[i16],
    qp_map: &[u8],
    active: &[u8],
    w: usize,
    h: usize,
) -> Vec<u8> {
    let nbw = w / 8;
    let nbh = h / 8;
    let cw = w / 2;
    let _ch = h / 2;

    let mut res_y = vec![0i16; w * h];
    let mut res_u = vec![0i16; cw * (h / 2)];
    let mut res_v = vec![0i16; cw * (h / 2)];
    for by in 0..nbh {
        for bx in 0..nbw {
            let bi = by * nbw + bx;
            if active[bi] == CLASS_BG {
                continue;
            }
            let x0 = bx * 8;
            let y0 = by * 8;
            for j in 0..8 {
                for i in 0..8 {
                    let idx = (y0 + j) * w + (x0 + i);
                    res_y[idx] = cur_y[idx] - bg_y[idx];
                }
            }
            let cx0 = bx * 4;
            let cy0 = by * 4;
            for j in 0..4 {
                for i in 0..4 {
                    let ci = (cy0 + j) * cw + (cx0 + i);
                    res_u[ci] = cur_u[ci] - bg_u[ci];
                    res_v[ci] = cur_v[ci] - bg_v[ci];
                }
            }
        }
    }

    let n_active = active.iter().filter(|&&c| c != CLASS_BG).count();
    let mut out = Vec::new();
    out.extend_from_slice(&u16be(n_active));

    // 先记录坐标,再写连续比特流
    let mut coords: Vec<(usize, usize)> = Vec::with_capacity(n_active);
    let mut bw = BitWriter::new();
    for by in 0..nbh {
        for bx in 0..nbw {
            let bi = by * nbw + bx;
            if active[bi] == CLASS_BG {
                continue;
            }
            coords.push((bx, by));
            let qp = qp_map[bi] as i32;
            // 块坐标在比特流内用 ue 自界定
            bw.write_ue(bx as u32);
            bw.write_ue(by as u32);
            encode_block_into::<8>(&res_y, w, bx * 8, by * 8, qp, 0, &mut bw);
            encode_block_into::<4>(&res_u, cw, bx * 4, by * 4, (qp + 2).clamp(1, 63), 0, &mut bw);
            encode_block_into::<4>(&res_v, cw, bx * 4, by * 4, (qp + 2).clamp(1, 63), 0, &mut bw);
        }
    }
    let _ = coords;
    let bits = bw.bit_count();
    let stream = bw.into_bytes();
    out.extend_from_slice(&u32be(bits));
    out.extend_from_slice(&stream);
    out
}

pub fn decode_foreground(
    payload: &[u8],
    bg_y: &[i16],
    bg_u: &[i16],
    bg_v: &[i16],
    w: usize,
    _h: usize,
) -> Option<(Vec<i16>, Vec<i16>, Vec<i16>)> {
    let cw = w / 2;
    let mut y = bg_y.to_vec();
    let mut u = bg_u.to_vec();
    let mut v = bg_v.to_vec();

    let n = ((payload[0] as usize) << 8) | payload[1] as usize;
    let bits = u32_at(payload, 2) as usize;
    let byte_len = bits.div_ceil(8);
    let stream = &payload[6..6 + byte_len];
    let mut r = BitReader::new(stream);

    for _ in 0..n {
        let bx = r.read_ue() as usize;
        let by = r.read_ue() as usize;

        let luma = decode_block::<8>(&mut r, 0);
        add_block::<8>(&mut y, w, bx * 8, by * 8, &luma);

        let bu = decode_block::<4>(&mut r, 0);
        add_block::<4>(&mut u, cw, bx * 4, by * 4, &bu);

        let bv = decode_block::<4>(&mut r, 0);
        add_block::<4>(&mut v, cw, bx * 4, by * 4, &bv);
    }
    Some((y, u, v))
}

#[inline]
fn u32_at(data: &[u8], off: usize) -> u32 {
    ((data[off] as u32) << 24)
        | ((data[off + 1] as u32) << 16)
        | ((data[off + 2] as u32) << 8)
        | data[off + 3] as u32
}
