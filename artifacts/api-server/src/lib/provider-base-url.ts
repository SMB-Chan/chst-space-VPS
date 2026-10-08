import { assertSafeUrl } from "./ssrf-guard";
import { requestUserContext } from "../middlewares/requireAuth";

/**
 * Per-user BYOK provider endpoints (settings screen) are fetched by the
 * server, so a general user must not be able to point them at the VPS's own
 * network (db, OpenCode, cloud metadata, Tailscale peers ...). Admins may
 * still use private endpoints such as a LAN/Tailscale LLM server.
 */
export class UnsafeProviderUrlError extends Error {}

const PUBLIC_MESSAGE =
  "接続先URLが不正です。http(s) の公開アドレスのみ指定できます（プライベートアドレスは管理者のみ）。";

export async function checkProviderBaseUrl(
  raw: string,
  opts: { allowPrivate: boolean; signal?: AbortSignal },
): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeProviderUrlError(PUBLIC_MESSAGE);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeProviderUrlError(PUBLIC_MESSAGE);
  }
  if (url.username || url.password) {
    throw new UnsafeProviderUrlError(PUBLIC_MESSAGE);
  }
  if (!opts.allowPrivate) {
    try {
      await assertSafeUrl(url.toString(), opts.signal);
    } catch {
      throw new UnsafeProviderUrlError(PUBLIC_MESSAGE);
    }
  }
  return url.toString().replace(/\/+$/, "");
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Wrap the fetch used by a user's BYOK client so every request re-checks the
 * target (the stored URL may have been saved before this check existed, or
 * its DNS may have changed since). Admin requests are not restricted.
 */
export function guardUserProviderFetch<F extends FetchLike>(inner: F): F {
  const guarded = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const isAdmin = requestUserContext.getStore()?.userRole === "admin";
    if (!isAdmin) {
      const target =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      await checkProviderBaseUrl(target, {
        allowPrivate: false,
        signal: init?.signal ?? undefined,
      });
    }
    return inner(input, init);
  };
  return guarded as F;
}
