use hive_codec::bench::{flicker_check, parse_spec, BenchSpec};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut spec = BenchSpec::default();
    let mut mode = "compare".to_string();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--small" => {
                spec.width = 960;
                spec.height = 540;
                spec.compare_frames = 1;
                spec.warmup = 8;
            }
            "--tiny" => {
                spec.width = 320;
                spec.height = 180;
                spec.compare_frames = 1;
                spec.warmup = 4;
            }
            "--one" => spec.all_presets = false,
            "--mode" => {
                i += 1;
                mode = args.get(i).cloned().unwrap_or_else(|| "compare".into());
            }
            "--width" | "-w" => {
                i += 1;
                spec.width = args.get(i).and_then(|v| v.parse().ok()).unwrap_or(1920);
            }
            "--height" | "-h" => {
                i += 1;
                spec.height = args.get(i).and_then(|v| v.parse().ok()).unwrap_or(1080);
            }
            "--frames" => {
                i += 1;
                spec.compare_frames = args.get(i).and_then(|v| v.parse().ok()).unwrap_or(2);
            }
            "--warmup" => {
                i += 1;
                spec.warmup = args.get(i).and_then(|v| v.parse().ok()).unwrap_or(12);
            }
            "--q" => {
                i += 1;
                spec.q_uniform = args.get(i).and_then(|v| v.parse().ok()).unwrap_or(30);
            }
            other if other.starts_with("spec=") => {
                spec = parse_spec(other.trim_start_matches("spec="));
            }
            _ => {}
        }
        i += 1;
    }

    match mode.as_str() {
        "throughput" | "speed" => {
            use hive_codec::bench::throughput_work;
            use hive_codec::codec::{decode_intra, encode_intra};
            use hive_codec::synth::{SynthConfig, SyntheticSource};
            let n = if spec.compare_frames == 6 { 300 } else { spec.compare_frames };
            let t0 = std::time::Instant::now();
            let (bytes, cksum) = throughput_work(spec.width, spec.height, n, 60);
            let enc_ms = t0.elapsed().as_secs_f64() * 1000.0;

            // Seek/decode latency: one 1080p intra frame, many decodes.
            let cfg = SynthConfig { width: spec.width, height: spec.height, ..SynthConfig::default() };
            let mut src = SyntheticSource::new(cfg);
            let mut frame = src.next_frame();
            for _ in 0..10 { frame = src.next_frame(); }
            let enc = encode_intra(&frame.rgba, spec.width as usize, spec.height as usize, 30, None);
            let iters = 20;
            let t1 = std::time::Instant::now();
            let mut decoded_len = 0;
            for _ in 0..iters {
                let d = decode_intra(&enc.bits).unwrap();
                decoded_len = d.rgba.len();
                std::hint::black_box(&d.rgba);
            }
            let dec_ms = t1.elapsed().as_secs_f64() * 1000.0 / iters as f64;
            let total_frames = 200u64 * 60;
            let projected_s = enc_ms / n as f64 * total_frames as f64 / 1000.0;
            println!(
                "{{\"width\":{},\"height\":{},\"measured_frames\":{},\"encode_ms_total\":{:.1},\"encode_ms_per_frame\":{:.3},\"fps\":{:.1},\"bytes\":{},\"checksum\":{},\"keyframe_bytes\":{},\"seek_decode_ms\":{:.2},\"projected_60s_200fps_seconds\":{:.1},\"budget_180s_pass\":{}}}",
                spec.width, spec.height, n, enc_ms, enc_ms / n as f64,
                n as f64 / (enc_ms / 1000.0), bytes, cksum, enc.bits.len(),
                dec_ms, projected_s, projected_s <= 180.0
            );
            let _ = decoded_len;
        }
        "diag" => {
            print!("{}", hive_codec::bench::diag(spec.width, spec.height));
        }
        "gt" => {
            print!("{}", hive_codec::bench::gt_sweep(spec.width, spec.height, spec.q_uniform));
        }
        "res" => {
            print!("{}", hive_codec::bench::residual_sweep(spec.width, spec.height, spec.q_uniform));
        }
        "matrix" => {
            print!("{}", hive_codec::bench::matrix_sweep(spec.width, spec.height, spec.q_uniform, spec.compare_frames.max(3)));
        }
        "gtmatrix" => {
            print!("{}", hive_codec::bench::gt_matrix(spec.width, spec.height, spec.q_uniform, spec.compare_frames.max(4)));
        }
        "flicker" => {
            let (mad, block) = flicker_check(spec.width, spec.height, 12);
            println!("{{\"bg_temporal_mad\":{mad:.4},\"block_flicker\":{block:.4}}}");
        }
        _ => {
            let pms = hive_codec::bench::run_gt_matrix(&spec);
            print!("{}", hive_codec::bench::preset_metrics_to_json(&pms, &spec));
        }
    }
}
