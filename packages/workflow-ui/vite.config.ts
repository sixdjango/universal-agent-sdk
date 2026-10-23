import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Library build: `src/index.ts` -> `dist/index.js` (ESM). React, React Flow and the workflow
 * packages stay external so the host app provides one copy of each. Styles are bundled
 * separately by `scripts/finish-build.mjs` into `dist/styles.css`.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'index' },
    rollupOptions: {
      external: [/^react($|\/)/, /^react-dom($|\/)/, /^@xyflow\/react($|\/)/, /^@universal-agent\//],
    },
  },
});
