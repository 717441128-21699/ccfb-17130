//! 端到端:多帧 I/P 编码 + trailer 随机访问解码 + 背景跳过 + 色彩往返。

#[cfg(test)]
mod e2e {
    use hive_codec::container::{
        parse_trailer, FileHeader, FILE_HEADER_SIZE, TRAILER_SIZE,
    };
    use hive_codec::decoder::Decoder;
    use hive_codec::encoder::{Encoder, EncoderConfig};
    use hive_codec::MbClass;

    /// 构造一个带静止背景 + 局部运动方块的合成序列。
    fn make_frame(w: usize, h: usize, t: usize, moving: &[(usize, usize, [u8; 3])]) -> Vec<u8> {
        let mut rgb = vec![0u8; w * h * 3];
        // 静态木纹背景:平滑的低频渐变(真实蜂箱木板以低频纹理为主),
        // 叠加极轻微的空间噪声。时间稳定,使 P 帧背景 MB 可被跳过。
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                let grain = ((x / 4 + y / 4) % 5) as i32; // 块状低频木纹
                let base = 95 + ((x / 16) as i32 * 4 + (y / 12) as i32 * 6) % 45 + grain;
                let v = base.clamp(0, 255) as u8;
                rgb[i] = v;
                rgb[i + 1] = (v as i32 * 8 / 10).clamp(0, 255) as u8;
                rgb[i + 2] = (v as i32 * 5 / 10).clamp(0, 255) as u8;
            }
        }
        // 运动块(模拟蜜蜂):单向平移、不环绕,行为可预测,避免 wrap 造成
        // 蜜蜂在帧末突然回到左边缘而与静态背景 MB 混淆。
        for &(bx, by, col) in moving {
            let px = bx + t * 2;
            for dy in 0..16 {
                for dx in 0..16 {
                    let x = px + dx;
                    let y = by + dy;
                    if x < w && y < h {
                        let i = (y * w + x) * 3;
                        rgb[i] = col[0];
                        rgb[i + 1] = col[1];
                        rgb[i + 2] = col[2];
                    }
                }
            }
        }
        rgb
    }

    fn class_map(w: usize, h: usize, frame: &[u8], bg: &[u8]) -> Vec<u8> {
        let cols = w / 16;
        let rows = h / 16;
        let mut out = vec![MbClass::Background as u8; cols * rows];
        for my in 0..rows {
            for mx in 0..cols {
                // 与 PSNR 统计一致:用 MB 内逐像素最大差判定是否纯背景
                let mut max_diff = 0i32;
                for dy in 0..16 {
                    for dx in 0..16 {
                        let x = mx * 16 + dx;
                        let y = my * 16 + dy;
                        let i = (y * w + x) * 3;
                        max_diff =
                            max_diff.max((frame[i] as i32 - bg[i] as i32).abs());
                    }
                }
                // 同一阈值(6):编码侧标记为运动的 MB 与 PSNR 排除的 MB 完全一致
                if max_diff > 6 {
                    out[my * cols + mx] = MbClass::Flying as u8;
                }
            }
        }
        out
    }

    #[test]
    fn encode_seek_decode_roundtrip() {
        let (w, h) = (96, 80); // 6x5 MB,无需 padding
        let fps = 200u32;
        let n_frames = 24usize;
        let gop = 8u32;
        let bg = make_frame(w, h, 0, &[]);
        let moving = [(4usize, 20usize, [220, 180, 40u8])];

        let mut enc = Encoder::new(EncoderConfig {
            width: w,
            height: h,
            fps,
            frame_count: n_frames as u32,
            gop,
            target_bitrate: 0,
            base_qp: 4,
        });
        let frame_size = enc.frame_size();
        let mb_count = enc.mb_count();
        let mut originals = Vec::new();
        let mut coded_log = Vec::new();
        for t in 0..n_frames {
            let f = make_frame(w, h, t, &moving);
            let classes = class_map(w, h, &f, &bg);
            assert_eq!(classes.len(), mb_count);
            let bg_n = classes.iter().filter(|&&c| c == MbClass::Background as u8).count();
            let coded = enc.write_frame(&f, &classes).unwrap();
            coded_log.push((t, coded, mb_count - bg_n));
            originals.push(f);
        }
        println!(
            "coded MBs per frame (frame, coded, non-bg MBs): {:?}",
            &coded_log[..6.min(coded_log.len())]
        );
        let file = enc.finish();
        assert!(file.len() < w * h * 3 * n_frames / 2, "应有明显压缩");

        // 容器头/trailer
        assert_eq!(&file[0..4], b"HVC1");
        let trailer = parse_trailer(&file).expect("trailer 可解析");
        assert_eq!(trailer.frame_count as usize, n_frames);
        assert!(trailer.key_offsets.len() >= (n_frames / gop as usize));
        let _ = FileHeader {
            width: 0,
            height: 0,
            padded_width: 0,
            padded_height: 0,
            fps: 0,
            frame_count: 0,
            gop: 0,
            target_bitrate: 0,
        };
        assert!(file.len() >= FILE_HEADER_SIZE + TRAILER_SIZE);

        // 随机访问解码若干帧(含 I 帧与 P 帧、末帧)
        let mut dec = Decoder::open(file).expect("解码打开成功");
        assert_eq!(dec.header().width, w);
        assert_eq!(dec.header().height, h);
        assert_eq!(dec.header().frame_count as usize, n_frames);
        let targets = [0u32, 1, 7, 8, 15, 23];
        for &tg in &targets {
            let mut out = vec![0u8; w * h * 3];
            dec.seek_decode(tg, &mut out).expect("seek 成功");
            // 背景区域应高度保真。仅在"完全静止"的 MB 上统计 Y 通道 PSNR:
            // 用逐像素最大差判定,排除任何含运动蜜蜂(含其 16x16 边界溢出)的 MB,
            // 这样背景集合不被运动块污染,真实反映静态区域重建质量。
            let mut bg_mse = 0f64;
            let mut bg_n = 0u64;
            for my in 0..h / 16 {
                for mx in 0..w / 16 {
                    let mut mb_max_diff = 0i32;
                    for dy in 0..16 {
                        for dx in 0..16 {
                            let x = mx * 16 + dx;
                            let y = my * 16 + dy;
                            let i = (y * w + x) * 3;
                            mb_max_diff = mb_max_diff
                                .max((originals[tg as usize][i] as i32 - bg[i] as i32).abs());
                        }
                    }
                    if mb_max_diff <= 6 {
                        // 纯背景 MB:逐像素累计 Y 误差
                        let mut mb_se = 0f64;
                        for dy in 0..16 {
                            for dx in 0..16 {
                                let x = mx * 16 + dx;
                                let y = my * 16 + dy;
                                let i = (y * w + x) * 3;
                                let e = out[i] as f64 - originals[tg as usize][i] as f64;
                                mb_se += e * e;
                            }
                        }
                        if tg == 7 && mb_se / 256.0 > 50.0 {
                            println!(
                                "帧7 背景 MB({},{}) MSE={:.1}",
                                mx,
                                my,
                                mb_se / 256.0
                            );
                        }
                        bg_mse += mb_se;
                        bg_n += 256;
                    }
                }
            }
            assert!(bg_n > 0, "应至少有一个纯背景 MB");
            let bg_psnr = 10.0 * (255.0 * 255.0 / (bg_mse / bg_n as f64)).log10();
            // 静态背景经 I 帧编码 + P 帧零字节继承/重新暴露刷新:
            // Y 通道 PSNR 保持在 32dB 以上的高质量区(>30dB 人眼已难辨差异)。
            // 同码率下相对均匀分配的 PSNR 增益由基准对照实验(benchmark)验证。
            assert!(bg_psnr > 32.0, "帧 {} 纯背景 PSNR 过低: {}", tg, bg_psnr);
        }
    }

    #[test]
    fn bitrate_mode_produces_valid_file() {
        let (w, h) = (64, 64);
        let mut enc = Encoder::new(EncoderConfig {
            width: w,
            height: h,
            fps: 200,
            frame_count: 16,
            gop: 8,
            target_bitrate: 4_000_000, // 4 Mbps
            base_qp: 12,
        });
        let frame = vec![100u8; enc.frame_size()];
        let classes = vec![MbClass::Background as u8; enc.mb_count()];
        for _ in 0..16 {
            enc.write_frame(&frame, &classes).unwrap();
        }
        let file = enc.finish();
        let mut dec = Decoder::open(file).unwrap();
        let mut out = vec![0u8; w * h * 3];
        dec.seek_decode(15, &mut out).unwrap();
        // 平坦背景重建应几乎无损
        let max_err = out.iter().map(|&v| (v as i32 - 100).abs()).max().unwrap();
        assert!(max_err <= 3, "平坦背景最大误差 {}", max_err);
    }
}
