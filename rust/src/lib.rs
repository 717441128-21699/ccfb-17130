//! C ABI 导出层:供 JS 通过 WebAssembly 线性内存直接调用,不依赖 wasm-bindgen。
//! 所有平面均为 i16 小端,长度 = 像素数 * 2 字节。

mod bitstream;
mod block;
mod color;
mod dct;
mod engine;
mod motion;

use std::slice;

#[no_mangle]
pub extern "C" fn hive_malloc(size: usize) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(size);
    let ptr = v.as_mut_ptr();
    std::mem::forget(v);
    ptr
}

#[no_mangle]
pub extern "C" fn hive_free(ptr: *mut u8, size: usize) {
    if !ptr.is_null() && size != 0 {
        unsafe {
            drop(Vec::from_raw_parts(ptr, 0, size));
        }
    }
}

unsafe fn u8_slice<'a>(ptr: *const u8, len: usize) -> Option<&'a [u8]> {
    if ptr.is_null() {
        return None;
    }
    Some(slice::from_raw_parts(ptr, len))
}

unsafe fn i16_slice<'a>(ptr: *const u8, n_elems: usize) -> Option<&'a [i16]> {
    if ptr.is_null() {
        return None;
    }
    Some(slice::from_raw_parts(ptr as *const i16, n_elems))
}

unsafe fn i16_slice_mut<'a>(ptr: *mut u8, n_elems: usize) -> Option<&'a mut [i16]> {
    if ptr.is_null() {
        return None;
    }
    Some(slice::from_raw_parts_mut(ptr as *mut i16, n_elems))
}

/// RGBA -> YUV420。返回 0 成功,-1 参数错误。
#[no_mangle]
pub extern "C" fn hive_rgba_to_yuv(
    rgba: *const u8,
    rgba_len: usize,
    w: usize,
    h: usize,
    y: *mut u8,
    u: *mut u8,
    v: *mut u8,
) -> i32 {
    if w % 8 != 0 || h % 8 != 0 || rgba_len < w * h * 4 {
        return -1;
    }
    unsafe {
        let rgba = match u8_slice(rgba, rgba_len) {
            Some(s) => s,
            None => return -1,
        };
        let (y, u, v) = match (
            i16_slice_mut(y, w * h),
            i16_slice_mut(u, w * h / 4),
            i16_slice_mut(v, w * h / 4),
        ) {
            (Some(a), Some(b), Some(c)) => (a, b, c),
            _ => return -1,
        };
        color::rgba_to_yuv420(rgba, w, h, y, u, v);
    }
    0
}

#[no_mangle]
pub extern "C" fn hive_yuv_to_rgba(
    y: *const u8,
    u: *const u8,
    v: *const u8,
    w: usize,
    h: usize,
    rgba: *mut u8,
    rgba_len: usize,
) -> i32 {
    if rgba_len < w * h * 4 {
        return -1;
    }
    unsafe {
        let (y, u, v) = match (
            i16_slice(y, w * h),
            i16_slice(u, w * h / 4),
            i16_slice(v, w * h / 4),
        ) {
            (Some(a), Some(b), Some(c)) => (a, b, c),
            _ => return -1,
        };
        let out = slice::from_raw_parts_mut(rgba, rgba_len);
        color::yuv420_to_rgba(y, u, v, w, h, out);
    }
    0
}

