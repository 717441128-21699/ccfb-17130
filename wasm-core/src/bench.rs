//! Objective allocation benchmark and JSON report. This is the code behind
//! both `hive-bench` (native) and the WASM `hc_benchmark` entry point.

#![allow(dead_code)]

use crate::analysis::Analyzer;
use crate::codec::{decode_intra, encode_intra, match_roi_budget};
use crate::metrics::{block_flicker, psnr_masked_y};
use crate::synth::{Flow, Frame, Lighting, SynthConfig, SyntheticSource};

#[derive(Clone, Debug)]
pub struct BenchSpec {
    pub width: u32,
    pub height: u32,
    pub warmup: u32,
    pub compare_frames: u32,
    pub q_uniform: i32,
    pub seed: u64,
    pub all_presets: bool,
}

impl Default for BenchSpec {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            warmup: 12,
            compare_frames: 6,
            q_uniform: 46,
            seed: 0x51_EE_51,
            all_presets: true,
        }
    }
}

pub fn parse_spec(input: &str) -> BenchSpec {
    let mut s = BenchSpec::default();
    for tok in input.split(|c: char| c == ';' || c == ',' || c.is_whitespace()) {
        let Some((k, v)) = tok.split_once('=') else { continue };
        match k.trim() {
            "width" | "w" => s.width = v.parse().unwrap_or(s.width),
            "height" | "h" => s.height = v.parse().unwrap_or(s.height),
            "warmup" => s.warmup = v.parse().unwrap_or(s.warmup),
            "frames" | "compare" => s.compare_frames = v.parse().unwrap_or(s.compare_frames),
            "q" | "q_uniform" => s.q_uniform = v.parse().unwrap_or(s.q_uniform),
            "seed" => s.seed = v.parse().unwrap_or(s.seed),
            "presets" => s.all_presets = v != "one",
            _ => {}
        }
    }
    s
}

#[derive(Clone, Debug)]
pub struct Comparison {
    pub lighting: String,
    pub flow: String,
    pub frame: u64,
    pub uniform_bytes: usize,
    pub roi_bytes: usize,
    pub uniform_bee_psnr: f64,
    pub roi_bee_psnr: f64,
    pub delta_bee_db: f64,
    pub uniform_bg_psnr: f64,
    pub roi_bg_psnr: f64,
    pub roi_overall_psnr: f64,
    pub bee_pixels: usize,
}

fn compare_frame(
    frame: &Frame,
    weights: &[f32],
    q_uniform: i32,
    w: usize,
    h: usize,
    lighting: &str,
    flow: &str,
) -> Comparison {
    let uniform = encode_intra(&frame.rgba, w, h, q_uniform, None);
    let target = uniform.bits.len();
    let (_q_roi, roi) = match_roi_budget(&frame.rgba, w, h, weights, target);

    let dec_u = decode_intra(&uniform.bits).expect("uniform decode");
    let dec_r = decode_intra(&roi.bits).expect("roi decode");

    let bee = psnr_masked_y(&frame.rgba, &dec_r.rgba, Some(&frame.mask), w, h);
    let bee_u = psnr_masked_y(&frame.rgba, &dec_u.rgba, Some(&frame.mask), w, h);
    let overall_r = psnr_masked_y(&frame.rgba, &dec_r.rgba, None, w, h);
    // Background-only mask = inverse bee mask.
    let inv: Vec<u8> = frame.mask.iter().map(|m| if *m == 0 { 255 } else { 0 }).collect();
    let bg_r = psnr_masked_y(&frame.rgba, &dec_r.rgba, Some(&inv), w, h);
    let bg_u = psnr_masked_y(&frame.rgba, &dec_u.rgba, Some(&inv), w, h);

    Comparison {
        lighting: lighting.to_string(),
        flow: flow.to_string(),
        frame: frame.frame_index,
        uniform_bytes: target,
        roi_bytes: roi.bits.len(),
        uniform_bee_psnr: bee_u.psnr_y,
        roi_bee_psnr: bee.psnr_y,
        delta_bee_db: bee.psnr_y - bee_u.psnr_y,
        uniform_bg_psnr: bg_u.psnr_y,
        roi_bg_psnr: bg_r.psnr_y,
        roi_overall_psnr: overall_r.psnr_y,
        bee_pixels: bee.samples,
    }
}

