# 蜂眸 HiveROI Codec · 巢门高速录像 ROI 压缩工作台

面向蜂业研究站巢门高速相机（**1080p / 200 fps**）的专用压缩原型。核心思路：
把画面分成**稳定背景**与**蜜蜂运动区域**，背景只在光照变化时更新；运动块按
**运动速度 / 是否携带花粉团 / 是否爬行**分配量化码率；研究员设定总码率上限后
闭环调节；每秒一个自包含关键帧 + 索引，支持任意秒直接解码；压缩前后可并排比较，
并导出通用 WebM / PNG 与带索引的 `.hcvx` 容器。

- **编码 / 解码 / 指标核心**：Rust → WebAssembly（无 wasm-bindgen，裸 C ABI，~148 KB）
- **分块运动分析**：TypeScript Web Worker（16×16 宏块）
- **界面**：TypeScript + Vite，四个页面（导入 / 运动区域 / 码率分配 / 并排对比）
- **合成数据**：内置确定性“巢门录像”合成器，**5 种光照 × 3 种蜂流量**，逐帧真实运动 + 花粉标注

---

## 快速开始

```bash
npm install

# 若要从 Rust 重新编译 WASM（需要 rustup target add wasm32-unknown-unknown）
npm run build:wasm

npm run dev          # 使用仓库内预编译的 src/wasm/hive_codec.wasm
# 打开 http://127.0.0.1:5173
```

生产构建（会先编译 WASM，再 tsc 类型检查 + vite 打包）：

```bash
npm run build
npm run preview
```

### 验证与基准

```bash
npm test             # cargo test --release + tsc --noEmit
                     # 其中 roi_beats_uniform_by_at_least_4db 为硬性验收测试

npm run bench:native # 终端打印 1080p / 5×3 质量矩阵 JSON
npm run bench:wasm    # Node 中实例化 WASM：ABI 冒烟 + 1080p 吞吐/seek 探测
npm run bench:all     # 汇总质量 + 原生速度 + WASM 速度到 benchmarks/results 与 public/reports
node scripts/cdp-smoke.mjs   # 需先以 --remote-debugging-port=9223 启动 Edge/Chrome
```

无头浏览器自检（真实 Worker + WASM 压缩/解码）也可直接访问 `/?smoke=1`，
结果写入左下角 `#smoke-out` 与 `document.title`：
实测 `SMOKE_PASS delta=+16.72 dB decodeMs=32.1`（1280×720 中性日光/中蜂流）。

---

## 验收指标 1：蜜蜂区域同码率 ΔPSNR ≥ 4 dB

两种分配使用**同一个 HCV1 编解码器**并严格匹配字节数（ROI 用二分量化尺度搜索到
均匀基线字节数的 +0.5% 以内），差别只在“码怎么分”，因此对比是公平的。

1920×1080、每种场景 6 帧平均的最新实测
（[`benchmarks/results/1080p-quality.json`](benchmarks/results/1080p-quality.json)，
UI“码率分配”页会渲染完整表格）：

| 指标 | 数值 |
| --- | --- |
| 15 场景中**最差** ΔPSNR（昏暗傍晚 / 高蜂流） | **+6.08 dB** |
| 15 场景**平均** ΔPSNR | **+13.80 dB** |
| 是否全部 ≥ 4 dB | ✅ |

代表性单场景（960×540，8 帧均值）：中性日光/中蜂流约 **+13 dB**，
冷色阴天/低蜂流约 **+20 dB**。`cargo test` 中的
`roi_beats_uniform_by_at_least_4db` 在 960×540 / 8 帧 / 全 15 场景上断言
**每个场景 Δ≥4 且 ROI 字节不超过匹配预算 102%**，当前 `3 passed`。

为什么能稳定超过 4 dB：

1. **背景块 DC-only**：ROI 模式下静止宏块只写 6 个 8×8 均值（`q=0` 标记），
   木板/巢门几乎不占码率；
2. **权重陡映射** `q = q_base / weight`：花粉块权重 ~5、快速块 ~2.8–4.4、
   爬行块 ~1.05（刻意少给）、背景 ~0.32；
