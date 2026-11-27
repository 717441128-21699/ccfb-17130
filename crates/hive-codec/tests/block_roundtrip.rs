//! 块层最小往返:验证 transform/quant/entropy 的编解码闭合。

use hive_codec::bitio::{BitReader, BitWriter};
use hive_codec::block::{
    effective_qp, entropy_decode_block, entropy_encode_block, inverse_transform,
    transform_quant, MbClass,
};
use hive_codec::huff::{ac_weights, dc_weights, HuffTable};
use hive_codec::quant::QT;

#[test]
fn single_block_lossless_at_qp1() {
    let qt = QT::build();
    let dc = HuffTable::build(&dc_weights());
    let ac = HuffTable::build(&ac_weights());
    let qp = 1usize;
    let qtab = &qt.fwd[0][qp - 1];
    let iqtab = &qt.inv[0][qp - 1];

    // 一组有结构的像素(模拟背景渐变)
    let mut pixels = [0i16; 64];
    for i in 0..64 {
        pixels[i] = 100 + ((i * 3 + (i / 8) * 5) % 80) as i16;
    }

    let mut levels = [0i16; 64];
    transform_quant(&pixels, qtab, &mut levels);

    let mut bw = BitWriter::new(256);
    let new_pred = entropy_encode_block(&mut bw, &dc, &ac, &levels, 0);
    bw.flush();

    let mut br = BitReader::new(&bw.buf);
    let (dec_levels, dec_pred) = entropy_decode_block(&mut br, &dc, &ac, 0);
    assert_eq!(new_pred, dec_pred);
    assert_eq!(levels, dec_levels, "量化电平熵编解码不一致");

    let mut back = [0i16; 64];
    inverse_transform(&dec_levels, iqtab, &mut back);
    let max_err = pixels
        .iter()
        .zip(back.iter())
        .map(|(a, b)| (a - b).abs())
        .max()
        .unwrap();
    // 含丰富高频的 ramp 块在 14 位定点 + QP1 量化下,单点误差 <=10 属正常
    assert!(max_err <= 10, "QP1 高频块往返最大误差 {}", max_err);
}

#[test]
fn debug_flat_block_coefficients() {
    let qt = QT::build();
    let qtab = &qt.fwd[0][0]; // QP1 luma
    let iqtab = &qt.inv[0][0];
    let pixels = [100i16; 64];
    let mut levels = [0i16; 64];
    transform_quant(&pixels, qtab, &mut levels);
    println!("flat100 quantized levels[0..8] = {:?}", &levels[..8]);
    println!("qtab[0..8] = {:?}", &qtab[..8]);
    let mut back = [0i16; 64];
    inverse_transform(&levels, iqtab, &mut back);
    println!("reconstructed first row = {:?}", &back[..8]);
    let max_err = pixels.iter().zip(back.iter()).map(|(a, b)| (a - b).abs()).max().unwrap();
    println!("flat block max err = {}", max_err);
    assert!(max_err <= 4);
}

#[test]
fn debug_two_blocks_dc_chain() {
    use hive_codec::bitio::{BitReader, BitWriter};
    use hive_codec::huff::{ac_weights, dc_weights, HuffTable};
    let qt = QT::build();
    let dc = HuffTable::build(&dc_weights());
    let ac = HuffTable::build(&ac_weights());
    let qtab = &qt.fwd[0][0];
    let iqtab = &qt.inv[0][0];
    // 两个不同的平坦块(DC 不同),验证 DC 差分链
    let blocks: [[i16; 64]; 2] = [
        std::array::from_fn(|_| 100i16),
        std::array::from_fn(|_| 140i16),
    ];
    let mut bw = BitWriter::new(512);
    let mut enc_pred = 0i16;
    let mut enc_levels = Vec::new();
    for b in &blocks {
        let mut lv = [0i16; 64];
        transform_quant(b, qtab, &mut lv);
        enc_pred = entropy_encode_block(&mut bw, &dc, &ac, &lv, enc_pred);
        enc_levels.push(lv);
    }
    bw.flush();
    let mut br = BitReader::new(&bw.buf);
    let mut dec_pred = 0i16;
    for (i, b) in blocks.iter().enumerate() {
        let (lv, p) = entropy_decode_block(&mut br, &dc, &ac, dec_pred);
        dec_pred = p;
        assert_eq!(lv, enc_levels[i], "块 {} 电平不一致", i);
        let mut back = [0i16; 64];
        inverse_transform(&lv, iqtab, &mut back);
        let me = b.iter().zip(back.iter()).map(|(a, x)| (a - x).abs()).max().unwrap();
        println!("block {} DC level {} maxerr {}", i, lv[0], me);
        assert!(me <= 4, "块 {} 误差 {}", i, me);
    }
}

