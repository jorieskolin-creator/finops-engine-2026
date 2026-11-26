import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const buildCommit = [
  process.env.RAILWAY_GIT_COMMIT_SHA,
  process.env.GIT_COMMIT_SHA,
  process.env.VERCEL_GIT_COMMIT_SHA,
].find(sha => sha && /^[a-f0-9]{40}$/i.test(sha));

export default defineConfig({
  plugins: [react()],
  // Expose only the public build revision and tactics URL. Provider keys stay server-side.
  define: {
    __FINOPS_BUILD_COMMIT__: JSON.stringify(buildCommit ?? null),
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
