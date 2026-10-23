import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `vite` dev server proxies the API to a running workflow server: `pnpm dev:workflow` starts
// both (server on 4317); set VITE_API_TARGET to point elsewhere, e.g. the mock-agent demo on 4318.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: './',
  // In dev, load the workspace workflow packages from source so their edits hot-reload too.
  resolve: command === 'serve' ? { conditions: ['ua-source', 'module', 'browser', 'development|production'] } : {},
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 800 },
  server: { proxy: { '/api': process.env.VITE_API_TARGET ?? 'http://127.0.0.1:4317' } },
}));
