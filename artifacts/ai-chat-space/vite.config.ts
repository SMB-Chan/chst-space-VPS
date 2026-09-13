import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const rawPort = process.env.PORT ?? '5173';
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? '/';
const apiProxyTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:5000';

// Local-mode builds (VPS/Tailnet, AUTH_MODE=local) swap Clerk for a shim at
// bundle time so the same components build without Clerk keys or network.
const isLocalAuth = process.env.VITE_AUTH_MODE === 'local';
const localAuthShim = path.resolve(import.meta.dirname, 'src', 'local-auth-shim.tsx');

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
  const candidates = [...(process.env.VITE_ALLOWED_HOSTS ?? '').split(',')];
  return Array.from(
    new Set(
      candidates
        .map(normalizeAllowedHost)
        .filter((host): host is string => Boolean(host)),
    ),
  );
}

const allowedHosts = getAllowedHosts();

export default defineConfig({
  base: basePath,
  plugins: [react(), tailwindcss({ optimize: false })],
  define: {
    'import.meta.env.VITE_AUTH_MODE': JSON.stringify(
      process.env.VITE_AUTH_MODE ?? '',
    ),
  },
  resolve: {
    // Exact-match regexes: '@clerk/themes/shadcn.css' (imported by index.css)
    // must keep resolving to the real package for Tailwind.
    alias: [
      ...(isLocalAuth
        ? [
            { find: /^@clerk\/react$/, replacement: localAuthShim },
            { find: /^@clerk\/react\/internal$/, replacement: localAuthShim },
            { find: /^@clerk\/themes$/, replacement: localAuthShim },
          ]
        : []),
      { find: '@', replacement: path.resolve(import.meta.dirname, 'src') },
      {
        find: '@assets',
        replacement: path.resolve(import.meta.dirname, '..', '..', 'attached_assets'),
      },
    ],
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
        ws: true,
      },
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts,
  },
});
