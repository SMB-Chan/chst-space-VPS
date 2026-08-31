import { lookup as dnsLookup } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";

/**
 * SSRF guard primitives shared by the plain-HTTP fetch path (web-search.ts)
 * and the headless-browser path (render-fetch.ts).  Both network paths must
 * enforce the SAME network policy — the browser path is not automatically
 * covered by the HTTP connector guard.
 */

/**
 * Deny-by-default IP classification using ipaddr.js.
 * Only globally routable unicast addresses are allowed. Blocks loopback,
 * unspecified, link-local, private/ULA, CGNAT, multicast, broadcast,
 * reserved, and any IPv6 form embedding an IPv4 address (mapped ::ffff:x,
 * IPv4-compatible ::/96, NAT64/rfc6052, 6to4, Teredo) after checking the
 * embedded IPv4. Unparseable input is blocked.
 */
export function isPrivateAddress(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return true;
  }
  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      return isPrivateAddress(v6.toIPv4Address().toString());
    }
    const parts = v6.parts;
    // IPv4-compatible addresses (::/96, e.g. ::127.0.0.1 or ::7f00:1)
    if (parts.slice(0, 6).every((p) => p === 0)) {
      const ipv4 = `${parts[6] >> 8}.${parts[6] & 0xff}.${parts[7] >> 8}.${parts[7] & 0xff}`;
      return isPrivateAddress(ipv4);
    }
    // NAT64 / rfc6052 (64:ff9b::/96) — embedded IPv4 in last 32 bits
    if (v6.range() === "rfc6052") {
      const ipv4 = `${parts[6] >> 8}.${parts[6] & 0xff}.${parts[7] >> 8}.${parts[7] & 0xff}`;
      return isPrivateAddress(ipv4);
    }
    // Everything not plain global unicast (loopback, linkLocal, uniqueLocal,
    // unspecified, multicast, 6to4, teredo, reserved, ...) is blocked.
    return v6.range() !== "unicast";
  }
  // IPv4: 'unicast' = globally routable; everything else
  // (private, loopback, linkLocal, carrierGradeNat, broadcast, multicast,
  // reserved, unspecified) is blocked.
  return addr.range() !== "unicast";
}

/**
 * Preflight SSRF check.  The DNS lookup here is raced against the caller's
 * AbortSignal so a stalled resolver cannot hold the request beyond the
 * configured deadline.
 */
export async function assertSafeUrl(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Blocked protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("Blocked URL containing credentials");
  }
  const host = url.hostname;
  if (isIP(host)) {
    if (isPrivateAddress(host))
      throw new Error(`Blocked private address: ${host}`);
    return url;
  }
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error(`Blocked host: ${host}`);
  }

  // Race the DNS lookup against the abort signal so a stalled resolver is
  // interrupted as soon as the overall fetch deadline fires.
  const lookupPromise = lookup(host, { all: true }).then((addrs) => {
    for (const { address } of addrs) {
      if (isPrivateAddress(address))
        throw new Error(`Blocked host resolving to private address: ${host}`);
    }
    return url;
  });

  if (!signal) return lookupPromise;

  // Wrap the signal into a rejecting promise so we can race it
  const abortPromise = new Promise<URL>((_, reject) => {
    if (signal.aborted) {
      reject(new Error("DNS lookup aborted"));
    } else {
      signal.addEventListener(
        "abort",
        () => reject(new Error("DNS lookup aborted")),
        { once: true },
      );
    }
  });

  return Promise.race([lookupPromise, abortPromise]);
}

/**
 * Connector-level DNS lookup for undici: the address actually connected to is
 * validated at lookup time, so DNS rebinding between a pre-flight check and
 * the real request cannot bypass the guard.
 */
export function createSafeDnsLookup(): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, options, (err, address, family) => {
      if (err) return callback(err, address as never, family as never);
      const addrs = Array.isArray(address)
        ? address.map((a) => (typeof a === "string" ? a : a.address))
        : [address];
      for (const a of addrs) {
        if (isPrivateAddress(a)) {
          return callback(
            new Error(`Blocked private address for host ${hostname}`),
            address as never,
            family as never,
          );
        }
      }
      callback(null, address as never, family as never);
    });
  };
}
