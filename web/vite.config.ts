import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
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
      // Dev only: cities built on demand by places/server.py (data/places/, gitignored).
      const generated = resolve(HERE, '..', 'data', 'places');
      server.middlewares.use('/generated', (req, res, next) => {
        const file = join(generated, normalize(decodeURIComponent((req.url ?? '').split('?')[0])));
        if (!file.startsWith(generated) || !existsSync(file) || !statSync(file).isFile()) return next();
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
      // Featured towns only; generated cities stay local to the machine that built them.
      for (const id of ['morganton', 'lumberton', 'chapel_hill']) {
        for (const f of PLACE_FILES) {
          const src = join(PLACES_DIR, id, f);
          if (existsSync(src)) cpSync(src, join(out, id, f));
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), placesPlugin()],
  // The local build service (places/server.py) turns any typed-in city into a place.
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
});