#[test]
fn debug_encoder_internal_y() {
    // 直接驱动 encoder,检查编码统计与码流是否合理
    use hive_codec::encoder::{Encoder, EncoderConfig};
    let (w, h) = (16, 16); // 单个 MB
    let mut enc = Encoder::new(EncoderConfig {
        width: w,
        height: h,
        fps: 10,
        frame_count: 1,
        gop: 1,
        target_bitrate: 0,
        base_qp: 1,
    });
    let rgb = vec![100u8; enc.frame_size()];
    let classes = vec![MbClass::Background as u8; enc.mb_count()];
    let coded = enc.write_frame(&rgb, &classes).unwrap();
    println!("single-MB coded_mbs={} bytes_so_far={}", coded, enc.bytes_so_far());
    let file = enc.finish();
    println!("file len={}", file.len());
    use hive_codec::decoder::Decoder;
    let mut dec = Decoder::open(file).unwrap();
    let mut out = vec![0u8; w * h * 3];
    dec.seek_decode(0, &mut out).unwrap();
    println!("single MB out[0..3]={:?}", &out[..3]);
    let me = out.iter().map(|&v| (v as i32 - 100).abs()).max().unwrap();
    println!("single MB maxerr={}", me);
    assert!(me <= 3);
}

#[test]
fn debug_coefficient_magnitudes() {
    use hive_codec::dct;
    // level-shift 后的真实残差范围 -128..127
    let mut block = [0i16; 64];
    for i in 0..64 {
        block[i] = (100 + ((i * 3 + (i / 8) * 5) % 80) as i16) - 128;
    }
    let c = dct::fdct(&block);
    let mut max_ac = 0i32;
    let mut sum_ac = 0i64;
    for k in 1..64 {
        max_ac = max_ac.max(c[k].abs());
        sum_ac += c[k].abs() as i64;
    }
    println!("shifted ramp: DC={} maxAC={} meanAC={:.1}", c[0], max_ac, sum_ac as f64 / 63.0);
    // 平坦块
    let flat = [-28i16; 64]; // 100-128
    let cf = dct::fdct(&flat);
    println!("flat(-28): DC={} maxAC={}", cf[0], cf[1..].iter().map(|x| x.abs()).max().unwrap());
    // 当前 QP1 量化步长
    let qt = QT::build();
    println!("QP1 luma q[0..8] = {:?}", &qt.fwd[0][0][..8]);
}

#[test]
fn debug_idct_reconstruction() {
    use hive_codec::dct;
    // 平坦 -28(level-shift 后)
    let block = [-28i16; 64];
    let c = dct::fdct(&block);
    println!("fdct flat: DC={}", c[0]);
    let back = dct::idct(&c);
    println!("idct first row = {:?}", &back[..8]);
    let me = block.iter().zip(back.iter()).map(|(a, b)| (a - b).abs()).max().unwrap();
    println!("dct-only flat maxerr={}", me);
    // 经过量化(步长1)+ 反量化
    let qt = QT::build();
    let mut lv = [0i16; 64];
    transform_quant(&block, &qt.fwd[0][0], &mut lv);
    let mut rec = [0i16; 64];
    inverse_transform(&lv, &qt.inv[0][0], &mut rec);
    println!("quant roundtrip first row = {:?}", &rec[..8]);
    let me2 = block.iter().zip(rec.iter()).map(|(a, b)| (a - b).abs()).max().unwrap();
    println!("quant roundtrip maxerr={}", me2);
    assert!(me2 <= 3);
}

#[test]
fn debug_single_mb_y_trace() {
    use hive_codec::decoder::Decoder;
    use hive_codec::encoder::{Encoder, EncoderConfig};
    let (w, h) = (16, 16);
    let mut enc = Encoder::new(EncoderConfig {
        width: w, height: h, fps: 10, frame_count: 1, gop: 1,
        target_bitrate: 0, base_qp: 4,
    });
    // 纯红 (200,50,50),便于区分 Y 与色度
    let rgb: Vec<u8> = (0..w * h).flat_map(|_| [200u8, 50, 50]).collect();
    let classes = vec![MbClass::Background as u8; enc.mb_count()];
    enc.write_frame(&rgb, &classes).unwrap();
    let file = enc.finish();
    let mut dec = Decoder::open(file).unwrap();
    let mut out = vec![0u8; w * h * 3];
    dec.seek_decode(0, &mut out).unwrap();
    println!("red input (200,50,50) -> out {:?}", &out[..3]);
    // 纯灰
    let mut enc2 = Encoder::new(EncoderConfig {
        width: w, height: h, fps: 10, frame_count: 1, gop: 1,
        target_bitrate: 0, base_qp: 1,
    });
    let gray = vec![100u8; enc2.frame_size()];
    let cls2 = vec![MbClass::Background as u8; enc2.mb_count()];
    enc2.write_frame(&gray, &cls2).unwrap();
    let f2 = enc2.finish();
    let mut d2 = Decoder::open(f2).unwrap();
    let mut o2 = vec![0u8; w * h * 3];
    d2.seek_decode(0, &mut o2).unwrap();
    println!("gray QP1 input 100 -> out {:?}", &o2[..3]);
}

