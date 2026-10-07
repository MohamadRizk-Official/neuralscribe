import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';

// Server-only settings the /api functions read from process.env. Locally they come from .env.local;
// on Vercel from the project's Environment Variables. They are NOT in envPrefix, so they never reach the
// browser bundle.
const SERVER_ENV = ['ANTHROPIC_API_KEY', 'AI_PROVIDER', 'AI_MODEL', 'AI_MODEL_ASK', 'AI_MODEL_SUMMARY', 'AI_MODEL_INSIGHTS', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'];

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

export default defineConfig(({ mode }) => ({
  // The Supabase settings live in Vercel as NEXT_PUBLIC_* (public, browser-safe values).
  // Only these prefixes are ever exposed to the browser bundle.
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
  optimizeDeps: {
    // ffmpeg.wasm spawns its own worker; pre-bundling breaks that.
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  build: {
    rollupOptions: {
      // the accuracy lab (eval.html) is only built with `--mode eval`; it is never deployed
      input: Object.fromEntries(
        Object.entries(mode === 'eval' ? { ...pages, eval: 'eval.html' } : pages).map(([k, f]) => [k, resolve(import.meta.dirname, f)]),
      ),
    },
  },
  plugins: [
    {
      // Runs the Vercel functions in api/ on the dev server, so `npm run dev` behaves like production.
      name: 'api-functions-dev',
      configureServer(server) {
        const env = loadEnv(mode, process.cwd(), '');
        for (const k of SERVER_ENV) if (env[k] && !process.env[k]) process.env[k] = env[k];
        server.middlewares.use(async (req, res, next) => {
          const m = /^\/api\/([a-z-]+)$/.exec(req.url.split('?')[0]);
          if (!m) return next();
          try {
            const mod = await server.ssrLoadModule(`/api/${m[1]}.js`);
            await mod.default(req, res);
          } catch (err) {
            if (err?.code === 'ERR_LOAD_URL' || /Failed to load url/.test(err?.message)) { res.statusCode = 404; return res.end(); }
            server.config.logger.error(`[api] ${m[1]}: ${err?.message || err}`);
            if (!res.headersSent) { res.statusCode = 500; res.end('{"error":"server_error"}'); }
          }
        });
      },
    },
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
}));