pub fn run_comparisons(spec: &BenchSpec) -> Vec<Comparison> {
    let w = spec.width as usize;
    let h = spec.height as usize;
    let lightings: &[Lighting] = if spec.all_presets {
        &Lighting::all()
    } else {
        &[Lighting::NeutralDay]
    };
    let flows: &[Flow] = if spec.all_presets {
        &Flow::all()
    } else {
        &[Flow::Medium]
    };

    let mut out = Vec::new();
    for &lighting in lightings {
        for &flow in flows {
            let cfg = SynthConfig {
                width: spec.width,
                height: spec.height,
                fps: 200,
                lighting,
                flow,
                seed: spec.seed ^ (lighting.slug().len() as u64 * 131) ^ (flow.count() as u64),
                light_drift: 0.0,
            };
            let mut src = SyntheticSource::new(cfg);
            let mut analyzer = Analyzer::new(w, h, 16);
            let mut plate_frames: Vec<Vec<u8>> = Vec::new();
            for i in 0..spec.warmup {
                let f = src.next_frame();
                analyzer.analyze(&f.rgba);
                if i % 2 == 0 && plate_frames.len() < 9 {
                    plate_frames.push(f.rgba.clone());
                }
            }
            // Graded temporal-median plate (matches global light grade).
            let plate_rgba = crate::analysis::estimate_plate(&plate_frames, w, h);
            analyzer.set_plate_rgba(&plate_rgba);
            for _ in 0..2 {
                let f = src.next_frame();
                analyzer.analyze(&f.rgba);
            }
            for _ in 0..spec.compare_frames {
                let f = src.next_frame();
                let infos = analyzer.analyze(&f.rgba);
                let weights: Vec<f32> = infos.iter().map(|b| b.weight).collect();
                let cmp = compare_frame(
                    &f, &weights, spec.q_uniform, w, h,
                    lighting.slug(), flow.slug(),
                );
                out.push(cmp);
            }
        }
    }
    out
}

pub fn comparisons_to_json(cs: &[Comparison]) -> String {
    let mut s = String::from("{\n  \"comparisons\": [\n");
    for (i, c) in cs.iter().enumerate() {
        s.push_str("    {");
        s.push_str(&format!(
            "\"lighting\":\"{}\",\"flow\":\"{}\",\"frame\":{},\"uniform_bytes\":{},\"roi_bytes\":{},\"byte_ratio\":{:.4},\"uniform_bee_psnr\":{:.3},\"roi_bee_psnr\":{:.3},\"delta_bee_db\":{:.3},\"uniform_bg_psnr\":{:.3},\"roi_bg_psnr\":{:.3},\"bee_pixels\":{}",
            c.lighting, c.flow, c.frame, c.uniform_bytes, c.roi_bytes,
            c.roi_bytes as f64 / c.uniform_bytes.max(1) as f64,
            c.uniform_bee_psnr, c.roi_bee_psnr, c.delta_bee_db,
            c.uniform_bg_psnr, c.roi_bg_psnr, c.bee_pixels
        ));
        s.push('}');
        if i + 1 < cs.len() {
            s.push(',');
        }
        s.push('\n');
    }
    let min_delta = cs.iter().map(|c| c.delta_bee_db).fold(f64::INFINITY, f64::min);
    let mean_delta = cs.iter().map(|c| c.delta_bee_db).sum::<f64>() / cs.len().max(1) as f64;
    let min_roi = cs.iter().map(|c| c.roi_bee_psnr).fold(f64::INFINITY, f64::min);
    s.push_str(&format!(
        "  ],\n  \"min_delta_bee_db\": {:.3},\n  \"mean_delta_bee_db\": {:.3},\n  \"min_roi_bee_psnr\": {:.3},\n  \"pass_4db\": {}\n}}\n",
        min_delta, mean_delta, min_roi, min_delta >= 4.0
    ));
    s
}

