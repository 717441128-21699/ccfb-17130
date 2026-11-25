// Builds the Rust/WASM codec core and copies the raw .wasm into public/wasm.
// No wasm-bindgen: the module exposes a small C ABI (hc_* functions).
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = resolve(root, 'wasm-core', 'Cargo.toml');

const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const res = spawnSync(
  cargo,
  ['build', '--manifest-path', manifest, '--target', 'wasm32-unknown-unknown', '--release', '--lib'],
  { stdio: 'inherit' },
);
if (res.status !== 0) {
  process.exit(res.status ?? 1);
}

const src = resolve(
  root,
  'wasm-core',
  'target',
  'wasm32-unknown-unknown',
  'release',
  'hive_codec.wasm',
);
if (!existsSync(src)) {
  console.error('WASM artifact not found at', src);
  process.exit(1);
}
const destDir = resolve(root, 'src', 'wasm');
mkdirSync(destDir, { recursive: true });
cpSync(src, resolve(destDir, 'hive_codec.wasm'));
// Also publish a copy for no-bundler / static serving and the Node probe.
const publicDir = resolve(root, 'public', 'wasm');
mkdirSync(publicDir, { recursive: true });
cpSync(src, resolve(publicDir, 'hive_codec.wasm'));
console.log('[build:wasm] copied into src/wasm and public/wasm');
