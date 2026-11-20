import react from '@vitejs/plugin-react';
import { defineConfig, type Connect } from 'vite';
import { resolve } from 'node:path';

const redirectAdmin: Connect.NextHandleFunction = (request, response, next) => {
  const [path, query] = (request.url ?? '').split(/\?(.*)/s);
  if (path !== '/admin') return next();
  response.writeHead(308, { Location: '/admin/' + (query ? '?' + query : '') });
  response.end();
};

export default defineConfig({
  plugins: [react(), {
    name: 'admin-directory',
    configureServer: server => { server.middlewares.use(redirectAdmin); },
    configurePreviewServer: server => { server.middlewares.use(redirectAdmin); },
  }],
  build: {
    rollupOptions: {
      input: {
        camera: resolve(import.meta.dirname, 'index.html'),
        admin: resolve(import.meta.dirname, 'admin/index.html'),
      },
    },
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api/': 'http://127.0.0.1:' + (process.env.API_PORT || '8081'),
      '/station.json': { target: 'http://127.0.0.1:' + (process.env.API_PORT || '8081'), rewrite: () => '/api/station' },
    },
  },
});
