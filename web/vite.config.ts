import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Everything the app calls is same-origin under /api, so the browser never
    // makes a cross-origin request and the API needs no CORS configuration.
    // nginx does the identical rewrite in the Docker image (see nginx.conf).
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
