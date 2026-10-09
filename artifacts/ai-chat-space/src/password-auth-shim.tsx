import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

// Build-time replacement for @clerk/react / @clerk/themes on multi-user
// deployments (AUTH_MODE=password). vite.config.ts aliases the Clerk modules
// here so the same components build without Clerk keys. The backend handles
// username/password authentication, session cookies, and role checks; this
// shim wraps the Clerk-shaped surface the rest of the app already speaks.

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface PasswordAuthUser {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
}

export interface PasswordAuthState {
  isLoaded: boolean;
  isSignedIn: boolean;
  user: PasswordAuthUser | null;
}

export interface PasswordAuthContextValue extends PasswordAuthState {
  refresh: () => Promise<void>;
  signIn: (input: { username: string; password: string }) => Promise<{
    error?: string;
  }>;
  changePassword: (input: {
    currentPassword: string;
    newPassword: string;
  }) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
}

const PasswordAuthContext = createContext<PasswordAuthContextValue | null>(
  null,
);

function readJsonError<T>(raw: unknown): T | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as { error?: unknown };
  if (typeof candidate.error === "string") {
    return { error: candidate.error } as unknown as T;
  }
  return null;
}

interface ProviderInnerProps {
  children: ReactNode;
}

function PasswordAuthProviderInner({ children }: ProviderInnerProps) {
  const [state, setState] = useState<PasswordAuthState>({
    isLoaded: false,
    isSignedIn: false,
    user: null,
  });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/auth/me`, {
        credentials: "include",
      });
      if (!res.ok) {
        setState({
          isLoaded: true,
          isSignedIn: false,
          user: null,
        });
        return;
      }
      const data = (await res.json().catch(() => null)) as {
        authMode?: string;
        user?: PasswordAuthUser | null;
      } | null;
      const user =
        data && data.authMode === "password" && data.user ? data.user : null;
      setState({
        isLoaded: true,
        isSignedIn: user !== null,
        user,
      });
    } catch {
      setState({
        isLoaded: true,
        isSignedIn: false,
        user: null,
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(
    async ({ username, password }: { username: string; password: string }) => {
      try {
        const res = await fetch(`${BASE}/api/auth/login`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        if (!res.ok) {
          const body = readJsonError<{ error: string }>(
            await res.json().catch(() => null),
          );
          return {
            error: body?.error ?? "ログインに失敗しました。",
          };
        }
        await refresh();
        return {};
      } catch {
        return { error: "ログインに失敗しました。" };
      }
    },
    [refresh],
  );

  const changePassword = useCallback(
    async ({
      currentPassword,
      newPassword,
    }: {
      currentPassword: string;
      newPassword: string;
    }) => {
      try {
        const res = await fetch(`${BASE}/api/auth/password`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentPassword, newPassword }),
        });
        if (!res.ok) {
          const body = readJsonError<{ error: string }>(
            await res.json().catch(() => null),
          );
          return {
            error: body?.error ?? "パスワード変更に失敗しました。",
          };
        }
        await refresh();
        return {};
      } catch {
        return { error: "パスワード変更に失敗しました。" };
      }
    },
    [refresh],
  );

  const signOutAction = useCallback(async () => {
    try {
      await fetch(`${BASE}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } finally {
      await refresh();
    }
  }, [refresh]);

  const value = useMemo<PasswordAuthContextValue>(
    () => ({
      isLoaded: state.isLoaded,
      isSignedIn: state.isSignedIn,
      user: state.user,
      refresh,
      signIn,
      changePassword,
      signOut: signOutAction,
    }),
    [state, refresh, signIn, changePassword, signOutAction],
  );

  return (
    <PasswordAuthContext.Provider value={value}>
      {children}
    </PasswordAuthContext.Provider>
  );
}

interface ClerkProviderProps {
  children: ReactNode;
  // The shim ignores most Clerk props, but accepts them for parity.
  [key: string]: unknown;
}

export function ClerkProvider({ children }: ClerkProviderProps) {
  // Children render immediately; consumers handle their own loading states.
  // This matches Clerk behaviour sufficiently for the rest of the app.
  return <PasswordAuthProviderInner>{children}</PasswordAuthProviderInner>;
}

function usePasswordAuth(): PasswordAuthContextValue {
  const ctx = useContext(PasswordAuthContext);
  if (!ctx) {
    throw new Error(
      "useAuth/useUser は <ClerkProvider> の内側で利用してください。",
    );
  }
  return ctx;
}

export function useAuth() {
  const ctx = usePasswordAuth();
  return {
    isLoaded: ctx.isLoaded,
    isSignedIn: ctx.isSignedIn,
    userId: ctx.user?.id ?? null,
  };
}

export function useUser() {
  const ctx = usePasswordAuth();
  const user = ctx.user
    ? {
        id: ctx.user.id,
        firstName: ctx.user.displayName || ctx.user.username,
        fullName: ctx.user.displayName || ctx.user.username,
        imageUrl: "",
        primaryEmailAddress: { emailAddress: ctx.user.username },
      }
    : null;
  return { isLoaded: ctx.isLoaded, isSignedIn: user !== null, user };
}

