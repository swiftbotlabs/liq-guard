import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './', // relative asset paths: works from a dev server and from a packed .ehpk
  server: { host: '127.0.0.1', port: 18573, strictPort: true },
  build: {
    outDir: 'dist',
    rollupOptions: { input: { index: resolve(__dirname, 'index.html'), preview: resolve(__dirname, 'preview.html') } },
  },
});
