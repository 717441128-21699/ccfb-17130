//! 解码引擎:Trailer 索引随机访问、I/P 帧重建、按需裁剪输出原始尺寸。

use crate::bitio::BitReader;
use crate::block::{effective_qp, entropy_decode_block, inverse_transform, MbClass};
use crate::color::yuv_to_rgb;
use crate::container::{
    parse_trailer, FrameHeader, TRAILER_SIZE, FILE_HEADER_SIZE, FRAME_HEADER_SIZE,
};
use crate::huff::{ac_weights, dc_weights, HuffTable};
use crate::quant::QT;
use crate::encoder::{BLOCK, MB};

pub struct DecodedHeader {
    pub width: usize,
    pub height: usize,
    pub padded_width: usize,
    pub padded_height: usize,
    pub fps: u32,
    pub frame_count: u32,
    pub gop: u32,
    pub target_bitrate: u64,
}

pub struct Decoder {
    data: Vec<u8>,
    hdr: DecodedHeader,
    qt: QT,
    dc_tab: HuffTable,
    ac_tab: HuffTable,
    key_offsets: Vec<u64>,
    ref_y: Vec<u8>,
    ref_u: Vec<u8>,
    ref_v: Vec<u8>,
    cur_y: Vec<u8>,
    cur_u: Vec<u8>,
    cur_v: Vec<u8>,
    rgb_temp: Vec<u8>,
    cur_frame: i64,
}