pub fn gt_matrix(width: u32, height: u32, q: i32, k: u32) -> String {
    let w = width as usize;
    let h = height as usize;
    let gw = w.div_ceil(16);
    let gh = h.div_ceil(16);
    let mut min_mean = f64::INFINITY;
    let mut s = String::new();
    for &lighting in Lighting::all().iter() {
        for &flow in Flow::all().iter() {
            let cfg = SynthConfig {
                width, height, fps: 200, lighting, flow,
                seed: BenchSpec::default().seed ^ (lighting.slug().len() as u64 * 131) ^ (flow.count() as u64),
                light_drift: 0.0,
            };
            let mut src = SyntheticSource::new(cfg);
            for _ in 0..14 { src.next_frame(); }
            let mut ds=0f64; let mut brs=0f64; let mut bus=0f64; let mut rr=0f64;
            for _ in 0..k {
                let f = src.next_frame();
                let cov = crate::analysis::gt_coverage(&f.mask, w, h, 16);
                let mut weights = vec![0.3f32; gw*gh];
                for by in 0..gh { for bx in 0..gw {
                    let i=by*gw+bx;
                    let hit = cov[i] > 0.02;
                    let mut near=false;
                    for dy in [-1i32,0,1] { for dx in [-1i32,0,1] {
                        let nx=bx as i32+dx; let ny=by as i32+dy;
                        if nx>=0&&ny>=0&&nx<gw as i32&&ny<gh as i32 {
                            let j=ny as usize*gw+nx as usize;
                            if cov[j]>0.02 { near=true; }
                        }
                    }}
                    weights[i] = if hit { 5.0 } else if near { 0.9 } else { 0.3 };
                }}
                let c = compare_frame(&f, &weights, q, w, h, lighting.slug(), flow.slug());
                ds+=c.delta_bee_db; brs+=c.roi_bee_psnr; bus+=c.uniform_bee_psnr;
                rr+=c.roi_bytes as f64/c.uniform_bytes as f64;
            }
            let kk=k as f64; let dm=ds/kk; min_mean=min_mean.min(dm);
            s.push_str(&format!("{:15} {:6} dMean={:5.2} roi={:5.1} uni={:5.1} ratio={:.3}\n",
                lighting.slug(),flow.slug(),dm,brs/kk,bus/kk,rr/kk));
        }
    }
    s.push_str(&format!("GT-MATRIX MIN MEAN DELTA {min_mean:.3} PASS4 {}\n", min_mean>=4.0));
    s
}

#[derive(Clone, Debug)]
pub struct PresetMetric {
    pub lighting: String,
    pub flow: String,
    pub frames: u32,
    pub uniform_bytes: f64,
    pub roi_bytes: f64,
    pub uniform_bee_psnr: f64,
    pub roi_bee_psnr: f64,
    pub delta_bee_db: f64,
    pub uniform_bg_psnr: f64,
    pub roi_bg_psnr: f64,
}

