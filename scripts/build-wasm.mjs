// 编译 Rust 编解码核心到 wasm32-unknown-unknown(裸 C ABI,无需 emscripten/wasm-bindgen)
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'public/wasm');
mkdirSync(outDir, { recursive: true });

const rustflags = [
  '-C', 'opt-level=3',
  '-C', 'lto=true',
  '-C', 'codegen-units=1',
  '-C', 'panic=abort',
  '-C', 'strip=debuginfo',
  '-C', 'link-arg=--no-entry',
  '-C', 'link-arg=--export-dynamic',
  '-C', 'link-arg=--initial-memory=67108864',
  '-C', 'link-arg=--max-memory=536870912',
  '-C', 'link-arg=--stack-first',
].join(' ');

const env = { ...process.env, RUSTFLAGS: rustflags };

console.log('[build:wasm] cargo build --target wasm32-unknown-unknown --release');
execFileSync(
  'cargo',
  ['build', '--target', 'wasm32-unknown-unknown', '--release'],
  { cwd: resolve(root, 'rust'), env, stdio: 'inherit' },
);

const artifact = resolve(root, 'rust/target/wasm32-unknown-unknown/release/hive_codec.wasm');
if (!existsSync(artifact)) {
  throw new Error(`WASM artifact not found: ${artifact}`);
}
const dest = resolve(outDir, 'hive_codec.wasm');
copyFileSync(artifact, dest);
console.log(`[build:wasm] copied -> ${dest}`);
