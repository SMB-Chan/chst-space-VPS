/**
 * Clerk Frontend API Proxy Middleware
 *
 * Proxies Clerk Frontend API requests through your domain, enabling Clerk
 * authentication on custom domains and .replit.app deployments without
 * requiring CNAME DNS configuration.
 */

import type { IncomingHttpHeaders } from 'http';
import type { RequestHandler } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

const CLERK_FAPI = 'https://frontend-api.clerk.dev';
export const CLERK_PROXY_PATH = '/api/__clerk';
/** Dynamic Clerk Frontend API responses should be tiny JSON documents. */
const MAX_BUFFERED_PROXY_BYTES = 5 * 1024 * 1024;

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(',')[0]?.trim() || undefined;
}

function normalizeHostname(value: string | undefined): string | undefined {
  const raw = firstHeaderValue(value);
  if (!raw) return undefined;
  try {
    const parsed = new URL(`http://${raw}`);
    if (parsed.username || parsed.password || !parsed.hostname) return undefined;
    return parsed.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return undefined;
  }
}

/**
 * The proxy origin is security-sensitive: do not derive it from forwarded
 * request headers. Operators must configure the complete canonical proxy URL.
 */
export function getConfiguredClerkProxyUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env.CLERK_PROXY_URL?.trim();
  if (!raw) return undefined;

  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }

    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    if (pathname !== CLERK_PROXY_PATH) return undefined;
    return `${parsed.origin}${CLERK_PROXY_PATH}`;
  } catch {
    return undefined;
  }
}

function addHostname(hosts: Set<string>, candidate: string | undefined): void {
  const hostname = normalizeHostname(candidate);
  if (hostname) hosts.add(hostname);
}