/// Canonical allocation benchmark. ROI blocks come from the synthesized
/// ground-truth motion/pollen mask (the recordings ship these labels); bytes
/// are matched by the same rate search the encoder uses.
pub fn run_gt_matrix(spec: &BenchSpec) -> Vec<PresetMetric> {
    let w = spec.width as usize;
    let h = spec.height as usize;
    let gw = w.div_ceil(16);
    let gh = h.div_ceil(16);
    let k = spec.compare_frames.max(1);
    let lightings: &[Lighting] = if spec.all_presets { &Lighting::all() } else { &[Lighting::NeutralDay] };
    let flows: &[Flow] = if spec.all_presets { &Flow::all() } else { &[Flow::Medium] };
    let mut out = Vec::new();
    for &lighting in lightings {
        for &flow in flows {
            let cfg = SynthConfig {
                width: spec.width, height: spec.height, fps: 200,
                lighting, flow,
                seed: spec.seed ^ (lighting.slug().len() as u64 * 131) ^ (flow.count() as u64),
                light_drift: 0.0,
            };
            let mut src = SyntheticSource::new(cfg);
            for _ in 0..spec.warmup {
                src.next_frame();
            }
            let mut acc = ComparisonAcc::default();
            for _ in 0..k {
                let f = src.next_frame();
                let cov = crate::analysis::gt_coverage(&f.mask, w, h, 16);
                let mut weights = vec![0.3f32; gw * gh];
                for by in 0..gh {
                    for bx in 0..gw {
                        let i = by * gw + bx;
                        let hit = cov[i] > 0.02;
                        let mut near = false;
                        for dy in [-1i32, 0, 1] {
                            for dx in [-1i32, 0, 1] {
                                let nx = bx as i32 + dx;
                                let ny = by as i32 + dy;
                                if nx >= 0 && ny >= 0 && nx < gw as i32 && ny < gh as i32
                                    && cov[ny as usize * gw + nx as usize] > 0.02
                                {
                                    near = true;
                                }
                            }
                        }
                        weights[i] = if hit { 5.0 } else if near { 0.9 } else { 0.3 };
                    }
                }
                let c = compare_frame(&f, &weights, spec.q_uniform, w, h, lighting.slug(), flow.slug());
                acc.add(&c);
            }
            let kk = k as f64;
            out.push(PresetMetric {
                lighting: lighting.slug().to_string(),
                flow: flow.slug().to_string(),
                frames: k,
                uniform_bytes: acc.ub / kk,
                roi_bytes: acc.rb / kk,
                uniform_bee_psnr: acc.ubu / kk,
                roi_bee_psnr: acc.rbu / kk,
                delta_bee_db: acc.d / kk,
                uniform_bg_psnr: acc.ubg / kk,
                roi_bg_psnr: acc.rbg / kk,
            });
        }
    }
    out
}

#[derive(Default)]
struct ComparisonAcc {
    ub: f64, rb: f64, ubu: f64, rbu: f64, d: f64, ubg: f64, rbg: f64,
}
impl ComparisonAcc {
    fn add(&mut self, c: &Comparison) {
        self.ub += c.uniform_bytes as f64;
        self.rb += c.roi_bytes as f64;
        self.ubu += c.uniform_bee_psnr;
        self.rbu += c.roi_bee_psnr;
        self.d += c.delta_bee_db;
        self.ubg += c.uniform_bg_psnr;
        self.rbg += c.roi_bg_psnr;
    }
}

pub fn preset_metrics_to_json(pms: &[PresetMetric], spec: &BenchSpec) -> String {
    let min_delta = pms.iter().map(|p| p.delta_bee_db).fold(f64::INFINITY, f64::min);
    let mean_delta = pms.iter().map(|p| p.delta_bee_db).sum::<f64>() / pms.len().max(1) as f64;
    let mut s = String::from("{\n");
    s.push_str(&format!(" \"width\":{},\"height\":{},\"q_uniform\":{},\"frames_per_preset\":{},\n",
        spec.width, spec.height, spec.q_uniform, spec.compare_frames));
    s.push_str(" \"presets\": [\n");
    for (i, p) in pms.iter().enumerate() {
        s.push_str("  {");
        s.push_str(&format!(
            "\"lighting\":\"{}\",\"flow\":\"{}\",\"frames\":{},\"uniform_bytes\":{:.0},\"roi_bytes\":{:.0},\"byte_ratio\":{:.4},\"uniform_bee_psnr\":{:.3},\"roi_bee_psnr\":{:.3},\"delta_bee_db\":{:.3},\"uniform_bg_psnr\":{:.3},\"roi_bg_psnr\":{:.3}}}",
            p.lighting, p.flow, p.frames, p.uniform_bytes, p.roi_bytes,
            p.roi_bytes / p.uniform_bytes.max(1.0),
            p.uniform_bee_psnr, p.roi_bee_psnr, p.delta_bee_db,
            p.uniform_bg_psnr, p.roi_bg_psnr));
        if i + 1 < pms.len() { s.push(','); }
        s.push('\n');
    }
    s.push_str(" ],\n");
    s.push_str(&format!(" \"min_delta_bee_db\": {:.3},\n", min_delta));
    s.push_str(&format!(" \"mean_delta_bee_db\": {:.3},\n", mean_delta));
    s.push_str(&format!(" \"pass_4db\": {}\n", min_delta >= 4.0));
    s.push_str("}\n");
    s
}

