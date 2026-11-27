//! BT.601 颜色空间转换:RGBA <-> YUV420 (平面格式),定点整数实现(避免逐像素浮点)。

#[inline]
fn clamp255(v: i32) -> i16 {
    v.clamp(0, 255) as i16
}

/// 整帧 RGBA -> 平面 Y / U / V (4:2:0,色度为 2x2 平均),定点整数。
pub fn rgba_to_yuv420(
    rgba: &[u8],
    w: usize,
    h: usize,
    y: &mut [i16],
    u: &mut [i16],
    v: &mut [i16],
) {
    // 亮度(系数放大 65536 倍,结果右移 16):Y = 0.299R + 0.587G + 0.114B。
    // 系数为正且和为 1,输入 0..255 时 Y 必落在 0..255,无需逐像素 clamp。
    for row in 0..h {
        let src_off = row * w * 4;
        for col in 0..w {
            let p = src_off + col * 4;
            let r = rgba[p] as i32;
            let g = rgba[p + 1] as i32;
            let b = rgba[p + 2] as i32;
            y[row * w + col] = ((19595 * r + 38470 * g + 7471 * b + 32768) >> 16) as i16;
        }
    }
    let cw = w / 2;
    let ch = h / 2;
    for cy in 0..ch {
        for cx in 0..cw {
            let mut su = 0i32;
            let mut sv = 0i32;
            for dy in 0..2usize {
                for dx in 0..2usize {
                    let p = ((cy * 2 + dy) * w + (cx * 2 + dx)) * 4;
                    let r = rgba[p] as i32;
                    let g = rgba[p + 1] as i32;
                    let b = rgba[p + 2] as i32;
                    su += -11059 * r - 21709 * g + 32768 * b + 128 * 65536;
                    sv += 32768 * r - 27439 * g - 5329 * b + 128 * 65536;
                }
            }
            u[cy * cw + cx] = clamp255((su / 4 + 32768) >> 16);
            v[cy * cw + cx] = clamp255((sv / 4 + 32768) >> 16);
        }
    }
}

/// 平面 YUV420 -> RGBA,定点整数。
pub fn yuv420_to_rgba(
    y: &[i16],
    u: &[i16],
    v: &[i16],
    w: usize,
    h: usize,
    rgba: &mut [u8],
) {
    let cw = w / 2;
    for row in 0..h {
        for col in 0..w {
            let yv = y[row * w + col] as i32;
            let du = u[(row / 2) * cw + (col / 2)] as i32 - 128;
            let dv = v[(row / 2) * cw + (col / 2)] as i32 - 128;
            // 逆变换系数放大 65536 倍
            let r = yv + ((91881 * dv) >> 16);
            let g = yv - ((22554 * du + 46802 * dv) >> 16);
            let b = yv + ((116130 * du) >> 16);
            let p = (row * w + col) * 4;
            rgba[p] = r.clamp(0, 255) as u8;
            rgba[p + 1] = g.clamp(0, 255) as u8;
            rgba[p + 2] = b.clamp(0, 255) as u8;
            rgba[p + 3] = 255;
        }
    }
}