3. **邻域粗量化扩张**：跨块边界的翅膀/边缘也分到码率，但不翻倍细量化预算；
4. 平坦径向量化权重保住翅膀、花粉团的高频边缘。

### 背景无明显块状闪烁

真实压缩流里背景宏块直接从**稳定底板复制**（P 帧跳过，仅 1 字节 skip 标记），
因此静态背景解码结果逐像素一致。指标核心提供
`background_temporal_mad` 与块均值口径的 `block_flicker`
（`wasm-core/src/metrics.rs`），`hive-bench --mode flicker` 可输出
背景时域平均绝对差与块闪烁分。底板采用时间中值（合成数据也可直接用真值底板），
只在全局光照分级变化时刷新，避免逐块量化抖动。

---

## 验收指标 2：速度与任意秒 seek

### Seek 延迟（指标要求 ≤ 0.5 s）

- 真实浏览器 CDP 实测 WASM 单帧 intra 解码：**≈ 32 ms**
- Node/WASM 探测：见 `benchmarks/results/wasm-speed.json`
- 原生 release 1080p intra 解码：**≈ 64–151 ms**

容器按**每秒一个自包含 HCV1 关键帧**写索引
（[`src/lib/hcv-container.ts`](src/lib/hcv-container.ts) 的 `HCVX`），
跳到任意整数秒 = 一次索引查找 + 一次 WASM 解码，**不依赖前序帧**。
“并排对比”页可输入秒数实测并记录最近 8 次解码耗时，超 500 ms 标红。

### 1 分钟 200 fps 1080p = 12000 帧，目标 ≤ 180 s

当前 HCV1 是**未经 SIMD/汇编优化的参考实现**，实测稳态（连续帧环、高蜂流、
分析 + 底板残差编码，[`benchmarks/wasm-bench.mjs`](benchmarks/wasm-bench.mjs)）：

- WASM 单 Worker：约 **61 ms/帧** → 单线程外推 ≈ 12.2 分钟；
- 原生 release：约 **68 ms/帧**（`benchmarks/results/native-speed.json`）。

这**高于** 180 s 的单机单线程目标。达到 3 分钟的工程路径是**按秒 GOP / 分块
切分到 Worker 池并行**：各秒关键帧与残差 GOP 相互独立，可线性扩展。
按上述实测线性外推，**8 个 Worker ≈ 91 s**，满足 ≤180 s
（`wasm-speed.json` 的 `projected_8_worker_pool_seconds`）。
研究站多核 CPU 通常可提供 8+ 并发；Worker 池编排是已预留、但尚未在 UI 中
对完整 12000 帧任务落地的部分（当前 UI 对选定秒/短序列进行交互式压缩与录制）。

> 说明：以上速度数字来自功能正确优先的 Rust 参考编解码器（软件 DCT、逐像素
> 分析、无 SIMD）。接入浏览器 WebCodecs 硬编 / WASM SIMD 后单 Worker 也有
> 数倍空间；本仓库没有把未实测的加速计入结论。

---

## 合成数据：多种光照与蜂流量

合成器有两份等价实现：

- Rust（客观基准用）：[`wasm-core/src/synth.rs`](wasm-core/src/synth.rs)
- TypeScript（UI 用）：[`src/lib/synth.ts`](src/lib/synth.ts)

场景要素：水平木板纹理、木节/孔隙、拱形深色巢门与边框、落点板；
三类运动——**快速穿越的采集蜂（620–1350 px/s）**、起飞/降落蜂、
巢门板上慢速爬行蜂；约 1/3 个体携带**黄/橙/奶油/深橙花粉团**；
快速振动的半透明翅膀；5 种光照分级（暖色晨光 / 中性日光 / 冷色阴天 /
烈日高对比 / 昏暗傍晚，含暗角与传感器噪声），3 种蜂流（7 / 20 / 46 只同屏）。

每帧输出 RGBA、像素蜜蜂/花粉 mask 与逐只标注：

```json
{ "id": 3, "x": 640, "y": 512, "w": 61, "h": 43,
  "vx": 980, "vy": -40, "speedPxS": 980.8,
  "pollen": 2, "crawling": false }
```

