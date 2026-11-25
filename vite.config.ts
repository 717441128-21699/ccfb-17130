import { defineConfig } from 'vite';

// The codec is a raw-C-ABI wasm in /public; workers are bundled as ES modules.
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  server: { host: '127.0.0.1', port: 5173 },
});
