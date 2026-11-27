import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
  // wasm 以静态资源方式提供,不经过打包器转换
  assetsInclude: ['**/*.wasm'],
});
