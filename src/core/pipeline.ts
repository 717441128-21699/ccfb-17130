// 编码流水线:合成帧 -> Worker 运动分析 -> WASM 编码,
// 并汇总逐帧统计与最终压缩文件。浏览器与 Node 基准测试共用核心逻辑。

import { WasmCodec } from '../wasm/codec';
import { MotionAnalyzer } from './motion';
import { SyntheticVideoGenerator } from './synthetic';
import {
  MB,
  MbClass,
  type ClassMap,
  type EncodeOptions,
  type EncodeSummary,
  type FrameStat,
  type RawFrame,
  type SyntheticConfig,
} from './types';

export interface PipelineHandlers {
  onProgress?: (done: number, total: number) => void;
}

/** 把 RawFrame 填充到编码器要求的 16 对齐尺寸。 */
function padFrame(frame: RawFrame, paddedW: number, paddedH: number): Uint8Array {
  const out = new Uint8Array(paddedW * paddedH * 3);
  for (let y = 0; y < frame.height; y++) {
    const srcOff = y * frame.width * 3;
    const dstOff = y * paddedW * 3;
    out.set(frame.data.subarray(srcOff, srcOff + frame.width * 3), dstOff);
  }
  return out;
}

export class EncodePipeline {
  constructor(private codec: WasmCodec) {}

  /**
   * 运行整条编码流水线。
   * @param useWorker 浏览器环境传 true(后台分析);Node 传 false(直接分析)。
   */
  async run(
    synthCfg: SyntheticConfig,
    opts: EncodeOptions,
    handlers: PipelineHandlers = {},
  ): Promise<{ file: Uint8Array; summary: EncodeSummary; originals: RawFrame[]; classMaps: ClassMap[] }> {
    const gen = new SyntheticVideoGenerator(synthCfg);
    const mbCols = gen.mbCols;
    const mbRows = gen.mbRows;
    const paddedW = mbCols * MB;
    const paddedH = mbRows * MB;

    const encoder = this.codec.createEncoder({
      width: synthCfg.width,
      height: synthCfg.height,
      fps: opts.fps,
      frameCount: synthCfg.frames,
      gop: opts.gop,
      targetBitrate: BigInt(opts.targetBitrate),
      baseQp: opts.baseQp,
    });

    const analyzer = new MotionAnalyzer(synthCfg.width, synthCfg.height);
    const frameStats: FrameStat[] = [];
    const classCounts: Record<MbClass, number> = [0, 0, 0, 0];
    const originals: RawFrame[] = [];
    const classMaps: ClassMap[] = [];
    const t0 = performance.now();

    for (let t = 0; t < synthCfg.frames; t++) {
      const { frame, groundTruth } = gen.generate(t);
      // 真实场景用运动分析;这里同时保留合成器的 groundTruth 供评估对照。
      const analysis = analyzer.analyze(frame);
      const classMap = analysis.classMap;
      void groundTruth;
      for (let c = 0 as MbClass; c < 4; c = (c + 1) as MbClass) {
        classCounts[c] += analysis.counts[c];
      }
      const padded = padFrame(frame, paddedW, paddedH);
      const codedMBs = encoder.writeFrame(padded, classMap);
      const bytes = Number(encoder.bytesSoFar());
      frameStats.push({
        index: t,
        bytes,
        codedMBs,
        frameQp: opts.baseQp,
        isKey: t % opts.gop === 0,
      });
      originals.push(frame);
      classMaps.push(classMap);
      handlers.onProgress?.(t + 1, synthCfg.frames);
    }

    const file = encoder.finish();
    const encodeMs = performance.now() - t0;
    const totalBytes = file.length;
    const durationSec = synthCfg.frames / opts.fps;
    const achievedBitrate = (totalBytes * 8) / durationSec;

    const summary: EncodeSummary = {
      width: synthCfg.width,
      height: synthCfg.height,
      paddedWidth: paddedW,
      paddedHeight: paddedH,
      fps: opts.fps,
      frameCount: synthCfg.frames,
      totalBytes,
      targetBitrate: opts.targetBitrate,
      achievedBitrate,
      frameStats,
      classCounts,
      encodeMs,
    };
    return { file, summary, originals, classMaps };
  }
}
