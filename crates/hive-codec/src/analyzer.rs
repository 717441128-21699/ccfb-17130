//! 分块运动分析的 Rust 实现(编译进 WASM,性能优于 TS 解释执行)。
//!
//! 与 src/core/motion.ts 算法等价:逐像素背景模型(浮点 EMA)、16x16 宏块
//! 前景 SAD、最大饱和度花粉检测、质心位移速度估计,输出四类类别图。
//! 状态保存在堆上的 MotionState,跨帧复用,由 ABI 层管理生命周期。

use crate::block::MbClass;

pub const MB: usize = 16;
const LIGHTING_CHANGE_LUMA: f32 = 6.0;
const FG_SAD_PER_PIXEL: f32 = 14.0;
const POLLEN_SAT: i32 = 90;
const FAST_SPEED: f32 = 1.2;

#[inline]
fn luma(r: i32, g: i32, b: i32) -> i32 {
    (19595 * r + 38470 * g + 7471 * b + 32768) >> 16
}

pub struct MotionState {
    width: usize,
    height: usize,
    mb_cols: usize,
    mb_rows: usize,
    // 整数背景模型(0..255),用定点 EMA 更新,避免 f32 吞吐瓶颈。
    bg: Vec<i32>,
    luma_buf: Vec<i32>,
    bg_ready: bool,
    track_cx: Vec<f32>,
    track_cy: Vec<f32>,
    track_speed: Vec<f32>,
    frame_count: u32,
}

impl MotionState {
    pub fn new(width: usize, height: usize) -> Self {
        let mb_cols = width.div_ceil(MB);
        let mb_rows = height.div_ceil(MB);
        let n = mb_cols * mb_rows;
        let pix = width * height;
        Self {
            width,
            height,
            mb_cols,
            mb_rows,
            bg: vec![0; pix],
            luma_buf: vec![0; pix],
            bg_ready: false,
            track_cx: vec![0.0; n],
            track_cy: vec![0.0; n],
            track_speed: vec![0.0; n],
            frame_count: 0,
        }
    }

    pub fn mb_count(&self) -> usize {
        self.mb_cols * self.mb_rows
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }

    /// 分析一帧 RGB(交错),写入类别图(长度 mb_cols*mb_rows)。
    pub fn analyze(&mut self, rgb: &[u8], class_map: &mut [u8]) {
        let (w, h) = (self.width, self.height);
        let n = w * h;

        // 单遍计算亮度(复用跨帧缓冲,避免每帧分配)
        let luma_buf = &mut self.luma_buf;
        let mut luma_sum = 0i64;
        for p in 0..n {
            let i = p * 3;
            let y = luma(rgb[i] as i32, rgb[i + 1] as i32, rgb[i + 2] as i32);
            luma_buf[p] = y;
            luma_sum += y as i64;
        }
        let mean_luma = luma_sum as f32 / n as f32;

        let mut lighting_changed = false;
        if self.bg_ready {
            let bg_sum: i64 = self.bg.iter().step_by(16).map(|&v| v as i64).sum();
            let bg_mean = bg_sum as f32 / (n / 16).max(1) as f32;
            lighting_changed = (mean_luma - bg_mean).abs() > LIGHTING_CHANGE_LUMA;
        } else {
            for p in 0..n {
                self.bg[p] = luma_buf[p];
            }
            self.bg_ready = true;
        }

        // 定点 EMA 步长:常规 1/25,光照变化 1/6
        let ema_step = if lighting_changed { 6 } else { 25 };

        for my in 0..self.mb_rows {
            for mx in 0..self.mb_cols {
                let m = my * self.mb_cols + mx;
                let x0 = mx * MB;
                let y0 = my * MB;
                let mut sad = 0i64;
                let mut sat_max = 0i32;
                let mut wx = 0i64;
                let mut wy = 0i64;
                let mut weight = 0i64;

                for dy in 0..MB {
                    let y = (y0 + dy).min(h - 1);
                    let row = y * w;
                    for dx in 0..MB {
                        let x = (x0 + dx).min(w - 1);
                        let p = row + x;
                        let diff = (luma_buf[p] - self.bg[p]).unsigned_abs() as i64;
                        sad += diff;
                        let i = p * 3;
                        let (r, g, b) = (rgb[i] as i32, rgb[i + 1] as i32, rgb[i + 2] as i32);
                        let mxv = r.max(g).max(b);
                        let mnv = r.min(g).min(b);
                        sat_max = sat_max.max(mxv - mnv);
                        wx += dx as i64 * diff;
                        wy += dy as i64 * diff;
                        weight += diff;
                    }
                }

                let is_fg = (sad as f32 / (MB * MB) as f32) > FG_SAD_PER_PIXEL;
                if !is_fg {
                    class_map[m] = MbClass::Background as u8;
                    // 定点整数 EMA:bg += (y - bg) / step
                    for dy in 0..MB {
                        let y = (y0 + dy).min(h - 1);
                        let row = y * w;
                        for dx in 0..MB {
                            let x = (x0 + dx).min(w - 1);
                            let p = row + x;
                            self.bg[p] += (luma_buf[p] - self.bg[p]) / ema_step;
                        }
                    }
                } else {
                    let cx = if weight > 0 {
                        x0 as f32 + wx as f32 / weight as f32
                    } else {
                        x0 as f32 + MB as f32 / 2.0
                    };
                    let cy = if weight > 0 {
                        y0 as f32 + wy as f32 / weight as f32
                    } else {
                        y0 as f32 + MB as f32 / 2.0
                    };
                    let inst = if self.frame_count == 0 {
                        0.0
                    } else {
                        ((cx - self.track_cx[m]).powi(2) + (cy - self.track_cy[m]).powi(2)).sqrt()
                    };
                    self.track_speed[m] = self.track_speed[m] * 0.6 + inst * 0.4;
                    self.track_cx[m] = cx;
                    self.track_cy[m] = cy;

                    class_map[m] = if sat_max > POLLEN_SAT {
                        MbClass::Pollen as u8
                    } else if self.track_speed[m] >= FAST_SPEED {
                        MbClass::Flying as u8
                    } else {
                        MbClass::Crawling as u8
                    };
                }
            }
        }
        self.frame_count += 1;
    }
}
