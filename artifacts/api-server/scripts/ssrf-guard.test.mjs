// SSRF guard tests for src/lib/web-search.ts (isPrivateAddress).
// Run from artifacts/api-server: pnpm run test:ssrf
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".ssrf-test-bundle.mjs");
execSync(
  `pnpm exec esbuild src/lib/web-search.ts --bundle --format=esm --platform=node --packages=external --outfile=${out}`,
  { cwd: root, stdio: "pipe" }
);
const { isPrivateAddress } = await import(out);
const videoOut = join(root, ".ssrf-video-test-bundle.mjs");
execSync(
  `pnpm exec esbuild src/lib/alibaba-video.ts --bundle --format=esm --platform=node --packages=external --outfile=${videoOut}`,
  { cwd: root, stdio: "pipe" }
);
const { downloadHappyHorseVideoResult } = await import(videoOut);

const blocked = [
  // IPv4 loopback / private / link-local / CGNAT / unspecified / multicast
  "127.0.0.1", "10.0.0.5", "172.16.1.1", "192.168.1.1",
  "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
  // IPv6 loopback / unspecified / link-local / ULA
  "::1", "::", "fe80::1", "fd00::1",
  // IPv4-compatible IPv6 (::/96) embedding loopback
  "::127.0.0.1",
  // IPv4-mapped IPv6, hex and dotted forms, private and loopback
  "::ffff:7f00:1", "::ffff:127.0.0.1", "::ffff:192.168.1.1", "::ffff:10.0.0.1",
  // NAT64 / 6to4 embedding loopback
  "64:ff9b::7f00:1", "2002:7f00:0001::",
  // garbage
  "not-an-ip",
];
const allowed = [
  "8.8.8.8", "1.1.1.1", "93.184.216.34",
  "2606:4700:4700::1111", "2001:4860:4860::8888",
];

let failures = 0;
for (const ip of blocked) {
  if (!isPrivateAddress(ip)) { console.error("FAIL: should block", ip); failures++; }
}
for (const ip of allowed) {
  if (isPrivateAddress(ip)) { console.error("FAIL: should allow", ip); failures++; }
}
const noNetworkFetch = () => { throw new Error("network should not be reached"); };
for (const url of [
  "https://example.com/video.mp4",
  "http://dashscope-intl.aliyuncs.com/video.mp4",
  "https://user:pass@result.oss-cn-shenzhen.aliyuncs.com/video.mp4",
]) {
  try {
    await downloadHappyHorseVideoResult(url, undefined, noNetworkFetch);
    console.error("FAIL: should block untrusted video URL", url);
    failures++;
  } catch {
    // Expected: the allowlist rejects before fetch is called.
  }
}
execSync(`rm -f ${out} ${videoOut}`);
if (failures > 0) {
  console.error(`${failures} SSRF guard test(s) failed`);
  process.exit(1);
}
console.log(`All ${blocked.length + allowed.length} SSRF guard tests passed`);
