import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import {
  isIP,
  connect as netConnect,
  type LookupFunction,
  type Socket,
} from "node:net";
import { logger, safeFailureFields } from "./logger";
import { createSafeDnsLookup, isPrivateAddress } from "./ssrf-guard";

const LISTEN_HOST = "127.0.0.1";
const UPSTREAM_TIMEOUT_MS = 30_000;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface BrowserEgressMetrics {
  httpRequests: number;
  connectTunnels: number;
  blockedTargets: number;
  upstreamErrors: number;
}

const metrics: BrowserEgressMetrics = {
  httpRequests: 0,
  connectTunnels: 0,
  blockedTargets: 0,
  upstreamErrors: 0,
};

export function getBrowserEgressMetrics(): BrowserEgressMetrics {
  return { ...metrics };
}

function normalizeHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase().replace(/\.$/, "");
  // WHATWG URL.hostname keeps IPv6 brackets in Node. net.connect/isIP expect
  // the bare literal, while the HTTP Host header continues to use target.host.
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  return host;
}

/**
 * Apply the non-DNS portion of the shared SSRF policy before opening a socket.
 * DNS results themselves are checked by createSafeDnsLookup() at the actual
 * connect call, so there is no validation-to-connect second lookup.
 */
export function assertAllowedBrowserProxyTarget(hostname: string): void {
  const host = normalizeHostname(hostname);
  if (!host) throw new Error("Blocked empty proxy target");
  if (isIP(host)) {
    if (isPrivateAddress(host))
      throw new Error(`Blocked private address: ${host}`);
    return;
  }
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error(`Blocked host: ${host}`);
  }
}

function isBlockedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Blocked private address") ||
    message.includes("Blocked host")
  );
}

function sanitizeHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) result[key] = value;
  }
  return result;
}

function failSocket(socket: Socket, status: 400 | 403 | 502): void {
  const text =
    status === 403
      ? "Forbidden"
      : status === 502
        ? "Bad Gateway"
        : "Bad Request";
  if (!socket.destroyed) {
    socket.end(
      `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
}

function parseConnectTarget(rawAuthority: string | undefined): {
  hostname: string;
  port: number;
} {
  if (!rawAuthority) throw new Error("Missing CONNECT target");
  const target = new URL(`http://${rawAuthority}`);
  if (target.username || target.password)
    throw new Error("Blocked CONNECT credentials");
  const port = Number(target.port || "443");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Invalid CONNECT port");
  }
  return { hostname: normalizeHostname(target.hostname), port };
}

export interface BrowserEgressProxy {
  server: string;
  close(): Promise<void>;
}

export interface BrowserEgressProxyOptions {
  /** Injection point for deterministic connection-boundary tests. */
  lookup?: LookupFunction;
}

/**
 * Start a loopback-only HTTP proxy. Chromium connects only to this proxy; the
 * proxy performs each destination connection with the safe DNS lookup function.
 */
export async function startBrowserEgressProxy(
  options: BrowserEgressProxyOptions = {},
): Promise<BrowserEgressProxy> {
  const safeLookup = options.lookup ?? createSafeDnsLookup();
  const sockets = new Set<Socket>();

  const server: Server = createServer((req, res) => {
    metrics.httpRequests += 1;
    let target: URL;
    let connectHost: string;
    try {
      if (!req.url) throw new Error("Missing proxy request URL");
      target = new URL(req.url);
      if (target.protocol !== "http:")
        throw new Error("Only HTTP absolute proxy requests are supported");
      if (target.username || target.password)
        throw new Error("Blocked proxy URL credentials");
      connectHost = normalizeHostname(target.hostname);
      assertAllowedBrowserProxyTarget(connectHost);
    } catch (error) {
      metrics.blockedTargets += 1;
      logger.warn(
        safeFailureFields(
          error,
          "browser-egress-proxy",
          "HTTP_TARGET_BLOCKED",
          403,
        ),
        "Blocked browser proxy HTTP target",
      );
      res.statusCode = 403;
      res.end();
      return;
    }

    const headers = sanitizeHeaders(req.headers);
    headers.host = target.host;
    const upstream = httpRequest(
      {
        protocol: "http:",
        hostname: connectHost,
        port: target.port ? Number(target.port) : 80,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
        lookup: safeLookup,
      },
      (upstreamResponse) => {
        res.writeHead(
          upstreamResponse.statusCode ?? 502,
          sanitizeHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(res);
      },
    );

    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () =>
      upstream.destroy(new Error("Browser proxy upstream timeout")),
    );
    upstream.on("error", (error) => {
      if (isBlockedError(error)) metrics.blockedTargets += 1;
      else metrics.upstreamErrors += 1;
      logger.warn(
        safeFailureFields(
          error,
          "browser-egress-proxy",
          "HTTP_UPSTREAM_FAILED",
          isBlockedError(error) ? 403 : 502,
        ),
        "Browser proxy HTTP upstream failed",
      );
      if (!res.headersSent) res.statusCode = isBlockedError(error) ? 403 : 502;
      res.end();
    });
    req.on("aborted", () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on("connect", (req, clientSocket, head) => {
    metrics.connectTunnels += 1;
    let target: { hostname: string; port: number };
    try {
      target = parseConnectTarget(req.url);
      assertAllowedBrowserProxyTarget(target.hostname);
    } catch (error) {
      metrics.blockedTargets += 1;
      logger.warn(
        safeFailureFields(
          error,
          "browser-egress-proxy",
          "CONNECT_TARGET_BLOCKED",
          403,
        ),
        "Blocked browser proxy CONNECT target",
      );
      failSocket(clientSocket as Socket, 403);
      return;
    }

    const upstream = netConnect({
      host: target.hostname,
      port: target.port,
      lookup: safeLookup,
    });
    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () =>
      upstream.destroy(new Error("Browser proxy CONNECT timeout")),
    );
    upstream.once("connect", () => {
      if (clientSocket.destroyed) {
        upstream.destroy();
        return;
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on("error", (error) => {
      if (isBlockedError(error)) metrics.blockedTargets += 1;
      else metrics.upstreamErrors += 1;
      logger.warn(
        safeFailureFields(
          error,
          "browser-egress-proxy",
          "CONNECT_UPSTREAM_FAILED",
          isBlockedError(error) ? 403 : 502,
        ),
        "Browser proxy CONNECT upstream failed",
      );
      failSocket(clientSocket as Socket, isBlockedError(error) ? 403 : 502);
    });
  });

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.requestTimeout = UPSTREAM_TIMEOUT_MS;
  server.headersTimeout = UPSTREAM_TIMEOUT_MS;
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, LISTEN_HOST);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Browser egress proxy did not bind to a TCP port");
  }
  const proxyUrl = `http://${LISTEN_HOST}:${address.port}`;
  logger.info(
    { proxyHost: LISTEN_HOST, proxyPort: address.port },
    "Browser egress proxy started",
  );

  return {
    server: proxyUrl,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let sharedProxyPromise: Promise<BrowserEgressProxy> | null = null;

export function getBrowserEgressProxy(): Promise<BrowserEgressProxy> {
  if (!sharedProxyPromise) {
    sharedProxyPromise = startBrowserEgressProxy();
    sharedProxyPromise.catch(() => {
      sharedProxyPromise = null;
    });
  }
  return sharedProxyPromise;
}

export async function closeBrowserEgressProxy(): Promise<void> {
  const pending = sharedProxyPromise;
  sharedProxyPromise = null;
  if (!pending) return;
  await pending.then((proxy) => proxy.close()).catch(() => undefined);
}