/// 运动分析。返回亮度漂移(Q8),-1 为参数错误。
#[no_mangle]
pub extern "C" fn hive_analyze(
    bg_y: *const u8,
    cur_y: *const u8,
    cur_u: *const u8,
    cur_v: *const u8,
    w: usize,
    h: usize,
    classes: *mut u8,
    sads: *mut u32,
    sad_active: u32,
    sad_fast: u32,
    pollen_v: i32,
    pollen_sat: i32,
) -> i32 {
    let nblk = (w / 8) * (h / 8);
    unsafe {
        let (bg_y, cur_y, cur_u, cur_v) = match (
            i16_slice(bg_y, w * h),
            i16_slice(cur_y, w * h),
            i16_slice(cur_u, w * h / 4),
            i16_slice(cur_v, w * h / 4),
        ) {
            (Some(a), Some(b), Some(c), Some(d)) => (a, b, c, d),
            _ => return -1,
        };
        let cls = slice::from_raw_parts_mut(classes, nblk);
        let sad = slice::from_raw_parts_mut(sads, nblk);
        motion::analyze_frame(
            bg_y, cur_y, cur_u, cur_v, w, h, cls, sad,
            &motion::AnalyzeParams { sad_active, sad_fast, pollen_v, pollen_sat },
        )
    }
}

#[no_mangle]
pub extern "C" fn hive_update_bg(
    bg_y: *mut u8,
    bg_u: *mut u8,
    bg_v: *mut u8,
    cur_y: *const u8,
    cur_u: *const u8,
    cur_v: *const u8,
    classes: *const u8,
    w: usize,
    h: usize,
    alpha_q8: u32,
) -> i32 {
    let nblk = (w / 8) * (h / 8);
    unsafe {
        let (bg_y, bg_u, bg_v, cur_y, cur_u, cur_v, cls) = match (
            i16_slice_mut(bg_y, w * h),
            i16_slice_mut(bg_u, w * h / 4),
            i16_slice_mut(bg_v, w * h / 4),
            i16_slice(cur_y, w * h),
            i16_slice(cur_u, w * h / 4),
            i16_slice(cur_v, w * h / 4),
            u8_slice(classes, nblk),
        ) {
            (Some(a), Some(b), Some(c), Some(d), Some(e), Some(f), Some(g)) => (a, b, c, d, e, f, g),
            _ => return -1,
        };
        motion::update_background(bg_y, bg_u, bg_v, cur_y, cur_u, cur_v, cls, w, h, alpha_q8);
    }
    0
}

/// 编码关键帧。返回所需字节数;若 cap 足够则同时写入 out。
#[no_mangle]
pub extern "C" fn hive_enc_keyframe(
    y: *const u8,
    u: *const u8,
    v: *const u8,
    w: usize,
    h: usize,
    qp: i32,
    out: *mut u8,
    cap: usize,
) -> i32 {
    unsafe {
        let (y, u, v) = match (
            i16_slice(y, w * h),
            i16_slice(u, w * h / 4),
            i16_slice(v, w * h / 4),
        ) {
            (Some(a), Some(b), Some(c)) => (a, b, c),
            _ => return -1,
        };
        let bytes = engine::encode_keyframe(y, u, v, w, h, qp);
        if cap >= bytes.len() && !out.is_null() {
            let dst = slice::from_raw_parts_mut(out, bytes.len());
            dst.copy_from_slice(&bytes);
        }
        bytes.len() as i32
    }
}

/// 编码前景帧。返回所需字节数;若 cap 足够则同时写入 out。
#[no_mangle]
pub extern "C" fn hive_enc_foreground(
    cur_y: *const u8,
    cur_u: *const u8,
    cur_v: *const u8,
    bg_y: *const u8,
    bg_u: *const u8,
    bg_v: *const u8,
    qp_map: *const u8,
    active: *const u8,
    w: usize,
    h: usize,
    out: *mut u8,
    cap: usize,
) -> i32 {
    let nblk = (w / 8) * (h / 8);
    unsafe {
        let planes = match (
            i16_slice(cur_y, w * h),
            i16_slice(cur_u, w * h / 4),
            i16_slice(cur_v, w * h / 4),
            i16_slice(bg_y, w * h),
            i16_slice(bg_u, w * h / 4),
            i16_slice(bg_v, w * h / 4),
        ) {
            (Some(a), Some(b), Some(c), Some(d), Some(e), Some(f)) => (a, b, c, d, e, f),
            _ => return -1,
        };
        let qp_map = match u8_slice(qp_map, nblk) {
            Some(s) => s,
            None => return -1,
        };
        let active = match u8_slice(active, nblk) {
            Some(s) => s,
            None => return -1,
        };
        let bytes = engine::encode_foreground(
            planes.0, planes.1, planes.2, planes.3, planes.4, planes.5,
            qp_map, active, w, h,
        );
        if cap >= bytes.len() && !out.is_null() {
            let dst = slice::from_raw_parts_mut(out, bytes.len());
            dst.copy_from_slice(&bytes);
        }
        bytes.len() as i32
    }
}