impl Decoder {
    pub fn open(data: Vec<u8>) -> Result<Self, &'static str> {
        if data.len() < FILE_HEADER_SIZE + TRAILER_SIZE {
            return Err("file too small");
        }
        if &data[0..4] != b"HVC1" {
            return Err("bad magic");
        }
        let width = u32::from_le_bytes(data[8..12].try_into().unwrap()) as usize;
        let height = u32::from_le_bytes(data[12..16].try_into().unwrap()) as usize;
        let pw = u32::from_le_bytes(data[16..20].try_into().unwrap()) as usize;
        let ph = u32::from_le_bytes(data[20..24].try_into().unwrap()) as usize;
        let fps = u32::from_le_bytes(data[24..28].try_into().unwrap());
        let frame_count = u32::from_le_bytes(data[28..32].try_into().unwrap());
        let trailer = parse_trailer(&data).ok_or("bad trailer")?;
        let n_pix = pw * ph;
        let n_c = (pw / 2) * (ph / 2);
        Ok(Decoder {
            data,
            hdr: DecodedHeader {
                width,
                height,
                padded_width: pw,
                padded_height: ph,
                fps,
                frame_count,
                gop: 0,
                target_bitrate: trailer.target_bitrate,
            },
            qt: QT::build(),
            dc_tab: HuffTable::build(&dc_weights()),
            ac_tab: HuffTable::build(&ac_weights()),
            key_offsets: trailer.key_offsets,
            ref_y: vec![0; n_pix],
            ref_u: vec![128; n_c],
            ref_v: vec![128; n_c],
            cur_y: vec![0; n_pix],
            cur_u: vec![128; n_c],
            cur_v: vec![128; n_c],
            rgb_temp: vec![0; pw * ph * 3],
            cur_frame: -1,
        })
    }

    pub fn header(&self) -> &DecodedHeader {
        &self.hdr
    }

    pub fn key_frame_count(&self) -> usize {
        self.key_offsets.len()
    }

    /// 定位到包含 target 帧的最近 I 帧文件偏移(二分)。
    fn key_offset_for(&self, target: u32) -> u64 {
        let mut lo = 0usize;
        let mut hi = self.key_offsets.len();
        while lo + 1 < hi {
            let mid = (lo + hi) / 2;
            let off = self.key_offsets[mid] as usize;
            let fi = u32::from_le_bytes(self.data[off..off + 4].try_into().unwrap());
            if fi <= target {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        self.key_offsets[lo]
    }

    /// 随机访问:解码 target 帧(自动从最近 I 帧起顺序重建),输出裁剪后 RGB。
    pub fn seek_decode(&mut self, target: u32, rgb_out: &mut [u8]) -> Result<(), &'static str> {
        if target >= self.hdr.frame_count {
            return Err("frame out of range");
        }
        let start_off = self.key_offset_for(target) as usize;
        let start_fi =
            u32::from_le_bytes(self.data[start_off..start_off + 4].try_into().unwrap());
        self.ref_y.fill(128);
        self.ref_u.fill(128);
        self.ref_v.fill(128);
        self.cur_frame = start_fi as i64 - 1;

        let mut off = start_off;
        loop {
            let fh = FrameHeader::parse(&self.data[off..off + FRAME_HEADER_SIZE]);
            let bm = off + FRAME_HEADER_SIZE;
            let cm = bm + fh.bitmap_bytes as usize;
            let pay = cm + fh.class_map_bytes as usize;
            let end = pay + fh.payload_bytes as usize;
            let bitmap = self.data[bm..cm].to_vec();
            let class_map = self.data[cm..pay].to_vec();
            let payload = self.data[pay..end].to_vec();
            self.decode_frame(&fh, &bitmap, &class_map, &payload)?;
            off = end;
            if fh.frame_index == target {
                break;
            }
        }
        // 一次 YUV->RGB 到 padded 缓冲,再按行裁剪
        yuv_to_rgb(
            &self.cur_y,
            &self.cur_u,
            &self.cur_v,
            self.hdr.padded_width,
            self.hdr.padded_height,
            &mut self.rgb_temp,
        );
        let pw = self.hdr.padded_width;
        let (w, h) = (self.hdr.width, self.hdr.height);
        for y in 0..h {
            let src = y * pw * 3;
            let dst = y * w * 3;
            rgb_out[dst..dst + w * 3].copy_from_slice(&self.rgb_temp[src..src + w * 3]);
        }
        Ok(())
    }

    fn decode_frame(
        &mut self,
        fh: &FrameHeader,
        bitmap: &[u8],
        class_map: &[u8],
        payload: &[u8],
    ) -> Result<(), &'static str> {
        let pw = self.hdr.padded_width;
        let ph = self.hdr.padded_height;
        let (mb_cols, mb_rows) = (pw / MB, ph / MB);
        let is_i = fh.frame_type == 1;
        // 平面存真实像素值,块解码在 shift 域(pred = ref - 128)进行。
        // I 帧要求 shift 域 pred=0,故 ref 与 cur 都初始化为 128
        // (亮度、色度的中性真实值经 -128 后都为 0)。
        if is_i {
            self.ref_y.fill(128);
            self.ref_u.fill(128);
            self.ref_v.fill(128);
            self.cur_y.fill(128);
            self.cur_u.fill(128);
            self.cur_v.fill(128);
        } else {
            self.cur_y = self.ref_y.clone();
            self.cur_u = self.ref_u.clone();
            self.cur_v = self.ref_v.clone();
        }

        let mut br = BitReader::new(payload);
        let mut dc_pred = [0i16; 3];
        let mut decoded_mbs = 0u32;

        for my in 0..mb_rows {
            for mx in 0..mb_cols {
                let m = my * mb_cols + mx;
                if bitmap[m / 8] & (1 << (m % 8)) == 0 {
                    continue; // 跳过的背景 MB:保留参考内容
                }
                // 关键:按该 MB 的 class 重算有效 QP,与编码端逐 MB 一致,
                // 否则反量化表失配会造成严重失真。
                let class = MbClass::from_u8(class_map[m]);
                let qp = effective_qp(fh.qp, class);
                let qi = qp as usize - 1;
                // 与编码端镜像:I 帧或 P 帧运动 MB 走帧内(pred=0)
                let intra = is_i || class != MbClass::Background;
                decoded_mbs += 1;
                self.decode_mb(mx, my, qi, intra, &mut br, &mut dc_pred);
            }
        }
        debug_assert_eq!(decoded_mbs, fh.coded_mbs);

        self.ref_y = self.cur_y.clone();
        self.ref_u = self.cur_u.clone();
        self.ref_v = self.cur_v.clone();
        self.cur_frame = fh.frame_index as i64;
        Ok(())
    }

    fn decode_mb(
        &mut self,
        mx: usize,
        my: usize,
        qi: usize,
        intra: bool,
        br: &mut BitReader,
        dc_pred: &mut [i16; 3],
    ) {
        let (x0, y0) = (mx * MB, my * MB);
        for comp in 0..3 {
            let is_chroma = comp != 0;
            let w = if is_chroma {
                self.hdr.padded_width / 2
            } else {
                self.hdr.padded_width
            };
            let blocks = if is_chroma { 1 } else { 2 };
            let bx0 = if is_chroma { x0 / 2 } else { x0 };
            let by0 = if is_chroma { y0 / 2 } else { y0 };
            let iqtab = &self.qt.inv[is_chroma as usize][qi];
            for by in 0..blocks {
                for bx in 0..blocks {
                    let (levels, new_dc) =
                        entropy_decode_block(br, &self.dc_tab, &self.ac_tab, dc_pred[comp]);
                    dc_pred[comp] = new_dc;
                    let mut block = [0i16; 64];
                    inverse_transform(&levels, iqtab, &mut block);
                    let ox = bx0 + bx * BLOCK;
                    let oy = by0 + by * BLOCK;
                    let plane = match comp {
                        0 => &mut self.cur_y,
                        1 => &mut self.cur_u,
                        _ => &mut self.cur_v,
                    };
                    let ref_plane = match comp {
                        0 => &self.ref_y,
                        1 => &self.ref_u,
                        _ => &self.ref_v,
                    };
                    // 所有分量统一 level-shift 128,与编码端镜像。
                    // intra 模式 pred=0;帧间模式用参考帧残差预测。
                    for r in 0..BLOCK {
                        for c in 0..BLOCK {
                            let idx = (oy + r) * w + (ox + c);
                            let pred = if intra { 0 } else { ref_plane[idx] as i32 - 128 };
                            let v = pred + block[r * BLOCK + c] as i32 + 128;
                            plane[idx] = v.clamp(0, 255) as u8;
                        }
                    }
                }
            }
        }
    }
}
