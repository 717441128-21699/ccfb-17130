//! 固定规范 Huffman 表(码长上限 16)。
//!
//! 先用普通 Huffman 建树得到码长,再用整数 Kraft 投影把超限码长压缩到 16 位:
//! 每轮把一个最深层符号上移、一个最浅层符号下移,符号总数不变且 Kraft 严格
//! 减小,直到 Kraft <= 2^16。编解码两端用相同预设权重各自构建,无需序列化。

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EncEntry {
    pub code: u32,
    pub len: u8,
}

pub struct HuffTable {
    pub enc: Vec<EncEntry>, // 按符号索引;len=0 表示该符号不参与编码
    pub dec_size: Vec<u8>,
    pub dec_code: Vec<u32>,
    pub dec_symbol: Vec<u16>,
}

const MAX_BITS: usize = 16;

enum T {
    Leaf(u16),
    Pair(Box<T>, Box<T>),
}
struct N2 {
    w: u64,
    t: T,
}
impl Ord for N2 {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        other.w.cmp(&self.w)
    }
}
impl PartialOrd for N2 {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl PartialEq for N2 {
    fn eq(&self, other: &N2) -> bool {
        self.w == other.w
    }
}
impl Eq for N2 {}

fn leaf_depths(t: &T, d: u8, out: &mut [u8]) {
    match t {
        T::Leaf(s) => out[*s as usize] = d.max(1),
        T::Pair(l, r) => {
            leaf_depths(l, d + 1, out);
            leaf_depths(r, d + 1, out);
        }
    }
}

/// 普通 Huffman 建树得到未限制码长(零权重符号为 0)。
fn huffman_lengths(weights: &[u64]) -> Vec<u8> {
    let n = weights.len();
    let mut heap = std::collections::BinaryHeap::with_capacity(n * 2);
    for (s, &w) in weights.iter().enumerate() {
        if w == 0 {
            continue;
        }
        heap.push(N2 {
            w,
            t: T::Leaf(s as u16),
        });
    }
    let mut lengths = vec![0u8; n];
    if heap.is_empty() {
        return lengths;
    }
    while heap.len() > 1 {
        let a = heap.pop().unwrap();
        let b = heap.pop().unwrap();
        heap.push(N2 {
            w: a.w + b.w,
            t: T::Pair(Box::new(a.t), Box::new(b.t)),
        });
    }
    leaf_depths(&heap.pop().unwrap().t, 0, &mut lengths);
    lengths
}

/// 码长限制:整数 Kraft 投影。返回限制后的码长(零权重保持 0)。
fn limit_lengths(raw: &[u8]) -> Vec<u8> {
    let _n = raw.len();
    let mut len: Vec<i32> = raw
        .iter()
        .map(|&l| if l == 0 { 0 } else { l.min(MAX_BITS as u8) as i32 })
        .collect();
    // Kraft 在 2^MAX_BITS 整数尺度下:每个长度 l 的符号占 2^(MAX_BITS-l)。
    let cap = 1i64 << MAX_BITS;
    let kraft = |l: &[i32]| -> i64 {
        l.iter()
            .filter(|&&x| x > 0)
            .map(|&x| 1i64 << (MAX_BITS as i32 - x))
            .sum()
    };
    let mut guard = 0;
    while kraft(&len) > cap {
        // 最深非空层 i 与最浅非空层 j
        let mut i = MAX_BITS as i32;
        while !len.contains(&i) {
            i -= 1;
        }
        let mut j = 1i32;
        while !len.contains(&j) {
            j += 1;
        }
        if i <= j {
            break; // 无可调整空间
        }
        let si = len.iter().position(|&x| x == i).unwrap();
        let sj = len.iter().position(|&x| x == j).unwrap();
        // 守恒交换:深层符号上移(Kraft 增量 +2^(L-i)),浅层符号下移(-2^(L-j-1))
        len[si] = i - 1;
        len[sj] = j + 1;
        guard += 1;
        if guard > 100_000 {
            break;
        }
    }
    let _ = guard;
    len.iter().map(|&x| x.max(0) as u8).collect()
}

impl HuffTable {
    /// 依据符号权重构建规范表。
    pub fn build(weights: &[u64]) -> Self {
        let lengths = limit_lengths(&huffman_lengths(weights));
        let n = weights.len();

        let mut enc = vec![EncEntry { code: 0, len: 0 }; n];
        let mut dec_size = Vec::new();
        let mut dec_code = Vec::new();
        let mut dec_symbol = Vec::new();
        let mut code = 0u32;
        for len in 1u32..=MAX_BITS as u32 {
            code <<= 1;
            for s in 0..n {
                if lengths[s] as u32 == len {
                    enc[s] = EncEntry {
                        code,
                        len: len as u8,
                    };
                    dec_size.push(len as u8);
                    dec_code.push(code);
                    dec_symbol.push(s as u16);
                    code += 1;
                }
            }
        }
        HuffTable {
            enc,
            dec_size,
            dec_code,
            dec_symbol,
        }
    }

