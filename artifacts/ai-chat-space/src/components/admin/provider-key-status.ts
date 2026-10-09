import type { AdminProvider } from "./admin-api";

/**
 * Japanese label describing where the live API key for a provider comes from.
 * Mirrors the four cases spelled out in the admin UI spec:
 *   - "db"   : managed from the admin UI (optionally with a key hint suffix)
 *   - "env"  : coming from a server environment variable
 *   - none + builtin + envKeyPresent + !useEnvKey : env var exists but is unused
 *   - otherwise : no key configured
 */
export function providerKeyStatusLabel(p: AdminProvider): string {
  if (p.keySource === "db") {
    // keyHint already carries the leading "…" (e.g. "…abcd").
    return p.keyHint ? `管理画面で設定 (${p.keyHint})` : "管理画面で設定";
  }
  if (p.keySource === "env") {
    return "サーバー環境変数";
  }
  if (
    p.keySource === "none" &&
    p.kind === "builtin" &&
    p.envKeyPresent &&
    !p.useEnvKey
  ) {
    return "環境変数（未使用）";
  }
  return "未設定";
}