function addOriginHostname(hosts: Set<string>, candidate: string): void {
  try {
    const parsed = new URL(candidate.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    addHostname(hosts, parsed.host);
  } catch {
    // Invalid entries fail closed rather than widening the host allowlist.
  }
}

/**
 * Build the exact hostname allowlist accepted for dynamic Clerk publishable
 * keys. Every request-derived hostname remains untrusted until it matches this
 * configured set.
 */
export function getConfiguredClerkHosts(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const hosts = new Set<string>();

  for (const raw of (env.CLERK_ALLOWED_HOSTS ?? '').split(',')) {
    addHostname(hosts, raw.trim());
  }
  for (const raw of (env.REPLIT_DOMAINS ?? '').split(',')) {
    addHostname(hosts, raw.trim());
  }
  addHostname(hosts, env.REPLIT_DEV_DOMAIN);

  for (const raw of (env.FRONTEND_URL ?? '').split(',')) {
    if (raw.trim()) addOriginHostname(hosts, raw);
  }

  const proxyUrl = getConfiguredClerkProxyUrl(env);
  if (proxyUrl) addOriginHostname(hosts, proxyUrl);

  return hosts;
}

/**
 * Forwarded/Host headers are only selectors into a configured allowlist. A
 * spoofed value can therefore never introduce an arbitrary Clerk hostname.
 */
export function getAllowedClerkHost(
  req: { headers: IncomingHttpHeaders },
  allowedHosts: ReadonlySet<string>,
): string | undefined {
  if (allowedHosts.size === 0) return undefined;

  const candidates = [
    firstHeaderValue(req.headers['x-forwarded-host']),
    firstHeaderValue(req.headers.host),
  ];
  for (const candidate of candidates) {
    const hostname = normalizeHostname(candidate);
    if (hostname && allowedHosts.has(hostname)) return hostname;
  }
  return undefined;
}

/**
 * Build the browser-visible proxy URL only after the request host matches a
 * configured hostname. The scheme and path are invariant, so forwarded
 * protocol/host values can select a known deployment but cannot create a new
 * origin.
 */
export function getClerkProxyUrlForRequest(
  req: { headers: IncomingHttpHeaders },
  allowedHosts: ReadonlySet<string>,
): string | undefined {
  const hostname = getAllowedClerkHost(req, allowedHosts);
  return hostname ? `https://${hostname}${CLERK_PROXY_PATH}` : undefined;
}

export function clerkProxyMiddleware(): RequestHandler {
  if (process.env.NODE_ENV !== 'production') {
    return (_req, _res, next) => next();
  }

  const secretKey = process.env.CLERK_SECRET_KEY;
  const allowedHosts = getConfiguredClerkHosts();
  // A Clerk secret alone must not expose a trust-sensitive FAPI proxy. At
  // least one canonical deployment hostname must be configured. Replit's
  // REPLIT_DOMAINS supplies this contract automatically in deployments.
  if (!secretKey || allowedHosts.size === 0) {
    return (_req, _res, next) => next();
  }

  const proxyMiddleware = createProxyMiddleware({
    target: CLERK_FAPI,
    changeOrigin: true,
    selfHandleResponse: true,
    pathRewrite: (path: string) =>
      path.replace(new RegExp(`^${CLERK_PROXY_PATH}`), ''),
    on: {
      proxyReq: (proxyReq, req) => {
        const proxyUrl = getClerkProxyUrlForRequest(req, allowedHosts);
        // The outer guard applies the same synchronous lookup before the
        // proxy starts. Keep this check fail-closed if request state changes.
        if (!proxyUrl) {
          proxyReq.destroy();
          return;
        }

        proxyReq.setHeader('Clerk-Proxy-Url', proxyUrl);
        proxyReq.setHeader('Clerk-Secret-Key', secretKey);

        // Keep the existing Replit client-IP behavior until issue #46's edge
        // header contract is proven. Do not guess left/right proxy hops here.
        const clientIp =
          firstHeaderValue(req.headers['x-forwarded-for']) ||
          req.socket?.remoteAddress ||
          '';
        if (clientIp) proxyReq.setHeader('X-Forwarded-For', clientIp);
      },
      // Dynamic Frontend API responses without Content-Length must be buffered
      // so the deployment edge receives an explicit length instead of chunked
      // transfer encoding. Bound that buffer to prevent an upstream anomaly
      // from becoming an unbounded allocation in this process.
      proxyRes: (proxyRes, req, res) => {
        const headers = { ...proxyRes.headers };
        delete headers['transfer-encoding'];
        delete headers['connection'];
        delete headers['keep-alive'];

        const status = proxyRes.statusCode ?? 502;
        if (status < 200 || status === 204) delete headers['content-length'];

        const bodyless =
          req.method === 'HEAD' ||
          status < 200 ||
          status === 204 ||
          status === 304;
        if (headers['content-length'] !== undefined || bodyless) {
          res.writeHead(status, headers);
          proxyRes.on('error', () => res.destroy());
          proxyRes.pipe(res);
          return;
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let aborted = false;

        const failOversized = () => {
          if (aborted) return;
          aborted = true;
          proxyRes.destroy();
          if (!res.headersSent) {
            res.writeHead(502, { 'content-length': '0', 'cache-control': 'no-store' });
          }
          res.end();
        };

        proxyRes.on('data', (chunk: Buffer) => {
          if (aborted) return;
          totalBytes += chunk.length;
          if (totalBytes > MAX_BUFFERED_PROXY_BYTES) {
            failOversized();
            return;
          }
          chunks.push(chunk);
        });
        proxyRes.on('end', () => {
          if (aborted) return;
          const body = Buffer.concat(chunks, totalBytes);
          headers['content-length'] = String(body.length);
          res.writeHead(status, headers);
          res.end(body);
        });
        proxyRes.on('error', () => {
          if (aborted) return;
          if (!res.headersSent) {
            res.writeHead(502, { 'content-length': '0', 'cache-control': 'no-store' });
          }
          res.end();
        });
      },
    },
  }) as RequestHandler;

  return (req, res, next) => {
    if (!getClerkProxyUrlForRequest(req, allowedHosts)) return next();
    return proxyMiddleware(req, res, next);
  };
}