    #[inline]
    pub fn encode_symbol(&self, w: &mut crate::bitio::BitWriter, symbol: usize) {
        let e = self.enc[symbol];
        debug_assert!(e.len > 0, "symbol {} has zero-length code", symbol);
        w.write(e.code, e.len as u32);
    }

    /// 逐位解码(最多 16 位,段内线性匹配)。
    #[inline]
    pub fn decode_symbol(&self, r: &mut crate::bitio::BitReader) -> usize {
        let mut code = 0u32;
        for len in 1u32..=MAX_BITS as u32 {
            code = (code << 1) | r.read1();
            for i in 0..self.dec_size.len() {
                if self.dec_size[i] as u32 == len && self.dec_code[i] == code {
                    return self.dec_symbol[i] as usize;
                }
            }
        }
        0 // 损坏流兜底
    }
}

/// DC 差分值类别符号(0..11)的经验权重。
pub fn dc_weights() -> Vec<u64> {
    (0..12u32)
        .map(|cat| 1u64 << (18 - cat.min(18)))
        .collect()
}

/// AC 符号空间(无歧义布局,共 163 个):
/// - 普通 (run,size):run ∈ 0..16,size ∈ 1..=10,索引 = run*10 + (size-1),范围 0..160
/// - ZRL(游程 16)= 160
/// - EOB(块结束)= 161
/// - ESCAPE(显式转义)= 162
pub const AC_ZRL: usize = 160;
pub const AC_EOB: usize = 161;
pub const AC_ESCAPE: usize = 162;
pub const AC_SYMBOLS: usize = 163;

/// 普通 AC 符号索引:run ∈ 0..16(此处 run<16),size ∈ 1..=10。
#[inline]
pub fn ac_index(run: u32, size: u32) -> usize {
    (run * 10 + (size - 1)) as usize
}

pub fn ac_weights() -> Vec<u64> {
    let mut w = vec![0u64; AC_SYMBOLS];
    for run in 0..16u32 {
        for size in 1..=10u32 {
            let idx = ac_index(run, size);
            // run 越大、size 越大越罕见;指数钳制为非负,保证正权重
            let exp = 16i32
                .saturating_sub(run as i32 / 2 + size as i32)
                .max(0);
            w[idx] = 1u64 << exp;
        }
    }
    w[AC_ZRL] = 1u64 << 8;
    w[AC_EOB] = 1u64 << 17;
    w[AC_ESCAPE] = 1u64 << 4;
    w
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bitio::{BitReader, BitWriter};

    fn kraft_of(t: &HuffTable) -> f64 {
        t.enc
            .iter()
            .filter(|e| e.len > 0)
            .map(|e| 0.5f64.powi(e.len as i32))
            .sum()
    }

    #[test]
    fn dc_roundtrip_and_kraft() {
        let t = HuffTable::build(&dc_weights());
        let k = kraft_of(&t);
        assert!((k - 1.0).abs() < 1e-9, "kraft = {}", k);
        assert!(t.enc.iter().all(|e| e.len <= 16));
        let mut bw = BitWriter::new(64);
        for s in 0..12 {
            t.encode_symbol(&mut bw, s);
        }
        bw.flush();
        let mut br = BitReader::new(&bw.buf);
        for s in 0..12 {
            assert_eq!(t.decode_symbol(&mut br), s);
        }
    }

    #[test]
    fn ac_length_limit_and_roundtrip() {
        let t = HuffTable::build(&ac_weights());
        assert!(t.enc.iter().all(|e| e.len <= 16));
        let k = kraft_of(&t);
        assert!(k <= 1.0 + 1e-12, "kraft = {}", k);
        let mut bw = BitWriter::new(256);
        // 合法 AC 符号:ac_index(run,size) 以及 ZRL(160)/EOB(161)/ESCAPE(162)。
        let seq: Vec<usize> = vec![
            ac_index(0, 1),
            AC_EOB,
            ac_index(0, 5),
            AC_ESCAPE,
            AC_EOB,
            ac_index(1, 1),
            ac_index(3, 3),
            AC_EOB,
        ];
        for &s in &seq {
            t.encode_symbol(&mut bw, s);
        }
        bw.flush();
        let mut br = BitReader::new(&bw.buf);
        for &s in &seq {
            assert_eq!(t.decode_symbol(&mut br), s);
        }
    }

    #[test]
    fn degenerate_skewed_weights() {
        // 一个符号主导、其余极多极小:最容易触发超长码
        let mut w = vec![1u64; 200];
        w[0] = 1u64 << 40;
        let t = HuffTable::build(&w);
        assert!(t.enc.iter().all(|e| e.len <= 16));
        assert!(kraft_of(&t) <= 1.0 + 1e-12);
    }

    #[test]
    fn uniform_weights_full_tree() {
        // 8 个等权符号应得到等长 3 位码
        let w = vec![100u64; 8];
        let t = HuffTable::build(&w);
        assert!(t.enc.iter().all(|e| e.len == 3));
        assert!((kraft_of(&t) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn single_valid_symbol() {
        let mut w = vec![0u64; 5];
        w[2] = 42;
        let t = HuffTable::build(&w);
        assert_eq!(t.enc[2].len, 1);
    }
}
