import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Gives public/sw.js the id of this build (a hash of the hashed asset names), so each release
 * is a new service worker with its own cache and browsers notice the update, and the list of
 * assets to cache on install, including the chunks of views that load later.
 */
function stampServiceWorker(): Plugin {
  let out = 'dist';
  return {
    name: 'netforge-stamp-service-worker',
    apply: 'build',
    configResolved(config) {
      out = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const assets = readdirSync(join(out, 'assets')).sort();
      const id = createHash('sha256').update(assets.join()).digest('hex').slice(0, 10);
      // woff files are only a fallback for browsers without woff2, which cannot run the app.
      const precache = assets.filter((f) => /\.(js|css|woff2)$/.test(f)).map((f) => `/assets/${f}`);
      const file = join(out, 'sw.js');
      const sw = readFileSync(file, 'utf8')
        .replace('__BUILD__', id)
        .replace('/* __ASSETS__ */ []', JSON.stringify(precache));
      writeFileSync(file, sw);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), stampServiceWorker()],
  build: {
    rolldownOptions: {
      output: {
        // Libraries change less often than the app: a release then only re-downloads the app.
        codeSplitting: { groups: [{ name: 'vendor', test: /node_modules/ }] },
      },
    },
  },
});
