import { useEffect, useState } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type RoleState = "loading" | "admin" | "user" | "signed-out";

/**
 * Reads the signed-in role from /api/openai/me and caches it in module-local
 * state so multiple consumers (admin nav, admin page, settings) don't all
 * re-fetch. Returns "loading" until the first response arrives; returns
 * "signed-out" when no session is present.
 */
let cachedRole: RoleState | null = null;
const listeners = new Set<(state: RoleState) => void>();
let inflight: Promise<void> | null = null;

function notify(next: RoleState) {
  cachedRole = next;
  for (const listener of listeners) listener(next);
}

function loadRole(): Promise<void> {
  if (inflight) return inflight;
  inflight = fetch(`${BASE}/api/openai/me`, { credentials: "include" })
    .then(async (res) => {
      if (res.status === 401 || res.status === 403) {
        notify("signed-out");
        return;
      }
      if (!res.ok) {
        notify("signed-out");
        return;
      }
      const data = (await res.json().catch(() => null)) as {
        role?: string;
      } | null;
      if (data?.role === "admin") {
        notify("admin");
      } else {
        notify("user");
      }
    })
    .catch(() => {
      notify("signed-out");
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Drop the cached role without refetching. Call on sign-out so a different
 * account signing in on the same tab (Clerk mode keeps the SPA alive) does
 * not inherit the previous user's admin navigation.
 */
export function resetRoleCache(): void {
  cachedRole = null;
}

export function invalidateRoleCache(): void {
  cachedRole = null;
  void loadRole();
}

export function useIsAdmin(): boolean {
  const [role, setRole] = useState<RoleState>(cachedRole ?? "loading");

  useEffect(() => {
    listeners.add(setRole);
    if (!cachedRole) {
      void loadRole();
    } else {
      setRole(cachedRole);
    }
    return () => {
      listeners.delete(setRole);
    };
  }, []);

  return role === "admin";
}

export function useRole(): RoleState {
  const [state, setLocal] = useState<RoleState>(cachedRole ?? "loading");
  useEffect(() => {
    listeners.add(setLocal);
    if (!cachedRole) {
      void loadRole();
    } else {
      setLocal(cachedRole);
    }
    return () => {
      listeners.delete(setLocal);
    };
  }, []);
  return state;
}
