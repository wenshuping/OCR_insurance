import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const webPort = Number(process.env.POLICY_OCR_WEB_PORT || 3013);
const webHost = process.env.POLICY_OCR_WEB_HOST || '0.0.0.0';
const apiPort = Number(process.env.POLICY_OCR_APP_API_PORT || 4206);
const apiTarget = process.env.POLICY_OCR_API_PROXY_TARGET || `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: webPort,
    host: webHost,
    allowedHosts: ['poptonic.cn', 'www.poptonic.cn', 'app.poptonic.cn'],
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: webPort,
    host: webHost,
    allowedHosts: ['poptonic.cn', 'www.poptonic.cn', 'app.poptonic.cn'],
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
});
