//! Raw C ABI used by the TypeScript WASM loader. No wasm-bindgen dependency:
//! the host allocates input buffers with `hc_alloc`, copies data in, and reads
//! returned thread-local buffers through the `hc_*_ptr/_len` accessors.
//!
//! All calls are serialized inside one Worker instance, so a single set of
//! global output buffers is sufficient and avoids handle bookkeeping in TS.

use std::cell::RefCell;
use std::slice;

use crate::bench::{
    parse_spec, preset_metrics_to_json, run_gt_matrix, throughput_work,
};
use crate::codec::{decode_intra, encode_intra, match_roi_budget};
use crate::metrics::psnr_masked_y;

thread_local! {
    static JSON: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static UNIFORM_RGBA: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static ROI_RGBA: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static QMAP: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static BITS: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static DECODED: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static GRID: RefCell<(u32, u32)> = const { RefCell::new((0, 0)) };
    static DECODED_DIM: RefCell<(u32, u32)> = const { RefCell::new((0, 0)) };
}

#[no_mangle]
pub extern "C" fn hc_ping() -> u32 {
    0x48_43_31_30 // "HC10"-ish magic
}

#[no_mangle]
pub extern "C" fn hc_alloc(len: u32) -> *mut u8 {
    let mut buf = vec![0u8; len as usize];
    let p = buf.as_mut_ptr();
    std::mem::forget(buf);
    p
}

/// # Safety: `ptr` must come from `hc_alloc` with the same `len`.
#[no_mangle]
pub unsafe extern "C" fn hc_dealloc(ptr: *mut u8, len: u32) {
    if !ptr.is_null() && len > 0 {
        drop(Vec::from_raw_parts(ptr, len as usize, len as usize));
    }
}

macro_rules! ptr_len_accessors {
    ($ptr_name:ident, $len_name:ident, $cell:ident) => {
        #[no_mangle]
        pub extern "C" fn $ptr_name() -> *const u8 {
            $cell.with(|b| b.borrow().as_ptr())
        }
        #[no_mangle]
        pub extern "C" fn $len_name() -> u32 {
            $cell.with(|b| b.borrow().len() as u32)
        }
    };
}

ptr_len_accessors!(hc_json_ptr, hc_json_len, JSON);
ptr_len_accessors!(hc_uniform_rgba_ptr, hc_uniform_rgba_len, UNIFORM_RGBA);
ptr_len_accessors!(hc_roi_rgba_ptr, hc_roi_rgba_len, ROI_RGBA);
ptr_len_accessors!(hc_qmap_ptr, hc_qmap_len, QMAP);
ptr_len_accessors!(hc_bits_ptr, hc_bits_len, BITS);
ptr_len_accessors!(hc_decoded_ptr, hc_decoded_len, DECODED);

#[no_mangle]
pub extern "C" fn hc_grid_w() -> u32 {
    GRID.with(|g| g.borrow().0)
}
#[no_mangle]
pub extern "C" fn hc_grid_h() -> u32 {
    GRID.with(|g| g.borrow().1)
}
#[no_mangle]
pub extern "C" fn hc_decoded_w() -> u32 {
    DECODED_DIM.with(|d| d.borrow().0)
}
#[no_mangle]
pub extern "C" fn hc_decoded_h() -> u32 {
    DECODED_DIM.with(|d| d.borrow().1)
}

fn set_json(s: String) -> u32 {
    let bytes = s.into_bytes();
    let n = bytes.len() as u32;
    JSON.with(|j| *j.borrow_mut() = bytes);
    n
}

/// Run the full objective matrix. `spec` is a `key=value;...` string.
#[no_mangle]
pub extern "C" fn hc_benchmark(spec_ptr: *const u8, spec_len: u32) -> u32 {
    let spec_text = unsafe {
        if spec_ptr.is_null() || spec_len == 0 {
            String::new()
        } else {
            let sl = slice::from_raw_parts(spec_ptr, spec_len as usize);
            String::from_utf8_lossy(sl).into_owned()
        }
    };
    let spec = parse_spec(&spec_text);
    let pms = run_gt_matrix(&spec);
    set_json(preset_metrics_to_json(&pms, &spec))
}

/// Run `frames` high-flow 1080p-class encodes and report byte count. The host
/// times this call to obtain WASM throughput.
#[no_mangle]
pub extern "C" fn hc_throughput(spec_ptr: *const u8, spec_len: u32) -> u32 {
    let text = unsafe {
        if spec_ptr.is_null() {
            String::new()
        } else {
            String::from_utf8_lossy(slice::from_raw_parts(spec_ptr, spec_len as usize)).into_owned()
        }
    };
    let spec = parse_spec(&text);
    let (bytes, checksum) = throughput_work(spec.width, spec.height, spec.compare_frames.max(1), spec.q_uniform);
    set_json(format!(
        "{{\"frames\":{},\"width\":{},\"height\":{},\"bytes\":{},\"checksum\":{}}}",
        spec.compare_frames, spec.width, spec.height, bytes, checksum
    ))
}