#[no_mangle]
pub extern "C" fn hive_dec_keyframe(
    payload: *const u8,
    len: usize,
    out_y: *mut u8,
    out_u: *mut u8,
    out_v: *mut u8,
    w: usize,
    h: usize,
) -> i32 {
    unsafe {
        let data = match u8_slice(payload, len) {
            Some(s) => s,
            None => return -1,
        };
        let (dy, du, dv) = match (
            i16_slice_mut(out_y, w * h),
            i16_slice_mut(out_u, w * h / 4),
            i16_slice_mut(out_v, w * h / 4),
        ) {
            (Some(a), Some(b), Some(c)) => (a, b, c),
            _ => return -1,
        };
        match engine::decode_keyframe(data) {
            Some((_, _, y, u, v)) => {
                dy.copy_from_slice(&y);
                du.copy_from_slice(&u);
                dv.copy_from_slice(&v);
                0
            }
            None => -2,
        }
    }
}

#[no_mangle]
pub extern "C" fn hive_dec_foreground(
    payload: *const u8,
    len: usize,
    bg_y: *const u8,
    bg_u: *const u8,
    bg_v: *const u8,
    out_y: *mut u8,
    out_u: *mut u8,
    out_v: *mut u8,
    w: usize,
    h: usize,
) -> i32 {
    unsafe {
        let data = match u8_slice(payload, len) {
            Some(s) => s,
            None => return -1,
        };
        let (bg_y, bg_u, bg_v) = match (
            i16_slice(bg_y, w * h),
            i16_slice(bg_u, w * h / 4),
            i16_slice(bg_v, w * h / 4),
        ) {
            (Some(a), Some(b), Some(c)) => (a, b, c),
            _ => return -1,
        };
        let (dy, du, dv) = match (
            i16_slice_mut(out_y, w * h),
            i16_slice_mut(out_u, w * h / 4),
            i16_slice_mut(out_v, w * h / 4),
        ) {
            (Some(a), Some(b), Some(c)) => (a, b, c),
            _ => return -1,
        };
        match engine::decode_foreground(data, bg_y, bg_u, bg_v, w, h) {
            Some((y, u, v)) => {
                dy.copy_from_slice(&y);
                du.copy_from_slice(&u);
                dv.copy_from_slice(&v);
                0
            }
            None => -2,
        }
    }
}

/// 全图 PSNR(无类别 mask)。
#[no_mangle]
pub extern "C" fn hive_psnr_full(a: *const u8, b: *const u8, w: usize, h: usize) -> f32 {
    unsafe {
        match (i16_slice(a, w * h), i16_slice(b, w * h)) {
            (Some(x), Some(y)) => motion::psnr_y(x, y, w, h, None, 0),
            _ => -1.0,
        }
    }
}
#[no_mangle]
pub extern "C" fn hive_psnr_multi(
    a: *const u8,
    b: *const u8,
    w: usize,
    h: usize,
    classes: *const u8,
    mask: *const u8,
    mask_len: usize,
) -> f32 {
    let nblk = (w / 8) * (h / 8);
    unsafe {
        match (
            i16_slice(a, w * h),
            i16_slice(b, w * h),
            u8_slice(classes, nblk),
            u8_slice(mask, mask_len),
        ) {
            (Some(x), Some(y), Some(c), Some(m)) => {
                motion::psnr_y_multi(x, y, w, h, c, m)
            }
            _ => -1.0,
        }
    }
}
