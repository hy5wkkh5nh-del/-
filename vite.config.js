import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: true,
    watch: {
      ignored: [
        '**/.gstack/**', '**/data/**', '**/tmp/**', '**/chrome-verify-profile/**',
        '**/chrome-debug-transport/**', '**/dist*/**', '**/.codex/**', '**/.agents/**',
        '**/public/evidence/**'
      ]
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
        secure: false,
        ws: false
      },
      '/activity-videos': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
        secure: false,
        ws: false
      }
    }
  },
  preview: {
    port: 5174,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
        secure: false,
        ws: false
      }
    }
  },
  build: {
    target: 'es2022',
    sourcemap: true
  }
});