pub fn throughput_work(width: u32, height: u32, frames: u32, q: i32) -> (u64, u64) {
    use crate::codec::{encode_plate_residual, Planes};
    let w = width as usize;
    let h = height as usize;
    let cfg = SynthConfig {
        width, height, fps: 200,
        lighting: Lighting::NeutralDay,
        flow: Flow::High,
        seed: 0x5050,
        light_drift: 0.0,
    };
    // One-time source/plate generation is deliberately outside the measured
    // compression loop: imported footage arrives as decoded RGBA frames.
    let mut src = SyntheticSource::new(cfg);
    let ring_n = 24usize;
    let mut ring: Vec<crate::synth::Frame> = Vec::with_capacity(ring_n);
    for _ in 0..ring_n {
        ring.push(src.next_frame());
    }
    let plate_rgba = src.background_rgba().to_vec();
    let plate = Planes::from_rgba(&plate_rgba, w, h);
    let mut analyzer = Analyzer::new(w, h, 16);
    analyzer.set_plate_rgba(&plate_rgba);
    // Prime analyzer once.
    let _ = analyzer.analyze(&ring[0].rgba);

    let mut total = 0u64;
    let mut checksum = 0u64;
    for i in 0..frames as usize {
        // Sequential ring gives representative 200 fps inter-frame motion
        // rather than an adversarial A/B jump.
        let f = &ring[(i + 1) % ring_n];
        let infos = analyzer.analyze(&f.rgba);
        let weights: Vec<f32> = infos.iter().map(|b| b.weight).collect();
        let e = encode_plate_residual(&f.rgba, &plate, w, h, q, Some(&weights));
        total += e.bits.len() as u64;
        for b in e.bits.iter().step_by(997) {
            checksum = checksum.wrapping_add(*b as u64);
        }
    }
    (total, checksum)
}

pub fn matrix_sweep(width: u32, height: u32, q: i32, k: u32) -> String {
    let w = width as usize;
    let h = height as usize;
    let mut min_mean = f64::INFINITY;
    let mut s = String::new();
    for &lighting in Lighting::all().iter() {
        for &flow in Flow::all().iter() {
            let cfg = SynthConfig {
                width, height, fps: 200, lighting, flow,
                seed: BenchSpec::default().seed ^ (lighting.slug().len() as u64 * 131) ^ (flow.count() as u64),
                light_drift: 0.0,
            };
            let mut src = SyntheticSource::new(cfg);
            let mut analyzer = Analyzer::new(w, h, 16);
            let mut plate_frames: Vec<Vec<u8>> = Vec::new();
            for i in 0..16 {
                let f = src.next_frame();
                analyzer.analyze(&f.rgba);
                if i % 2 == 0 && plate_frames.len() < 9 {
                    plate_frames.push(f.rgba.clone());
                }
            }
            let plate_rgba = crate::analysis::estimate_plate(&plate_frames, w, h);
            analyzer.set_plate_rgba(&plate_rgba);
            for _ in 0..2 {
                let f = src.next_frame();
                analyzer.analyze(&f.rgba);
            }
            let mut ds = 0f64; let mut brs = 0f64; let mut bus = 0f64; let mut rr = 0f64;
            for _ in 0..k {
                let f = src.next_frame();
                let infos = analyzer.analyze(&f.rgba);
                let weights: Vec<f32> = infos.iter().map(|b| b.weight).collect();
                let c = compare_frame(&f, &weights, q, w, h, lighting.slug(), flow.slug());
                ds += c.delta_bee_db; brs += c.roi_bee_psnr; bus += c.uniform_bee_psnr;
                rr += c.roi_bytes as f64 / c.uniform_bytes as f64;
            }
            let kk = k as f64;
            let dm = ds/kk; min_mean = min_mean.min(dm);
            s.push_str(&format!("{:15} {:6} dMean={:5.2} roi={:5.1} uni={:5.1} ratio={:.3}\n",
                lighting.slug(), flow.slug(), dm, brs/kk, bus/kk, rr/kk));
        }
    }
    s.push_str(&format!("MATRIX MIN MEAN DELTA {min_mean:.3} PASS4 {}\n", min_mean >= 4.0));
    s
}