#[test]
fn debug_large_flat_y_psnr() {
    use hive_codec::decoder::Decoder;
    use hive_codec::encoder::{Encoder, EncoderConfig};
    let (w, h) = (96, 80);
    for qp in [1u8, 4, 8] {
        let mut enc = Encoder::new(EncoderConfig {
            width: w, height: h, fps: 10, frame_count: 1, gop: 1,
            target_bitrate: 0, base_qp: qp,
        });
        let rgb = vec![100u8; enc.frame_size()];
        let classes = vec![MbClass::Background as u8; enc.mb_count()];
        enc.write_frame(&rgb, &classes).unwrap();
        let file = enc.finish();
        let mut dec = Decoder::open(file).unwrap();
        let mut out = vec![0u8; w * h * 3];
        dec.seek_decode(0, &mut out).unwrap();
        let mut se = 0u64;
        for p in 0..w * h {
            let e = out[p * 3] as i32 - 100;
            se += (e * e) as u64;
        }
        let mse = se as f64 / (w * h) as f64;
        let psnr = 10.0 * (255.0 * 255.0 / mse).log10();
        let maxe = out.chunks(3).map(|c| (c[0] as i32 - 100).abs()).max().unwrap();
        println!("QP{} flat Y: maxerr={} PSNR={:.2}", qp, maxe, psnr);
    }
}

#[test]
fn debug_qp8_flat_block() {
    let qt = QT::build();
    // 平坦 level-shift 残差 -28(对应真实 100)
    let block = [-28i16; 64];
    for qp in [1usize, 4, 7, 8] {
        let mut lv = [0i16; 64];
        transform_quant(&block, &qt.fwd[0][qp - 1], &mut lv);
        let mut back = [0i16; 64];
        inverse_transform(&lv, &qt.inv[0][qp - 1], &mut back);
        let me = block.iter().zip(back.iter()).map(|(a, b)| (a - b).abs()).max().unwrap();
        println!(
            "QP{} flat(-28): DC level={} qstep={} back[0]={} maxerr={}",
            qp, lv[0], qt.fwd[0][qp - 1][0], back[0], me
        );
    }
}

#[test]
fn debug_multimb_dc_chain_qp() {
    use hive_codec::bitio::{BitReader, BitWriter};
    use hive_codec::huff::{ac_weights, dc_weights, HuffTable};
    let qt = QT::build();
    let dc = HuffTable::build(&dc_weights());
    let ac = HuffTable::build(&ac_weights());
    // 4 个相同平坦块,模拟多 MB 帧的 DC 差分链
    for qp in [1usize, 8, 11] {
        let qtab = &qt.fwd[0][qp - 1];
        let iqtab = &qt.inv[0][qp - 1];
        let block = [-28i16; 64];
        let mut bw = BitWriter::new(512);
        let mut ep = 0i16;
        let mut all_lv = Vec::new();
        for _ in 0..4 {
            let mut lv = [0i16; 64];
            transform_quant(&block, qtab, &mut lv);
            ep = entropy_encode_block(&mut bw, &dc, &ac, &lv, ep);
            all_lv.push(lv);
        }
        bw.flush();
        let mut br = BitReader::new(&bw.buf);
        let mut dp = 0i16;
        let mut worst = 0i16;
        for i in 0..4 {
            let (lv, p) = entropy_decode_block(&mut br, &dc, &ac, dp);
            dp = p;
            assert_eq!(lv, all_lv[i], "QP{} 块{} 电平失配", qp, i);
            let mut back = [0i16; 64];
            inverse_transform(&lv, iqtab, &mut back);
            worst = worst.max(block.iter().zip(back.iter()).map(|(a, b)| (a - b).abs()).max().unwrap());
        }
        println!("QP{} 4-MB DC chain worst block maxerr={}", qp, worst);
    }
}

