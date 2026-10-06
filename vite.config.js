import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    // ffmpeg.wasm spawns its own worker; pre-bundling breaks that.
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
});
