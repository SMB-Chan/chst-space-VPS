import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

const rawPort = process.env.PORT ?? '5173';
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? '/';
const apiProxyTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:5000';

function normalizeAllowedHost(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (url.username || url.password || !url.hostname) return null;
    return url.hostname;
  } catch {
    return null;
  }
}

function getAllowedHosts(): string[] {
  const candidates = [
    process.env.REPLIT_DEV_DOMAIN ?? '',
    ...(process.env.REPLIT_DOMAINS ?? '').split(','),
    ...(process.env.VITE_ALLOWED_HOSTS ?? '').split(','),
  ];
  return Array.from(
    new Set(
      candidates
        .map(normalizeAllowedHost)
        .filter((host): host is string => Boolean(host)),
    ),
  );
}

// Vite's default still permits localhost/.localhost and IP literals. Replit's
// current dev/deployment hostnames are explicitly added from platform-provided
// environment variables instead of disabling host validation globally.
const allowedHosts = getAllowedHosts();

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss({ optimize: false }),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts,
    fs: {
      strict: true,
    },
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts,
  },
});