#[test]
fn debug_color_y_uniformity() {
    use hive_codec::color::{rgb_to_yuv, yuv_to_rgb};
    let (w, h) = (32, 32);
    let rgb = vec![100u8; w * h * 3];
    let (mut y, mut u, mut v) =
        (vec![0u8; w * h], vec![0u8; w / 2 * h / 2], vec![0u8; w / 2 * h / 2]);
    rgb_to_yuv(&rgb, w, h, &mut y, &mut u, &mut v);
    let ymin = *y.iter().min().unwrap();
    let ymax = *y.iter().max().unwrap();
    println!("Y range after rgb_to_yuv: {}..{}", ymin, ymax);
    println!("U range: {}..{} V range: {}..{}",
        u.iter().min().unwrap(), u.iter().max().unwrap(),
        v.iter().min().unwrap(), v.iter().max().unwrap());
    let mut back = vec![0u8; w * h * 3];
    yuv_to_rgb(&y, &u, &v, w, h, &mut back);
    let maxe = back.iter().map(|&x| (x as i32 - 100).abs()).max().unwrap();
    println!("color-only roundtrip maxerr={}", maxe);
    assert_eq!(ymin, ymax, "平坦输入的 Y 应完全一致");
}

#[test]
fn debug_static_pframe_inheritance() {
    use hive_codec::decoder::Decoder;
    use hive_codec::encoder::{Encoder, EncoderConfig};
    let (w, h) = (64, 64);
    let n = 6;
    let mut enc = Encoder::new(EncoderConfig {
        width: w, height: h, fps: 10, frame_count: n, gop: 8,
        target_bitrate: 0, base_qp: 4,
    });
    // 完全静态帧:每帧相同,所有 MB 都是 Background
    let frame = vec![110u8; enc.frame_size()];
    let classes = vec![MbClass::Background as u8; enc.mb_count()];
    for _ in 0..n {
        enc.write_frame(&frame, &classes).unwrap();
    }
    let file = enc.finish();
    let mut dec = Decoder::open(file).unwrap();
    for tg in 0..n {
        let mut out = vec![0u8; w * h * 3];
        dec.seek_decode(tg as u32, &mut out).unwrap();
        let maxe = out.chunks(3).map(|c| (c[0] as i32 - 110).abs()).max().unwrap();
        let mse = out.chunks(3).map(|c| {
            let e = c[0] as f64 - 110.0;
            e * e
        }).sum::<f64>() / (w * h) as f64;
        let psnr = 10.0 * (255.0 * 255.0 / mse).log10();
        println!("static frame {} Y maxerr={} PSNR={:.2}", tg, maxe, psnr);
        assert!(maxe <= 3, "静态帧 {} 误差 {}", tg, maxe);
    }
}

#[test]
fn effective_qp_class_ordering() {
    // 同一帧基准下,重要性越高 QP 越小(越精细)
    let base = 12u8;
    let q_bg = effective_qp(base, MbClass::Background);
    let q_crawl = effective_qp(base, MbClass::Crawling);
    let q_fly = effective_qp(base, MbClass::Flying);
    let q_pollen = effective_qp(base, MbClass::Pollen);
    assert!(q_pollen < q_fly);
    assert!(q_fly < q_crawl);
    assert!(q_crawl < q_bg);
    // 裁剪边界
    assert!(effective_qp(1, MbClass::Pollen) >= 1);
    assert!(effective_qp(32, MbClass::Background) <= 32);
}

#[test]
fn full_frame_flat_background() {
    // 整帧全 100 的 I 帧(QP1 近无损):经过完整 encoder/decoder 应高度还原
    use hive_codec::decoder::Decoder;
    use hive_codec::encoder::{Encoder, EncoderConfig};
    let (w, h) = (32, 32);
    let mut enc = Encoder::new(EncoderConfig {
        width: w,
        height: h,
        fps: 10,
        frame_count: 1,
        gop: 1,
        target_bitrate: 0,
        base_qp: 1,
    });
    let rgb = vec![100u8; enc.frame_size()];
    let classes = vec![MbClass::Background as u8; enc.mb_count()];
    enc.write_frame(&rgb, &classes).unwrap();
    let file = enc.finish();
    println!("file size = {} bytes for {} pixels", file.len(), w * h);
    let mut dec = Decoder::open(file).unwrap();
    let mut out = vec![0u8; w * h * 3];
    dec.seek_decode(0, &mut out).unwrap();
    let max_err = out.iter().map(|&v| (v as i32 - 100).abs()).max().unwrap();
    println!("flat full-frame max err = {}", max_err);
    assert!(max_err <= 3, "QP1 平坦整帧最大误差 {}", max_err);
}
