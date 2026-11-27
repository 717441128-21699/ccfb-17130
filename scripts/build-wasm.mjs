// 把 Rust 编解码核心编译为纯 wasm32(无 wasm-bindgen、无外部依赖),
// 输出到 public/wasm/hive_codec.wasm 供 Vite 以静态资源方式加载。
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, copyFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const crateDir = resolve(root, 'crates/hive-codec');
const wasmOut = resolve(
  crateDir,
  'target/wasm32-unknown-unknown/release/hive_codec.wasm',
);
const destDir = resolve(root, 'public/wasm');
const dest = resolve(destDir, 'hive_codec.wasm');

const args = [
  'build',
  '--release',
  '--target',
  'wasm32-unknown-unknown',
  '--manifest-path',
  resolve(crateDir, 'Cargo.toml'),
];
console.log('[build:wasm] cargo', args.join(' '));
execFileSync('cargo', args, { stdio: 'inherit' });

if (!existsSync(wasmOut)) {
  throw new Error(`wasm 产物缺失: ${wasmOut}`);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(wasmOut, dest);
const kb = (statSync(dest).size / 1024).toFixed(1);
console.log(`[build:wasm] -> ${dest} (${kb} KiB)`);
