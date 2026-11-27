//! WebAssembly 边界层:纯 C ABI(无 wasm-bindgen),由 TS 侧手工实例化。
//!
//! 内存约定:所有指针为 wasm 线性内存偏移;句柄为装箱对象的裸指针(usize)。

pub mod analyzer;
pub mod bitio;
pub mod block;
pub mod color;
pub mod container;
pub mod dct;
pub mod decoder;
pub mod encoder;
pub mod huff;
pub mod quant;

pub use block::MbClass;

pub const ERR_OK: i64 = 0;
pub const ERR_BAD_ARG: i64 = -1;
pub const ERR_RANGE: i64 = -2;
pub const ERR_FORMAT: i64 = -3;

struct EncHandle {
    enc: encoder::Encoder,
}
struct DecHandle {
    dec: decoder::Decoder,
}

/// 分配 wasm 内缓冲。
#[no_mangle]
pub extern "C" fn hvc_alloc(size: usize) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(size);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// 释放 hvc_alloc 分配的缓冲(需带上原容量)。
#[no_mangle]
pub extern "C" fn hvc_free(ptr: *mut u8, cap: usize) {
    if !ptr.is_null() && cap > 0 {
        unsafe {
            drop(Vec::from_raw_parts(ptr, 0, cap));
        }
    }
}

#[no_mangle]
pub extern "C" fn hvc_encoder_new(
    width: u32,
    height: u32,
    fps: u32,
    frame_count: u32,
    gop: u32,
    target_bitrate: u64,
    base_qp: u8,
) -> usize {
    let enc = encoder::Encoder::new(encoder::EncoderConfig {
        width: width as usize,
        height: height as usize,
        fps,
        frame_count,
        gop: gop.max(1),
        target_bitrate,
        base_qp,
    });
    Box::into_raw(Box::new(EncHandle { enc })) as usize
}

/// 单帧 RGB 字节数(padded 尺寸 * 3)。
#[no_mangle]
pub extern "C" fn hvc_encoder_frame_size(h: usize) -> usize {
    if h == 0 {
        return 0;
    }
    unsafe { &*(h as *const EncHandle) }.enc.frame_size()
}

/// MB 总数(类别图长度)。
#[no_mangle]
pub extern "C" fn hvc_encoder_mb_count(h: usize) -> usize {
    if h == 0 {
        return 0;
    }
    unsafe { &*(h as *const EncHandle) }.enc.mb_count()
}

/// 编码一帧:rgb 与 classes 均指向 wasm 内存。返回编码 MB 数,负值为错误。
#[no_mangle]
pub extern "C" fn hvc_encoder_write(h: usize, rgb: *const u8, classes: *const u8) -> i64 {
    if h == 0 || rgb.is_null() || classes.is_null() {
        return ERR_BAD_ARG;
    }
    let e = unsafe { &mut *(h as *mut EncHandle) };
    let n_rgb = e.enc.frame_size();
    let n_mb = e.enc.mb_count();
    let rgb = unsafe { std::slice::from_raw_parts(rgb, n_rgb) };
    let classes = unsafe { std::slice::from_raw_parts(classes, n_mb) };
    match e.enc.write_frame(rgb, classes) {
        Ok(n) => n as i64,
        Err(_) => ERR_BAD_ARG,
    }
}

/// 完成编码:文件字节拷入 out。返回实际字节数;cap 不足返回 ERR_RANGE。
/// 句柄仍有效,需用 hvc_encoder_close 释放。
#[no_mangle]
pub extern "C" fn hvc_encoder_finish(h: usize, out: *mut u8, cap: usize) -> i64 {
    if h == 0 || out.is_null() {
        return ERR_BAD_ARG;
    }
    let e = unsafe { &mut *(h as *mut EncHandle) };
    let data = e.enc.finish();
    if data.len() > cap {
        return ERR_RANGE;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(data.as_ptr(), out, data.len());
    }
    data.len() as i64
}

#[no_mangle]
pub extern "C" fn hvc_encoder_close(h: usize) {
    if h != 0 {
        unsafe {
            drop(Box::from_raw(h as *mut EncHandle));
        }
    }
}

#[no_mangle]
pub extern "C" fn hvc_encoder_bytes_so_far(h: usize) -> u64 {
    if h == 0 {
        return 0;
    }
    unsafe { &*(h as *const EncHandle) }.enc.bytes_so_far()
}

