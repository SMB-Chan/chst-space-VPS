import { type ReactNode, useEffect, useState } from "react";
import { useAuth, useClerk } from "@clerk/react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const USER_NOT_ALLOWED_CODE = "USER_NOT_ALLOWED";

type GateState = "checking" | "allowed" | "denied" | "offline";

/**
 * Server-side family/invite gate companion.
 *
 * requireAuth already enforces ALLOWED_CLERK_USER_IDS on every API call; this
 * gate turns a 403 (code USER_NOT_ALLOWED) into a clean full-screen notice
 * with a sign-out action instead of a broken chat UI. Transient failures and
 * unknown responses render the app normally — the server remains the
 * enforcement point.
 */
export function AccessGate({ children }: { children: ReactNode }) {
  const { userId, isLoaded } = useAuth();
  const clerk = useClerk();
  const [state, setState] = useState<GateState>("checking");

  useEffect(() => {
    if (!isLoaded) return;
    let cancelled = false;
    setState("checking");
    if (!userId) {
      // Clerk renders signed-out UI elsewhere; nothing to probe.
      setState("allowed");
      return;
    }
    fetch(`${BASE}/api/openai/me`, { credentials: "include" })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 403) {
          const body = (await res.json().catch(() => null)) as {
            code?: string;
          } | null;
          setState(body?.code === USER_NOT_ALLOWED_CODE ? "denied" : "allowed");
          return;
        }
        setState(res.ok ? "allowed" : "allowed");
      })
      .catch(() => {
        if (!cancelled) setState("offline");
      });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, userId]);

  if (state === "denied") {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background px-6 text-center">
        <div className="max-w-md space-y-4">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="h-6 w-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
              />
            </svg>
          </div>
          <h1 className="text-xl font-serif text-foreground">
            招待されたアカウントではありません
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            このサービスは現在、招待されたユーザーのみ利用できます。
            <br />
            家族に追加してもらうか、別のアカウントでサインインしてください。
          </p>
          <button
            type="button"
            onClick={() => void clerk.signOut()}
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--m3-shape-full)] bg-primary px-6 text-sm font-medium text-primary-foreground transition-[transform,background-color] duration-[var(--m3-duration-short)] ease-[var(--m3-motion-standard)] hover:opacity-90 active:scale-[0.99]"
          >
            サインアウト
          </button>
        </div>
      </div>
    );
  }

  if (state === "checking") {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background">
        <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
      </div>
    );
  }

  // "allowed" and transient "offline" both render the app; the server still
  // enforces the allowlist on every API call.
  return <>{children}</>;
}