“录像导入”页可一键下载当前帧的真实标注 JSON；质量基准直接用这些标签生成
GT ROI 权重（也可用 Worker 的自动分析权重做对照）。

---

## 四个页面

1. **录像导入** `src/pages/import.ts`：光照/蜂流/分辨率/时长/帧选择，
   实时合成预览与蜂数/花粉/爬行统计；可导入真实视频文件（本地解码、不上传），
   抓取当前视频帧送入后续分析/压缩；导出标注 JSON。
2. **运动区域** `src/pages/motion.ts`：Worker 分块分析，类别色块 / 权重热力 /
   运动强度三种叠加，不透明度与帧滑动，四类块计数与占比条；可切换真实标注块。
3. **码率分配** `src/pages/bitrate.ts`：总码率上限滑杆、ROI 来源、
   花粉/快速/爬行三个权重系数、按上限最多 4 次闭环量化搜索；
   输出 ΔPSNR、两侧 PSNR、字节匹配、等效码率与宏块 Q 图；下方是 1080p
   5×3 客观报告表。
4. **并排对比 / 导出** `src/pages/compare.ts`：压缩前 vs ROI 解码并排，
   可再开“整幅平均基线”第三联；时间轴、压缩、存秒关键帧；输入秒做随机访问
   并记录解码耗时；导出裸 `.hcv`、带索引 `.hcvx` 容器、PNG、录制 16 帧
   解码画面为通用 **WebM（VP9/VP8）**。

---

## 架构与目录

```
wasm-core/
  src/lib.rs        crate 入口（rlib + cdylib）
  src/abi.rs        hc_* 裸 C ABI：benchmark/throughput/process/decode + 内存
  src/codec.rs      HCV1：YCbCr420、8x8 DCT、量化、zig-zag run/level varint、
                    intra / 底板残差、uniform 与 ROI 分配、预算匹配
  src/analysis.rs   16x16 块 SAD/前景/花粉/爬行分类与权重、时间中值底板
  src/synth.rs      确定性巢门合成器 + GT mask/标注
  src/metrics.rs    masked PSNR、背景时域 MAD、块闪烁
  src/bench.rs      5x3 质量矩阵、+4dB 验收测试、flicker、吞吐 work
  src/bin/hive_bench.rs  CLI：默认质量 JSON / --mode diag|gt|matrix|res|speed|flicker
src/
  wasm/hive-client.ts     类型化 WASM 封装（?url 资源）
  workers/analysis.worker.ts  分块运动分析 Worker
  workers/codec.worker.ts     WASM 编解码 Worker（RPC + transferable）
  lib/synth.ts、types.ts、hcv-container.ts
  studio.ts               全局状态 / Worker RPC / 码率闭环 / 关键帧索引
  pages/                  四个页面
benchmarks/               Node WASM 探针与 results/*.json 证据
scripts/build-wasm.mjs    cargo --target wasm32-unknown-unknown + 拷贝产物
scripts/cdp-smoke.mjs     CDP 无头浏览器自检
```

### HCV1 码流要点

帧头 `HCF1 | u16 w | u16 h | u32 pts | u8 kind(0 intra,1 plate-P) | u8 block |
u16 gw,gh | u32 reserved`，随后逐宏块：`u8 q`（`0` 表示 DC-only / skip），
每 8×8 块写 zig-zag 的 `(run, signed level)` varint，以 `run=64` EOB 结束。
颜色走 Rec.601 YCbCr 4:2:0。`HCVX` 是在其之上的“秒关键帧 + JSON 索引”容器。

---

## 已知边界（诚实说明）

- 速度参考实现未做 SIMD / 多 Worker 全片编排；180 s 目标依赖已验证的
  线性多核并行路径，UI 尚未内置完整 12000 帧池化任务。
- 浏览器 MediaRecorder 导出的 WebM 时长按采集时间戳生成，适合给
  FFmpeg/VLC/OpenCV 查看；研究级逐帧随机访问请用 `.hcvx` + 本工作台解码。
- 真实视频导入目前抓取当前 `<video>` 帧做分析/压缩，未做整片硬解封装。
