//! 帧编码引擎:背景 MB 跳过、分类 MB 差异化 QP、I/P 帧、码率控制。

use crate::bitio::BitWriter;
use crate::block::{effective_qp, entropy_encode_block, transform_quant, MbClass};
use crate::color::rgb_to_yuv;
use crate::container::{FileHeader, FrameHeader, FILE_HEADER_SIZE, FRAME_HEADER_SIZE};
use crate::huff::{ac_weights, dc_weights, HuffTable};
use crate::quant::QT;

pub const MB: usize = 16;
pub const BLOCK: usize = 8;

/// P 帧背景 MB 跳过的 Y 平面 SAD 阈值:超过则视为"重新暴露的背景",强制编码刷新。
/// 256 像素、平均每像素允许约 2 个灰度级差异(吸收量化与噪声)。
const MB_SAD_SKIP_THRESHOLD: u64 = 256 * 2;

/// 依据目标码率估算初始帧 QP:每像素比特数(bpp)越低,QP 越高。
/// bpp ≈ bitrate / (fps * 像素数);映射到 QP 4..28 区间。
fn initial_qp(target_bitrate: u64, pw: usize, ph: usize, fps: u32) -> u8 {
    if target_bitrate == 0 {
        return 12;
    }
    let bpp = target_bitrate as f64 / (fps.max(1) as f64 * (pw * ph) as f64);
    // bpp 0.02 -> QP~26;bpp 0.5 -> QP~6(对数线性)
    let qp = 18.0 - 6.5 * (bpp.max(1e-4).ln());
    qp.round().clamp(4.0, 28.0) as u8
}

pub struct EncoderConfig {
    pub width: usize,
    pub height: usize,
    pub fps: u32,
    pub frame_count: u32,
    pub gop: u32,
    pub target_bitrate: u64, // bps,0 = 固定质量
    pub base_qp: u8,         // 固定质量模式下的帧基准 QP
}

pub struct EncodeStats {
    pub frames: u32,
    pub bytes: u64,
    pub coded_mbs_total: u64,
    pub qp_history: Vec<u8>,
    pub bytes_per_frame: Vec<u32>,
}

pub struct Encoder {
    cfg: EncoderConfig,
    pw: usize,
    ph: usize,
    mb_cols: usize,
    mb_rows: usize,
    qt: QT,
    dc_tab: HuffTable,
    ac_tab: HuffTable,
    ref_y: Vec<u8>,
    ref_u: Vec<u8>,
    ref_v: Vec<u8>,
    cur_y: Vec<u8>,
    cur_u: Vec<u8>,
    cur_v: Vec<u8>,
    out: Vec<u8>,
    key_offsets: Vec<u64>,
    stats: EncodeStats,
    // 码率控制
    rc_qp: u8,
    rc_window_bytes: u64,
    rc_window_frames: u32,
    initialized: bool,
}

impl Encoder {
    pub fn new(cfg: EncoderConfig) -> Self {
        let pw = cfg.width.div_ceil(MB) * MB;
        let ph = cfg.height.div_ceil(MB) * MB;
        // 在 cfg 被 move 进结构体前先算好初始 QP
        let start_qp = initial_qp(cfg.target_bitrate, pw, ph, cfg.fps);
        let n_pix = pw * ph;
        let n_c = (pw / 2) * (ph / 2);
        let qt = QT::build();
        let mut out = Vec::with_capacity(FILE_HEADER_SIZE);
        let hdr = FileHeader {
            width: cfg.width as u32,
            height: cfg.height as u32,
            padded_width: pw as u32,
            padded_height: ph as u32,
            fps: cfg.fps,
            frame_count: cfg.frame_count,
            gop: cfg.gop,
            target_bitrate: cfg.target_bitrate,
        };
        hdr.write(&mut out);
        Encoder {
            cfg,
            pw,
            ph,
            mb_cols: pw / MB,
            mb_rows: ph / MB,
            qt,
            dc_tab: HuffTable::build(&dc_weights()),
            ac_tab: HuffTable::build(&ac_weights()),
            ref_y: vec![0; n_pix],
            ref_u: vec![128; n_c],
            ref_v: vec![128; n_c],
            cur_y: vec![0; n_pix],
            cur_u: vec![128; n_c],
            cur_v: vec![128; n_c],
            out,
            key_offsets: Vec::new(),
            stats: EncodeStats {
                frames: 0,
                bytes: 0,
                coded_mbs_total: 0,
                qp_history: Vec::new(),
                bytes_per_frame: Vec::new(),
            },
            // 初始 QP 依据目标码率与每像素比特数(bpp)估算,使码率控制快速收敛。
            rc_qp: start_qp,
            rc_window_bytes: 0,
            rc_window_frames: 0,
            initialized: false,
        }
    }

    pub fn frame_size(&self) -> usize {
        self.pw * self.ph * 3
    }

    pub fn mb_count(&self) -> usize {
        self.mb_cols * self.mb_rows
    }

