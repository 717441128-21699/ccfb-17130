//! 8x8 块的 DCT 量化与 Huffman 熵编码原语(编码/解码共用)。

use crate::bitio::{category, BitReader, BitWriter};
use crate::dct;
use crate::huff::{self, HuffTable, AC_EOB, AC_ESCAPE};
use crate::quant::{dequantize, quantize, ZIGZAG};

/// 把一个 8x8 像素块做 DCT+量化,输出 zigzag 顺序的量化电平。
pub fn transform_quant(block: &[i16; 64], qtab: &[i32; 64], levels: &mut [i16; 64]) {
    let coef = dct::fdct(block);
    let mut zz = [0i32; 64];
    for k in 0..64 {
        zz[k] = coef[ZIGZAG[k]];
    }
    quantize(&zz, qtab, levels);
}

/// 反量化 + IDCT,还原 8x8 像素块。
pub fn inverse_transform(levels: &[i16; 64], iqtab: &[i32; 64], block: &mut [i16; 64]) {
    let mut zz = [0i32; 64];
    dequantize(levels, iqtab, &mut zz);
    let mut coef = [0i32; 64];
    for k in 0..64 {
        coef[ZIGZAG[k]] = zz[k];
    }
    *block = dct::idct(&coef);
}

/// 熵编码一个块:`levels` 为 zigzag 量化电平,`dc_pred` 为同分量前一块 DC 电平。
/// 返回新的 DC 预测值。
pub fn entropy_encode_block(
    bw: &mut BitWriter,
    dc_tab: &HuffTable,
    ac_tab: &HuffTable,
    levels: &[i16; 64],
    dc_pred: i16,
) -> i16 {
    // DC 差分
    let dc = levels[0];
    let diff = dc as i32 - dc_pred as i32;
    let cat = category(diff);
    dc_tab.encode_symbol(bw, cat as usize);
    bw.write_signed(diff, cat);

    // AC:游程 + 类别
    let mut run = 0u32;
    for k in 1..64 {
        let v = levels[k] as i32;
        if v == 0 {
            run += 1;
            continue;
        }
        while run >= 16 {
            ac_tab.encode_symbol(bw, huff::AC_ZRL);
            run -= 16;
        }
        let s = category(v);
        ac_tab.encode_symbol(bw, huff::ac_index(run, s));
        bw.write_signed(v, s);
        run = 0;
    }
    if run > 0 {
        ac_tab.encode_symbol(bw, AC_EOB);
    }
    dc
}

/// 熵解码一个块,返回该块量化电平(zigzag)与新 DC 预测值。
pub fn entropy_decode_block(
    br: &mut BitReader,
    dc_tab: &HuffTable,
    ac_tab: &HuffTable,
    dc_pred: i16,
) -> ([i16; 64], i16) {
    let mut levels = [0i16; 64];
    let cat = dc_tab.decode_symbol(br) as u32;
    let diff = br.read_signed(cat);
    let dc = dc_pred as i32 + diff;
    levels[0] = dc.clamp(-2048, 2047) as i16;

    let mut k = 1usize;
    while k < 64 {
        let sym = ac_tab.decode_symbol(br);
        if sym == AC_EOB {
            break;
        }
        if sym == AC_ESCAPE {
            // 显式 (run, level):6 位 run + 8 位有符号 level
            let run = br.read(6);
            let lvl = br.read(8) as i8 as i32;
            k += run as usize;
            if k < 64 {
                levels[k] = lvl.clamp(-128, 127) as i16;
                k += 1;
            }
            continue;
        }
        if sym == huff::AC_ZRL {
            k += 16;
            continue;
        }
        // 普通 AC 符号:index = run*10 + (size-1)
        let run = (sym / 10) as u32;
        let size = (sym % 10) as u32 + 1;
        k += run as usize;
        if k >= 64 {
            break;
        }
        let v = br.read_signed(size);
        levels[k] = v.clamp(-2048, 2047) as i16;
        k += 1;
    }
    (levels, levels[0])
}

/// 块类别(与 TS 侧 ClassMap 约定一致)。
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MbClass {
    Background = 0,
    Crawling = 1,
    Flying = 2,
    Pollen = 3,
}

impl MbClass {
    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => MbClass::Crawling,
            2 => MbClass::Flying,
            3 => MbClass::Pollen,
            _ => MbClass::Background,
        }
    }

    /// 类别相对帧基准 QP 的偏移:越重要越精细(QP 越小)。
    ///
    /// 设计权衡:背景在 P 帧被整体跳过(零字节),仅在 I 帧/光照变化时编码,
    /// 因此背景偏移不能过大——否则周期性 I 帧会在静态区域产生可见块状闪烁。
    /// 主要码率节省来自 P 帧跳过而非粗化背景,故背景仅适度增粗。
    pub fn qp_delta(self) -> i32 {
        match self {
            // 蜜蜂类别负偏移(更精细),花粉最甚;背景正偏移增粗,
            // 把 P 帧背景跳过省下的字节倾斜给蜜蜂区。
            MbClass::Background => 6,
            MbClass::Crawling => -2,
            MbClass::Flying => -6,
            MbClass::Pollen => -9,
        }
    }
}

/// 计算有效 QP 并裁剪。
pub fn effective_qp(frame_qp: u8, class: MbClass) -> u8 {
    (frame_qp as i32 + class.qp_delta())
        .clamp(1, crate::quant::QP_MAX as i32) as u8
}

// 防止未使用告警(huff 常量在编码侧通过符号空间间接使用)
const _: usize = huff::AC_SYMBOLS;
