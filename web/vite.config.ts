import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5182, strictPort: true },
  preview: { host: '127.0.0.1', port: 5183, strictPort: true },
});
