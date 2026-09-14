import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

// Ports are env-driven so a second instance can run alongside the first without editing
// this file. Defaults are the ones the project has always used.
const webPort = Number(process.env.WEB_PORT) || 3000;
const apiPort = Number(process.env.API_PORT) || 8787;

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      port: webPort,
      host: '0.0.0.0',
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      // Lets a Cloudflare quick-tunnel's *.trycloudflare.com Host header through Vite's
      // dev-server host check, which otherwise rejects any non-localhost Host header.
      allowedHosts: true as const,
      proxy: {
        '/api': {
          target: `http://localhost:${apiPort}`,
          changeOrigin: true,
        },
      },
    },
  };
});