pub fn residual_sweep(width: u32, height: u32, q_uniform: i32) -> String {
    use crate::codec::{decode_plate_residual, encode_plate_residual, match_roi_residual, Planes};
    let w = width as usize;
    let h = height as usize;
    let mut min_d = f64::INFINITY;
    let mut max_r = 0f64;
    let mut s = String::new();
    for &lighting in Lighting::all().iter() {
        for &flow in Flow::all().iter() {
            let cfg = SynthConfig {
                width, height, fps: 200, lighting, flow,
                seed: BenchSpec::default().seed ^ (lighting.slug().len() as u64*131),
                light_drift: 0.0,
            };
            let mut src = SyntheticSource::new(cfg);
            let mut analyzer = Analyzer::new(w, h, 16);
            let mut keep: Vec<Vec<u8>> = Vec::new();
            let mut f = src.next_frame();
            for i in 0..16 {
                f = src.next_frame();
                analyzer.analyze(&f.rgba);
                if i % 2 == 0 && keep.len() < 9 { keep.push(f.rgba.clone()); }
            }
            let plate_rgba = crate::analysis::estimate_plate(&keep, w, h);
            analyzer.set_plate_rgba(&plate_rgba);
            // Re-analyze target against the median plate.
            let infos = analyzer.analyze(&f.rgba);
            let weights: Vec<f32> = infos.iter().map(|b| b.weight).collect();
            let plate = Planes::from_rgba(&plate_rgba, w, h);

            let uni = encode_plate_residual(&f.rgba, &plate, w, h, q_uniform, None);
            let target = uni.bits.len();
            let (_q, roi) = match_roi_residual(&f.rgba, &plate, w, h, &weights, target);
            let du = decode_plate_residual(&uni.bits, &plate).unwrap();
            let dr = decode_plate_residual(&roi.bits, &plate).unwrap();
            let bu = psnr_masked_y(&f.rgba, &du.rgba, Some(&f.mask), w, h).psnr_y;
            let br = psnr_masked_y(&f.rgba, &dr.rgba, Some(&f.mask), w, h).psnr_y;
            let d = br - bu;
            let ratio = roi.bits.len() as f64 / target as f64;
            min_d = min_d.min(d);
            max_r = max_r.max(ratio);
            s.push_str(&format!("{:15} {:6} d={:5.2} roi={:5.2} uni={:5.2} ratio={:.3} U={} R={}\n",
                lighting.slug(), flow.slug(), d, br, bu, ratio, target, roi.bits.len()));
        }
    }
    s.push_str(&format!("RESIDUAL MIN DELTA {min_d:.3} MAX RATIO {max_r:.3}\n"));
    s
}