/// Encode one RGBA frame both uniformly and with matched-budget ROI
/// allocation, decode both, and compute metrics if a mask is supplied.
///
/// `weights_ptr` points at `gridW*gridH` f32 values produced by the Worker.
/// `mask_ptr` may be null or point at `w*h` bytes.
#[no_mangle]
pub extern "C" fn hc_process_frame(
    rgba_ptr: *const u8,
    mask_ptr: *const u8,
    w: u32,
    h: u32,
    q_uniform: i32,
    weights_ptr: *const f32,
    n_weights: u32,
) -> u32 {
    let wu = w as usize;
    let hu = h as usize;
    let npx = wu * hu;
    let rgba = unsafe {
        if rgba_ptr.is_null() {
            return 1;
        }
        slice::from_raw_parts(rgba_ptr, npx * 4)
    };
    let weights = unsafe {
        if weights_ptr.is_null() || n_weights == 0 {
            None
        } else {
            Some(slice::from_raw_parts(weights_ptr, n_weights as usize))
        }
    };
    let mask = unsafe {
        if mask_ptr.is_null() {
            None
        } else {
            Some(slice::from_raw_parts(mask_ptr as *const u8, npx))
        }
    };

    let uniform = encode_intra(rgba, wu, hu, q_uniform, None);
    let dec_u = match decode_intra(&uniform.bits) {
        Some(d) => d,
        None => return 2,
    };

    let wvec: Vec<f32> = match weights {
        Some(ws) => ws.to_vec(),
        None => {
            let gw = wu.div_ceil(16);
            let gh = hu.div_ceil(16);
            vec![2.0; gw * gh]
        }
    };
    let (_q, roi) = match_roi_budget(rgba, wu, hu, &wvec, uniform.bits.len());
    let dec_r = match decode_intra(&roi.bits) {
        Some(d) => d,
        None => return 3,
    };

    let overall_u = psnr_masked_y(rgba, &dec_u.rgba, None, wu, hu).psnr_y;
    let overall_r = psnr_masked_y(rgba, &dec_r.rgba, None, wu, hu).psnr_y;
    let (bee_u, bee_r, bg_u, bg_r) = if let Some(m) = mask {
        let bu = psnr_masked_y(rgba, &dec_u.rgba, Some(m), wu, hu).psnr_y;
        let br = psnr_masked_y(rgba, &dec_r.rgba, Some(m), wu, hu).psnr_y;
        let inv: Vec<u8> = m.iter().map(|x| if *x == 0 { 255 } else { 0 }).collect();
        let gu = psnr_masked_y(rgba, &dec_u.rgba, Some(&inv), wu, hu).psnr_y;
        let gr = psnr_masked_y(rgba, &dec_r.rgba, Some(&inv), wu, hu).psnr_y;
        (bu, br, gu, gr)
    } else {
        (0.0, 0.0, 0.0, 0.0)
    };

    UNIFORM_RGBA.with(|b| *b.borrow_mut() = dec_u.rgba);
    ROI_RGBA.with(|b| *b.borrow_mut() = dec_r.rgba);
    QMAP.with(|b| *b.borrow_mut() = roi.qmap.clone());
    BITS.with(|b| *b.borrow_mut() = roi.bits.clone());
    GRID.with(|g| *g.borrow_mut() = (roi.gw as u32, roi.gh as u32));

    set_json(format!(
        "{{\"uniformBytes\":{},\"roiBytes\":{},\"byteRatio\":{:.4},\"qRoi\":{},\"gridW\":{},\"gridH\":{},\"overallUniformPsnr\":{:.3},\"overallRoiPsnr\":{:.3},\"beeUniformPsnr\":{:.3},\"beeRoiPsnr\":{:.3},\"deltaBeeDb\":{:.3},\"bgUniformPsnr\":{:.3},\"bgRoiPsnr\":{:.3}}}",
        uniform.bits.len(), roi.bits.len(),
        roi.bits.len() as f64 / uniform.bits.len().max(1) as f64,
        _q, roi.gw, roi.gh,
        overall_u, overall_r, bee_u, bee_r, bee_r - bee_u, bg_u, bg_r
    ));
    0
}

/// Decode an HCV1 intra frame and expose RGBA. Used by the seek-latency probe.
#[no_mangle]
pub extern "C" fn hc_decode_intra(data_ptr: *const u8, len: u32) -> u32 {
    let data = unsafe {
        if data_ptr.is_null() {
            return 1;
        } else {
            slice::from_raw_parts(data_ptr, len as usize)
        }
    };
    match decode_intra(data) {
        Some(d) => {
            let w = d.planes.w as u32;
            let h = d.planes.h as u32;
            DECODED_DIM.with(|dd| *dd.borrow_mut() = (w, h));
            DECODED.with(|b| *b.borrow_mut() = d.rgba);
            0
        }
        None => 2,
    }
}