    pub fn padded_dims(&self) -> (usize, usize) {
        (self.pw, self.ph)
    }

    pub fn bytes_so_far(&self) -> u64 {
        self.out.len() as u64
    }

    /// 编码一帧。`rgb` 为 pw*ph*3(已填充),`classes` 为 mb_cols*mb_rows 的类别图。
    pub fn write_frame(&mut self, rgb: &[u8], classes: &[u8]) -> Result<u32, &'static str> {
        if rgb.len() != self.frame_size() {
            return Err("rgb size mismatch");
        }
        if classes.len() != self.mb_cols * self.mb_rows {
            return Err("class map size mismatch");
        }
        let index = self.stats.frames;
        let is_i = !self.initialized || index.is_multiple_of(self.cfg.gop.max(1));

        rgb_to_yuv(rgb, self.pw, self.ph, &mut self.cur_y, &mut self.cur_u, &mut self.cur_v);

        let frame_qp = if self.cfg.target_bitrate > 0 {
            self.rc_qp
        } else {
            self.cfg.base_qp
        };

        // 先决定哪些 MB 参与编码,并构建 MB 位图。
        // P 帧背景 MB 仅在"与参考帧实际一致"时才跳过;若该 MB 是运动物体
        // 离开后重新暴露的背景(分类为背景但参考帧残留旧像素),必须编码刷新,
        // 否则解码端跳过时会错误继承残留内容。
        let total_mbs = self.mb_cols * self.mb_rows;
        let mut bitmap = vec![0u8; total_mbs.div_ceil(8)];
        let mut coded_mbs = 0u32;
        for m in 0..total_mbs {
            let class = MbClass::from_u8(classes[m]);
            let mut code_it = is_i || class != MbClass::Background;
            if !code_it && !is_i {
                // 背景 MB:检查与参考帧的 Y 平面 SAD,不一致则强制刷新
                let mx = m % self.mb_cols;
                let my = m / self.mb_cols;
                if self.mb_luma_sad(mx, my) > MB_SAD_SKIP_THRESHOLD {
                    code_it = true;
                }
            }
            if code_it {
                bitmap[m / 8] |= 1 << (m % 8);
                coded_mbs += 1;
            }
        }

        let mut bw = BitWriter::new(self.pw * self.ph / 4);
        // 每分量一个 DC 预测器
        let mut dc_pred = [0i16; 3];

        for my in 0..self.mb_rows {
            for mx in 0..self.mb_cols {
                let m = my * self.mb_cols + mx;
                if bitmap[m / 8] & (1 << (m % 8)) == 0 {
                    continue;
                }
                let class = MbClass::from_u8(classes[m]);
                let qp = effective_qp(frame_qp, class);
                let qi = qp as usize - 1;
                // P 帧运动 MB(非背景)强制帧内刷新,避免大残差低效编码
                let force_intra = !is_i && class != MbClass::Background;
                self.code_mb(mx, my, is_i, force_intra, qp, qi, &mut bw, &mut dc_pred);
            }
        }
        bw.flush();

        // 写帧头 + MB 位图 + class 图 + payload
        let fh = FrameHeader {
            frame_index: index,
            qp: frame_qp,
            frame_type: if is_i { 1 } else { 2 },
            flags: 0,
            _pad: 0,
            payload_bytes: bw.buf.len() as u32,
            coded_mbs,
            bitmap_bytes: bitmap.len() as u32,
            class_map_bytes: classes.len() as u32,
        };
        let offset = self.out.len() as u64;
        if is_i {
            self.key_offsets.push(offset);
        }
        fh.write(&mut self.out);
        self.out.extend_from_slice(&bitmap);
        self.out.extend_from_slice(classes);
        self.out.extend_from_slice(&bw.buf);

        // 当前帧成为参考帧
        self.ref_y.copy_from_slice(&self.cur_y);
        self.ref_u.copy_from_slice(&self.cur_u);
        self.ref_v.copy_from_slice(&self.cur_v);

        self.stats.frames += 1;
        self.stats.coded_mbs_total += coded_mbs as u64;
        self.stats.qp_history.push(frame_qp);
        self.stats.bytes_per_frame.push(
            (FRAME_HEADER_SIZE as u32)
                + bitmap.len() as u32
                + classes.len() as u32
                + bw.buf.len() as u32,
        );
        self.initialized = true;