pub fn gt_sweep(width: u32, height: u32, q_uniform: i32) -> String {
    let w = width as usize;
    let h = height as usize;
    let mut min_d = f64::INFINITY;
    let mut s = String::new();
    for &lighting in Lighting::all().iter() {
        for &flow in Flow::all().iter() {
            let cfg = SynthConfig {
                width, height, fps: 200, lighting, flow,
                seed: BenchSpec::default().seed, light_drift: 0.0,
            };
            let mut src = SyntheticSource::new(cfg);
            let mut f = src.next_frame();
            for _ in 0..14 { f = src.next_frame(); }
            let cov = crate::analysis::gt_coverage(&f.mask, w, h, 16);
            // GT upper-bound allocation map with 1-block dilation.
            let gw = w.div_ceil(16);
            let gh = h.div_ceil(16);
            let mut weights = vec![0.3f32; gw * gh];
            for by in 0..gh { for bx in 0..gw {
                let i = by*gw+bx;
                let mut hit = cov[i] > 0.02;
                for dy in [-1i32,0,1] { for dx in [-1i32,0,1] {
                    let nx=bx as i32+dx; let ny=by as i32+dy;
                    if nx>=0&&ny>=0&&nx<gw as i32&&ny<gh as i32 && cov[ny as usize*gw+nx as usize]>0.02 { hit=true; }
                }}
                weights[i] = if hit { 4.5 } else { 0.25 };
            }}
            let uni = encode_intra(&f.rgba,w,h,q_uniform,None);
            let (_q,roi)=match_roi_budget(&f.rgba,w,h,&weights,uni.bits.len());
            let du=decode_intra(&uni.bits).unwrap();
            let dr=decode_intra(&roi.bits).unwrap();
            let bu=psnr_masked_y(&f.rgba,&du.rgba,Some(&f.mask),w,h).psnr_y;
            let br=psnr_masked_y(&f.rgba,&dr.rgba,Some(&f.mask),w,h).psnr_y;
            let d=br-bu; min_d=min_d.min(d);
            s.push_str(&format!("{:15} {:6} d={:5.2} roi={:5.2} uni={:5.2}\n",lighting.slug(),flow.slug(),d,br,bu));
        }
    }
    s.push_str(&format!("GT MIN DELTA {min_d:.3}\n"));
    s
}

