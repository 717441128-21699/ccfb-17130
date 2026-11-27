// 浏览器端 WASM 单例加载
import { instantiateWasm, type WasmExports } from '../core/codec-wasm.ts';

let cached: Promise<WasmExports> | null = null;

export function loadWasm(): Promise<WasmExports> {
  if (!cached) {
    cached = fetch('/wasm/hive_codec.wasm')
      .then((r) => {
        if (!r.ok) throw new Error(`WASM 加载失败: ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => instantiateWasm(new Uint8Array(buf)));
  }
  return cached;
}