        if self.cfg.target_bitrate > 0 {
            self.rate_control(
                bw.buf.len() as u64
                    + FRAME_HEADER_SIZE as u64
                    + bitmap.len() as u64
                    + classes.len() as u64,
            );
        }
        Ok(coded_mbs)
    }

    /// 计算当前帧与参考帧在指定 MB 上的 Y 平面绝对差之和(SAD)。
    /// 带早退:累计超过跳过阈值即返回,避免对明显变化的 MB 扫满 256 像素。
    fn mb_luma_sad(&self, mx: usize, my: usize) -> u64 {
        let x0 = mx * MB;
        let y0 = my * MB;
        let mut sad = 0u64;
        for r in 0..MB {
            let row = (y0 + r) * self.pw + x0;
            for c in 0..MB {
                sad += (self.cur_y[row + c] as i32 - self.ref_y[row + c] as i32).unsigned_abs()
                    as u64;
            }
            if sad > MB_SAD_SKIP_THRESHOLD {
                return sad;
            }
        }
        sad
    }

    fn code_mb(
        &self,
        mx: usize,
        my: usize,
        is_i: bool,
        force_intra: bool,
        qp: u8,
        qi: usize,
        bw: &mut BitWriter,
        dc_pred: &mut [i16; 3],
    ) {
        let (x0, y0) = (mx * MB, my * MB);
        // I 帧或 P 帧高运动 MB 都走帧内预测(pred=0),避免对大幅运动
        // 残差做低效编码;仅静态/背景 MB 在 P 帧用帧间残差。
        let intra = is_i || force_intra;
        // 分量 0=Y(4 块),1=U,2=V(各 1 块)
        for comp in 0..3 {
            let (plane, w, hsize, is_chroma) = match comp {
                0 => (&self.cur_y, self.pw, MB, false),
                1 => (&self.cur_u, self.pw / 2, MB / 2, true),
                _ => (&self.cur_v, self.pw / 2, MB / 2, true),
            };
            let ref_plane = match comp {
                0 => &self.ref_y,
                1 => &self.ref_u,
                _ => &self.ref_v,
            };
            let blocks_per_axis = if is_chroma { 1 } else { 2 };
            let bx0 = if is_chroma { x0 / 2 } else { x0 };
            let by0 = if is_chroma { y0 / 2 } else { y0 };
            let qtab = &self.qt.fwd[is_chroma as usize][qi];
            for by in 0..blocks_per_axis {
                for bx in 0..blocks_per_axis {
                    let mut pixels = [0i16; 64];
                    let ox = bx0 + bx * BLOCK;
                    let oy = by0 + by * BLOCK;
                    // 所有分量统一 level-shift 减 128(JPEG 约定),
                    // 使 DCT 输入以 0 为中心;解码端加回 128。
                    for r in 0..BLOCK {
                        for c in 0..BLOCK {
                            let idx = (oy + r) * w + (ox + c);
                            let cur = plane[idx] as i16 - 128;
                            let pred = if intra {
                                0
                            } else {
                                ref_plane[idx] as i16 - 128
                            };
                            pixels[r * BLOCK + c] = cur - pred;
                        }
                    }
                    let mut levels = [0i16; 64];
                    transform_quant(&pixels, qtab, &mut levels);
                    dc_pred[comp] =
                        entropy_encode_block(bw, &self.dc_tab, &self.ac_tab, &levels, dc_pred[comp]);
                }
            }
            let _ = hsize;
            let _ = qp;
        }
    }

    /// 滑窗码率控制:以约 0.25 秒为反馈窗口,超目标上调 QP,欠用下调。
    /// 窗口足够短,使高帧率(200fps)下也能在一两秒内收敛到目标码率。
    fn rate_control(&mut self, frame_bytes: u64) {
        self.rc_window_bytes += frame_bytes;
        self.rc_window_frames += 1;
        // 窗口帧数:fps/4,至少 8 帧,至多一个完整秒
        let win = (self.cfg.fps.max(1) / 4).clamp(8, self.cfg.fps.max(1)) as u64;
        if self.rc_window_frames as u64 >= win {
            let target_bytes_per_win =
                self.cfg.target_bitrate / 8 * win / self.cfg.fps.max(1) as u64;
            let ratio = self.rc_window_bytes as f64 / target_bytes_per_win.max(1) as f64;
            // 比例化步长:超得越多调得越狠,确保在少数窗口内收敛(高帧率友好)
            let delta = if ratio > 2.0 {
                6
            } else if ratio > 1.5 {
                4
            } else if ratio > 1.15 {
                2
            } else if ratio < 0.4 {
                -3
            } else if ratio < 0.7 {
                -1
            } else {
                0
            };
            self.rc_qp = (self.rc_qp as i32 + delta)
                .clamp(1, crate::quant::QP_MAX as i32) as u8;
            self.rc_window_bytes = 0;
            self.rc_window_frames = 0;
        }
    }

    /// 追加 trailer 并返回完整文件的克隆(可重复调用,幂等)。
    pub fn finish(&mut self) -> Vec<u8> {
        self.stats.bytes = self.out.len() as u64;
        let hdr = FileHeader {
            width: self.cfg.width as u32,
            height: self.cfg.height as u32,
            padded_width: self.pw as u32,
            padded_height: self.ph as u32,
            fps: self.cfg.fps,
            frame_count: self.stats.frames,
            gop: self.cfg.gop,
            target_bitrate: self.cfg.target_bitrate,
        };
        let mut file = self.out.clone();
        crate::container::write_trailer(&mut file, &hdr, self.stats.bytes, &self.key_offsets);
        file
    }

    pub fn stats(&self) -> &EncodeStats {
        &self.stats
    }
}
