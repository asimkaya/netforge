import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Gives public/sw.js the id of this build (a hash of the hashed asset names), so each release
 * is a new service worker with its own cache and browsers notice the update.
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
      const id = createHash('sha256')
        .update(readdirSync(join(out, 'assets')).sort().join())
        .digest('hex')
        .slice(0, 10);
      const file = join(out, 'sw.js');
      writeFileSync(file, readFileSync(file, 'utf8').replace('__BUILD__', id));
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), stampServiceWorker()],
});