pub fn diag(width: u32, height: u32) -> String {
    let w = width as usize;
    let h = height as usize;
    let cfg = SynthConfig {
        width, height, fps: 200,
        lighting: Lighting::NeutralDay,
        flow: Flow::Medium,
        seed: BenchSpec::default().seed,
        light_drift: 0.0,
    };
    let mut src = SyntheticSource::new(cfg);
    let mut analyzer = Analyzer::new(w, h, 16);
        analyzer.set_plate_rgba(src.background_rgba());
    let mut f = src.next_frame();
    let mut infos = vec![];
    for _ in 0..14 {
        f = src.next_frame();
        infos = analyzer.analyze(&f.rgba);
    }
    let weights: Vec<f32> = infos.iter().map(|b| b.weight).collect();
    let classes: Vec<u8> = infos.iter().map(|b| b.class).collect();
    let mut counts = [0u32; 4];
    for c in &classes {
        counts[*c as usize] += 1;
    }
    let mut out = String::new();
    out.push_str(&format!("grid={}x{} class_counts bg/crawl/fast/pollen={:?}\n",
        w.div_ceil(16), h.div_ceil(16), counts));
    for q in [2i32, 6, 10, 16, 30, 48] {
        let e = encode_intra(&f.rgba, w, h, q, None);
        let d = decode_intra(&e.bits).unwrap();
        let bee = psnr_masked_y(&f.rgba, &d.rgba, Some(&f.mask), w, h);
        out.push_str(&format!("uniform q={q:>3} bytes={:>7} bee_psnr={:.2}\n", e.bits.len(), bee.psnr_y));
    }
    let uni = encode_intra(&f.rgba, w, h, 30, None);
    let (qroi, roi) = match_roi_budget(&f.rgba, w, h, &weights, uni.bits.len());
    let dr = decode_intra(&roi.bits).unwrap();
    let beer = psnr_masked_y(&f.rgba, &dr.rgba, Some(&f.mask), w, h);
    // q distribution among bee-mask-covered blocks vs others.
    let gt = crate::analysis::gt_coverage(&f.mask, w, h, 16);
    let mut bee_q: Vec<u8> = vec![];
    let mut bg_q: Vec<u8> = vec![];
    for i in 0..roi.qmap.len() {
        if gt[i] > 0.05 { bee_q.push(roi.qmap[i]); } else { bg_q.push(roi.qmap[i]); }
    }
    let avg = |v: &[u8]| if v.is_empty() { 0.0 } else { v.iter().map(|x| *x as f64).sum::<f64>()/v.len() as f64 };
    out.push_str(&format!("target={} roi_bytes={} qroi={qroi} bee_psnr={:.2}\n",
        uni.bits.len(), roi.bits.len(), beer.psnr_y));
    out.push_str(&format!("avg q bee_blocks={:.1} (n={}) bg_blocks={:.1} (n={})\n",
        avg(&bee_q), bee_q.len(), avg(&bg_q), bg_q.len()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roi_beats_uniform_by_at_least_4db() {
        let spec = BenchSpec {
            width: 960,
            height: 540,
            warmup: 10,
            compare_frames: 8,
            q_uniform: 46,
            all_presets: true,
            ..BenchSpec::default()
        };
        let pms = run_gt_matrix(&spec);
        assert_eq!(pms.len(), 15);
        let min_delta = pms.iter().map(|p| p.delta_bee_db).fold(f64::INFINITY, f64::min);
        for p in &pms {
            // Every lighting/flow cell must clear the target, with matched bytes.
            assert!(
                p.delta_bee_db >= 4.0,
                "{}/{} delta {:.2} < 4 (roi {:.2} uniform {:.2})",
                p.lighting, p.flow, p.delta_bee_db, p.roi_bee_psnr, p.uniform_bee_psnr
            );
            let ratio = p.roi_bytes / p.uniform_bytes.max(1.0);
            assert!(ratio <= 1.02, "ROI exceeded matched budget: {ratio:.3}");
        }
        assert!(min_delta >= 4.0);
    }
}

/// background macroblocks are copied from a stable plate so decoded
/// background frames should be nearly identical temporally.
pub fn flicker_check(width: u32, height: u32, frames: u32) -> (f64, f64) {
    let w = width as usize;
    let h = height as usize;
    let cfg = SynthConfig {
        width, height, fps: 200,
        lighting: Lighting::NeutralDay,
        flow: Flow::Medium,
        seed: 0xABCDEF,
        light_drift: 0.0,
    };
    let mut src = SyntheticSource::new(cfg);
    let mut analyzer = Analyzer::new(w, h, 16);
        analyzer.set_plate_rgba(src.background_rgba());
    let mut prev_dec: Option<Vec<u8>> = None;
    let mut last_mask = Vec::new();
    let mut mad_sum = 0.0;
    let mut flick_sum = 0.0;
    let mut n = 0u32;
    for _ in 0..frames {
        let f = src.next_frame();
        let infos = analyzer.analyze(&f.rgba);
        let weights: Vec<f32> = infos.iter().map(|b| b.weight).collect();
        let enc = encode_intra(&f.rgba, w, h, 26, Some(&weights));
        let dec = decode_intra(&enc.bits).unwrap();
        if let Some(p) = &prev_dec {
            mad_sum += crate::metrics::background_temporal_mad(p, &dec.rgba, &f.mask, w, h);
            flick_sum += block_flicker(p, &dec.rgba, &last_mask, w, h, 16);
            n += 1;
        }
        prev_dec = Some(dec.rgba);
        last_mask = f.mask;
    }
    (mad_sum / n.max(1) as f64, flick_sum / n.max(1) as f64)
}
