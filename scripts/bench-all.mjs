// Reproducible evidence bundle: quality matrix + speed (native) + WASM probe.
// Outputs JSON to benchmarks/results and copies the two web reports to public.
import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = resolve(root, 'benchmarks/results');
mkdirSync(results, { recursive: true });
mkdirSync(resolve(root, 'public/reports'), { recursive: true });
const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo';

function run(args) {
  const r = spawnSync(cargo, args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) { console.error(r.stdout); process.exit(r.status ?? 1); }
  return r.stdout;
}

console.log('== 1/3 1080p quality matrix (5 light x 3 flow) ==');
const quality = run(['run', '--manifest-path', 'wasm-core/Cargo.toml', '--release', '-q', '--bin', 'hive-bench']);
// The default mode prints JSON only.
JSON.parse(quality); // validate
writeFileSync(resolve(results, '1080p-quality.json'), quality);

console.log('== 2/3 native speed / seek ==');
const speed = run(['run', '--manifest-path', 'wasm-core/Cargo.toml', '--release', '-q', '--bin', 'hive-bench', '--', '--mode', 'speed', '--width', '1920', '--height', '1080', '--frames', '400']);
const speedLine = speed.split('\n').find((l) => l.trim().startsWith('{')) || speed;
JSON.parse(speedLine);
writeFileSync(resolve(results, 'native-speed.json'), speedLine.trim());

console.log('== 3/3 WASM probe ==');
const wr = spawnSync('node', [resolve(root, 'benchmarks/wasm-bench.mjs')], { cwd: root, stdio: 'inherit' });
if (wr.status !== 0) process.exit(wr.status ?? 1);

for (const f of ['1080p-quality.json', 'native-speed.json', 'wasm-speed.json']) {
  const src = resolve(results, f);
  if (existsSync(src)) copyFileSync(src, resolve(root, 'public/reports', f));
}
console.log('Evidence written to benchmarks/results and public/reports.');
