import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createTcpServer, connect as netConnect, type LookupFunction } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAllowedBrowserProxyTarget,
  startBrowserEgressProxy,
  type BrowserEgressProxy,
} from "./browser-egress-proxy";

const openProxies: BrowserEgressProxy[] = [];

afterEach(async () => {
  await Promise.all(openProxies.splice(0).map((proxy) => proxy.close()));
});

function proxyHttpRequest(proxyUrl: string, targetUrl: string): Promise<{ status: number; body: string }> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: proxy.hostname,
        port: Number(proxy.port),
        method: "GET",
        path: targetUrl,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function proxyConnect(proxyUrl: string, authority: string, payload?: string): Promise<string> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: proxy.hostname, port: Number(proxy.port) });
    let received = "";
    let payloadSent = false;
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      received += chunk;
      if (
        payload &&
        !payloadSent &&
        received.includes("200 Connection Established")
      ) {
        payloadSent = true;
        socket.write(payload);
      }
      if (
        received.includes("403 Forbidden") ||
        received.includes("502 Bad Gateway") ||
        (payload && received.includes(payload))
      ) {
        socket.end();
      }
    });
    socket.on("end", () => resolve(received));
    socket.on("error", reject);
  });
}

function respondLookup(
  callback: Parameters<LookupFunction>[2],
  options: Parameters<LookupFunction>[1],
  address: string,
): void {
  if (typeof options === "object" && options !== null && "all" in options && options.all) {
    callback(null, [{ address, family: 4 }] as never, undefined as never);
    return;
  }
  callback(null, address as never, 4 as never);
}

function localLookup(onLookup?: (hostname: string) => void): LookupFunction {
  return (hostname, options, callback) => {
    onLookup?.(hostname);
    respondLookup(callback, options, "127.0.0.1");
  };
}

function blockedLookup(onLookup?: (hostname: string) => void): LookupFunction {
  return (hostname, _options, callback) => {
    onLookup?.(hostname);
    callback(
      new Error(`Blocked private address for host ${hostname}`),
      undefined as never,
      undefined as never,
    );
  };
}

describe("browser egress proxy target policy", () => {
  it("allows global literals and rejects private/special targets", () => {
    expect(() => assertAllowedBrowserProxyTarget("8.8.8.8")).not.toThrow();
    expect(() => assertAllowedBrowserProxyTarget("example.com")).not.toThrow();
    for (const host of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "::1",
      "localhost",
      "foo.localhost",
      "printer.local",
      "db.internal",
    ]) {
      expect(() => assertAllowedBrowserProxyTarget(host), host).toThrow();
    }
  });

  it("blocks private literal HTTP targets before any upstream connection", async () => {
    const proxy = await startBrowserEgressProxy();
    openProxies.push(proxy);
    const response = await proxyHttpRequest(proxy.server, "http://127.0.0.1:6553/private");
    expect(response.status).toBe(403);
  });

  it("blocks private literal CONNECT targets", async () => {
    const proxy = await startBrowserEgressProxy();
    openProxies.push(proxy);
    const response = await proxyConnect(proxy.server, "127.0.0.1:443");
    expect(response).toContain("403 Forbidden");
  });

  it("treats a private result from the actual HTTP connect lookup as blocked", async () => {
    const seen = vi.fn();
    const proxy = await startBrowserEgressProxy({ lookup: blockedLookup(seen) });
    openProxies.push(proxy);
    const response = await proxyHttpRequest(proxy.server, "http://rebind.example/resource");
    expect(response.status).toBe(403);
    expect(seen).toHaveBeenCalledWith("rebind.example");
  });

  it("treats a private result from the actual CONNECT lookup as blocked", async () => {
    const seen = vi.fn();
    const proxy = await startBrowserEgressProxy({ lookup: blockedLookup(seen) });
    openProxies.push(proxy);
    const response = await proxyConnect(proxy.server, "rebind.example:443");
    expect(response).toContain("403 Forbidden");
    expect(seen).toHaveBeenCalledWith("rebind.example");
  });

  it("uses the injected connect lookup for HTTP forwarding", async () => {
    const upstream = createHttpServer((_req, res) => res.end("through-proxy"));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");

    const seen = vi.fn();
    const proxy = await startBrowserEgressProxy({ lookup: localLookup(seen) });
    openProxies.push(proxy);
    try {
      const response = await proxyHttpRequest(
        proxy.server,
        `http://public-test.example:${address.port}/hello`,
      );
      expect(response).toEqual({ status: 200, body: "through-proxy" });
      expect(seen).toHaveBeenCalledWith("public-test.example");
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("uses the injected connect lookup for CONNECT tunnels", async () => {
    const upstream = createTcpServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("TCP test server did not bind");

    const seen = vi.fn();
    const proxy = await startBrowserEgressProxy({ lookup: localLookup(seen) });
    openProxies.push(proxy);
    try {
      const response = await proxyConnect(
        proxy.server,
        `public-tunnel.example:${address.port}`,
        "tunnel-ok",
      );
      expect(response).toContain("200 Connection Established");
      expect(response).toContain("tunnel-ok");
      expect(seen).toHaveBeenCalledWith("public-tunnel.example");
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
