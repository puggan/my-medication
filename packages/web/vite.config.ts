import { defineConfig } from 'vite';

export default defineConfig({
    root: 'client',
    build: { outDir: '../dist/public', emptyOutDir: true },
    // In development the API runs separately: pnpm dev (port 3100) next to pnpm dev:client
    server: { proxy: { '/api': 'http://127.0.0.1:3100' } },
});
