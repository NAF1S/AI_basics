import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Vite dev server proxies /deepseek requests to the FastAPI backend,
// so the frontend can use relative URLs and avoid CORS in development.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/deepseek': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
});
