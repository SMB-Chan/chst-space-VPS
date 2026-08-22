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

export function getClerkProxyHost(req: {
  headers: IncomingHttpHeaders;
}): string | undefined {
  const forwarded = req.headers['x-forwarded-host'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const firstHop = raw?.split(',')[0]?.trim();
  return firstHop || req.headers.host?.trim() || undefined;
}

function getForwardedProtocol(headers: IncomingHttpHeaders): 'http' | 'https' {
  const forwarded = headers['x-forwarded-proto'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = raw?.split(',')[0]?.trim().toLowerCase();
  return first === 'http' ? 'http' : 'https';
}

export function clerkProxyMiddleware(): RequestHandler {
  if (process.env.NODE_ENV !== 'production') {
    return (_req, _res, next) => next();
  }

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    return (_req, _res, next) => next();
  }

  return createProxyMiddleware({
    target: CLERK_FAPI,
    changeOrigin: true,
    selfHandleResponse: true,
    pathRewrite: (path: string) =>
      path.replace(new RegExp(`^${CLERK_PROXY_PATH}`), ''),
    on: {
      proxyReq: (proxyReq, req) => {
        const protocol = getForwardedProtocol(req.headers);
        const host = getClerkProxyHost(req) || '';
        const proxyUrl = `${protocol}://${host}${CLERK_PROXY_PATH}`;

        proxyReq.setHeader('Clerk-Proxy-Url', proxyUrl);
        proxyReq.setHeader('Clerk-Secret-Key', secretKey);

        const xff = req.headers['x-forwarded-for'];
        const clientIp =
          (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim() ||
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
}
