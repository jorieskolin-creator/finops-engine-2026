import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // API_KEY and ANTHROPIC_API_KEY are intentionally NOT defined here — they must
  // stay on the server (api/*.js Vercel functions). Only public, VITE_-prefixed
  // vars are exposed to the browser, via Vite's built-in import.meta.env.
  define: {
    'process.env.VITE_FINOPS_TACTICS_URL': JSON.stringify(process.env.VITE_FINOPS_TACTICS_URL),
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
  server: {
    port: 5173,
    proxy: {
      // In dev, run `node server.js` on :3000 alongside `vite` on :5173;
      // /api/* calls hit the same handlers used in production.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  }
});
