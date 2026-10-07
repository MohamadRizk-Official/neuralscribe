import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Pages of the multi-page app. Vercel serves them at clean URLs (vercel.json "cleanUrls"),
// e.g. /library -> library.html; the dev-server plugin below does the same locally.
const pages = {
  main: 'index.html',
  auth: 'auth.html',
  authCallback: 'auth/callback.html',
  library: 'library.html',
  transcript: 'transcript.html',
};
const cleanRoutes = new Set(['/auth', '/auth/callback', '/library', '/transcript']);

export default defineConfig({
  // The Supabase settings live in Vercel as NEXT_PUBLIC_* (public, browser-safe values).
  // Only these prefixes are ever exposed to the browser bundle.
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
  optimizeDeps: {
    // ffmpeg.wasm spawns its own worker; pre-bundling breaks that.
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  build: {
    rollupOptions: {
      input: Object.fromEntries(Object.entries(pages).map(([k, f]) => [k, resolve(import.meta.dirname, f)])),
    },
  },
  plugins: [
    {
      name: 'clean-urls-dev',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          const [path, query] = req.url.split('?');
          if (cleanRoutes.has(path)) req.url = `${path}.html${query ? `?${query}` : ''}`;
          next();
        });
      },
    },
  ],
});