#[no_mangle]
pub extern "C" fn hvc_decoder_open(ptr: *const u8, len: usize) -> usize {
    if ptr.is_null() || len == 0 {
        return 0;
    }
    let data = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
    match decoder::Decoder::open(data) {
        Ok(dec) => Box::into_raw(Box::new(DecHandle { dec })) as usize,
        Err(_) => 0,
    }
}

#[repr(C)]
pub struct DecInfo {
    pub width: u32,
    pub height: u32,
    pub padded_width: u32,
    pub padded_height: u32,
    pub fps: u32,
    pub frame_count: u32,
    pub key_frames: u32,
    pub target_bitrate: u64,
}

#[no_mangle]
pub extern "C" fn hvc_decoder_info(h: usize, info: *mut DecInfo) -> i64 {
    if h == 0 || info.is_null() {
        return ERR_BAD_ARG;
    }
    let d = unsafe { &*(h as *const DecHandle) };
    let hd = d.dec.header();
    unsafe {
        *info = DecInfo {
            width: hd.width as u32,
            height: hd.height as u32,
            padded_width: hd.padded_width as u32,
            padded_height: hd.padded_height as u32,
            fps: hd.fps,
            frame_count: hd.frame_count,
            key_frames: d.dec.key_frame_count() as u32,
            target_bitrate: hd.target_bitrate,
        };
    }
    ERR_OK
}

#[no_mangle]
pub extern "C" fn hvc_decoder_rgb_size(h: usize) -> usize {
    if h == 0 {
        return 0;
    }
    let d = unsafe { &*(h as *const DecHandle) };
    let hd = d.dec.header();
    hd.width * hd.height * 3
}

#[no_mangle]
pub extern "C" fn hvc_decoder_seek(h: usize, target: u32, out: *mut u8, cap: usize) -> i64 {
    if h == 0 || out.is_null() {
        return ERR_BAD_ARG;
    }
    let d = unsafe { &mut *(h as *mut DecHandle) };
    let need = d.dec.header().width * d.dec.header().height * 3;
    if cap < need {
        return ERR_RANGE;
    }
    let buf = unsafe { std::slice::from_raw_parts_mut(out, need) };
    match d.dec.seek_decode(target, buf) {
        Ok(()) => ERR_OK,
        Err(_) => ERR_FORMAT,
    }
}

#[no_mangle]
pub extern "C" fn hvc_decoder_close(h: usize) {
    if h != 0 {
        unsafe {
            drop(Box::from_raw(h as *mut DecHandle));
        }
    }
}

// ---------- 运动分析(WASM 原生实现,替代 TS 分析以提升吞吐) ----------

struct AnalyzerHandle(analyzer::MotionState);

/// 创建运动分析器。
#[no_mangle]
pub extern "C" fn hvc_analyzer_new(width: u32, height: u32) -> usize {
    Box::into_raw(Box::new(AnalyzerHandle(analyzer::MotionState::new(
        width as usize,
        height as usize,
    )))) as usize
}

/// 返回类别图长度(MB 总数)。
#[no_mangle]
pub extern "C" fn hvc_analyzer_mb_count(h: usize) -> usize {
    if h == 0 {
        return 0;
    }
    let handle = unsafe { &*(h as *const AnalyzerHandle) };
    handle.0.mb_count()
}

/// 分析一帧:rgb 为 width*height*3 字节,out_classes 为 mb_count 字节缓冲。
#[no_mangle]
pub extern "C" fn hvc_analyze_frame(
    h: usize,
    rgb: *const u8,
    rgb_len: usize,
    out_classes: *mut u8,
    out_len: usize,
) -> i64 {
    if h == 0 || rgb.is_null() || out_classes.is_null() {
        return ERR_BAD_ARG;
    }
    let handle = unsafe { &mut *(h as *mut AnalyzerHandle) };
    let mb = handle.0.mb_count();
    if rgb_len < handle.0.width() * handle.0.height() * 3 || out_len < mb {
        return ERR_RANGE;
    }
    let rgb_slice = unsafe { std::slice::from_raw_parts(rgb, rgb_len) };
    let out = unsafe { std::slice::from_raw_parts_mut(out_classes, mb) };
    handle.0.analyze(rgb_slice, out);
    ERR_OK
}

#[no_mangle]
pub extern "C" fn hvc_analyzer_close(h: usize) {
    if h != 0 {
        unsafe {
            drop(Box::from_raw(h as *mut AnalyzerHandle));
        }
    }
}