export function useClerk() {
  const ctx = usePasswordAuth();
  // Stable addListener ref so consumers don't get torn down between renders.
  const listenersRef = useRef<Set<(payload: { user: unknown | null }) => void>>(
    new Set(),
  );
  const lastUserIdRef = useRef<string | null>(ctx.user?.id ?? null);
  const lastUserId = ctx.user?.id ?? null;

  // Notify listeners when the signed-in user changes (mirrors Clerk's contract).
  useEffect(() => {
    if (lastUserIdRef.current === lastUserId) return;
    lastUserIdRef.current = lastUserId;
    for (const listener of listenersRef.current) {
      listener({ user: ctx.user });
    }
  }, [lastUserId, ctx.user]);

  return useMemo(
    () => ({
      signOut: async (opts?: { redirectUrl?: string }) => {
        await ctx.signOut();
        const target = opts?.redirectUrl || BASE || "/";
        window.location.assign(target);
      },
      addListener: (cb: (payload: { user: unknown | null }) => void) => {
        listenersRef.current.add(cb);
        // Fire once on subscribe so the consumer learns the initial state.
        cb({ user: ctx.user });
        return () => {
          listenersRef.current.delete(cb);
        };
      },
      openSignIn: () => {
        window.location.assign(`${BASE}/sign-in`);
      },
    }),
    [ctx],
  );
}

export function Show({
  when,
  children,
}: {
  when: "signed-in" | "signed-out";
  children: ReactNode;
}) {
  const ctx = usePasswordAuth();
  const shouldRender =
    when === "signed-in" ? ctx.isSignedIn : ctx.isLoaded && !ctx.isSignedIn;
  return shouldRender ? <>{children}</> : null;
}

type SignInButtonProps = {
  loading?: boolean;
  /**
   * Inside the sign-in <form> this MUST be "submit": a type="button" with no
   * onClick does nothing on tap and also disables Enter-to-submit (a form
   * with several fields only submits implicitly when it has a submit button).
   */
  type?: "button" | "submit";
  onClick?: () => void;
  children: ReactNode;
  className?: string;
};

function SignInButton({
  loading,
  type = "button",
  onClick,
  children,
  className,
}: SignInButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={loading}
      className={
        className ??
        "inline-flex min-h-11 w-full items-center justify-center rounded-[var(--m3-shape-full)] bg-[var(--m3-primary)] px-6 text-sm font-medium text-[var(--m3-on-primary)] transition-[transform,background-color] duration-[var(--m3-duration-short)] hover:brightness-[0.96] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
      }
    >
      {children}
    </button>
  );
}

export interface SignInProps {
  routing?: "path" | "hash" | "virtual";
  path?: string;
  signUpUrl?: string;
}

export function SignIn(_props: SignInProps) {
  const ctx = usePasswordAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    const result = await ctx.signIn({ username, password });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    window.location.assign(`${BASE}/chat`);
  };

  return (
    <div className="w-full max-w-[420px] rounded-[28px] border border-[var(--m3-outline-variant)] bg-[var(--m3-surface-container-low)]/90 p-8 shadow-[var(--m3-elevation-2)] backdrop-blur-2xl">
      <div className="space-y-1.5 text-center">
        <h2 className="text-xl font-serif tracking-tight">サインイン</h2>
        <p className="text-xs text-[var(--m3-on-surface-variant)]">
          アカウント名とパスワードを入力してください
        </p>
      </div>
      <form
        onSubmit={handleSubmit}
        className="mt-6 space-y-4"
        autoComplete="off"
      >
        <div className="space-y-1.5">
          <label
            htmlFor="password-auth-username"
            className="text-sm font-medium"
          >
            ユーザー名
          </label>
          <input
            id="password-auth-username"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
            className="m3-focus-ring h-11 w-full rounded-[var(--m3-shape-md)] border border-[var(--m3-outline-variant)] bg-[var(--m3-surface-container-lowest)] px-3 text-sm text-[var(--m3-on-surface)] outline-none focus-visible:border-[var(--m3-primary)]"
          />
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="password-auth-password"
            className="text-sm font-medium"
          >
            パスワード
          </label>
          <input
            id="password-auth-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            className="m3-focus-ring h-11 w-full rounded-[var(--m3-shape-md)] border border-[var(--m3-outline-variant)] bg-[var(--m3-surface-container-lowest)] px-3 text-sm text-[var(--m3-on-surface)] outline-none focus-visible:border-[var(--m3-primary)]"
          />
        </div>
        {error ? (
          <p
            role="alert"
            className="rounded-[var(--m3-shape-sm)] border border-[var(--m3-error)]/40 bg-[var(--m3-error-container)]/40 px-3 py-2 text-xs text-[var(--m3-error)]"
          >
            {error}
          </p>
        ) : null}
        <SignInButton type="submit" loading={busy}>
          {busy ? "ログイン中..." : "ログイン"}
        </SignInButton>
      </form>
    </div>
  );
}

export interface SignUpProps {
  routing?: "path" | "hash" | "virtual";
  path?: string;
  signInUrl?: string;
}

export function SignUp({ signInUrl }: SignUpProps) {
  return (
    <div className="w-full max-w-[420px] rounded-[28px] border border-[var(--m3-outline-variant)] bg-[var(--m3-surface-container-low)]/90 p-8 text-center shadow-[var(--m3-elevation-2)] backdrop-blur-2xl">
      <div className="space-y-2">
        <h2 className="text-xl font-serif tracking-tight">新規登録</h2>
        <p className="text-sm text-[var(--m3-on-surface-variant)]">
          アカウントは管理者が作成します。管理者に依頼してください。
        </p>
      </div>
      <a
        href={signInUrl ?? `${BASE}/sign-in`}
        className="mt-6 inline-flex min-h-11 items-center justify-center rounded-[var(--m3-shape-full)] border border-[var(--m3-outline-variant)] px-6 text-sm font-medium text-[var(--m3-primary)] hover:bg-[var(--m3-surface-container)]"
      >
        サインインへ戻る
      </a>
    </div>
  );
}

// Required by some Clerk-themed imports; the password mode never uses it.
export const shadcn = {};

export function publishableKeyFromHost(): string {
  // The shim doesn't need a key; everything is API-driven.
  return "";
}
