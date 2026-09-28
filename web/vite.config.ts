import { cpSync, createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

const HERE = dirname(fileURLToPath(import.meta.url));

// Place folders live in the repo's places/ directory (owned by Structures). They are
// served at /places/... in dev and copied into dist/places at build time, so the app
// needs no network access for town data during the demo.
const PLACES_DIR = resolve(HERE, '..', 'places');
const PLACE_FILES = ['buildings.json', 'cells.json', 'crossings.json', 'place.json', 'terrain.bin'];

function placesPlugin(): Plugin {
  return {
    name: 'refuge-places',
    configureServer(server) {
      server.middlewares.use('/places', (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? '').split('?')[0]));
        const file = join(PLACES_DIR, rel);
        if (!file.startsWith(PLACES_DIR) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
      // Dev only: sample simulation results in the gitignored data/dev_results/ folder.
      const devResults = resolve(HERE, '..', 'data', 'dev_results');
      server.middlewares.use('/dev-results', (req, res, next) => {
        const file = join(devResults, normalize(decodeURIComponent((req.url ?? '').split('?')[0])));
        if (!file.startsWith(devResults) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', 'application/json');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      const out = resolve(HERE, 'dist', 'places');
      if (existsSync(join(PLACES_DIR, 'index.json'))) cpSync(join(PLACES_DIR, 'index.json'), join(out, 'index.json'));
      // Every place in the index (featured, past events, cities built locally).
      const ids = existsSync(join(PLACES_DIR, 'index.json'))
        ? (JSON.parse(readFileSync(join(PLACES_DIR, 'index.json'), 'utf8')) as { place_id: string }[]).map(e => e.place_id)
        : [];
      for (const id of ids) {
        for (const f of PLACE_FILES) {
          const src = join(PLACES_DIR, id, f);
          if (existsSync(src)) cpSync(src, join(out, id, f));
        }
      }
    },
  };
}

// ML exports (ml/exports, owned by the ML lead) are served at /data/... in dev and copied
// into dist/data at build time, so chart pages can fetch('/data/deaths_by_hour.json').
const EXPORTS_DIR = resolve(HERE, '..', 'ml', 'exports');

function exportsPlugin(): Plugin {
  return {
    name: 'refuge-exports',
    configureServer(server) {
      server.middlewares.use('/data', (req, res, next) => {
        const file = join(EXPORTS_DIR, normalize(decodeURIComponent((req.url ?? '').split('?')[0])));
        if (!file.startsWith(EXPORTS_DIR) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : file.endsWith('.csv') ? 'text/csv' : 'text/plain');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (existsSync(EXPORTS_DIR)) cpSync(EXPORTS_DIR, resolve(HERE, 'dist', 'data'), { recursive: true });
    },
  };
}

// Link previews need absolute URLs. On Vercel the production domain is known at build
// time; set SITE_URL to override (e.g. a custom domain). Locally it stays relative.
function siteUrlPlugin(): Plugin {
  const url = process.env.SITE_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  return {
    name: 'refuge-site-url',
    transformIndexHtml: { order: 'pre', handler: html => html.replaceAll('%SITE_URL%', url.replace(/\/$/, '')) },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), placesPlugin(), exportsPlugin(), siteUrlPlugin()],
  resolve: { alias: { '@': resolve(HERE, 'src') } },
  // Local build server (places/build_server.py): builds any U.S. city into places/<id>/.
  server: { proxy: { '/build-api': { target: 'http://127.0.0.1:8765', rewrite: p => p.replace(/^\/build-api/, '') } } },
});
