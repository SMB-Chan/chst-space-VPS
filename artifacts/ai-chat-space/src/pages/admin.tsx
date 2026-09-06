import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface AdminUserRow {
  userId: string;
  role: "admin" | "user";
  month: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  budgetUsd: number | null;
  suspended: boolean;
  conversations: number;
  messages: number;
}

interface AdminOverview {
  month: string;
  defaultBudgetUsd: number;
  users: AdminUserRow[];
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function shortUserId(userId: string): string {
  return userId.length > 18 ? `${userId.slice(0, 15)}…` : userId;
}

export default function AdminPage() {
  const { isLoaded, userId } = useAuth();
  const [me, setMe] = useState<{ role: string } | null>(null);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState<Record<string, string>>({});

  const loadOverview = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`${BASE}/api/admin/overview`, {
        credentials: "include",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? "読み込みに失敗しました。");
        return;
      }
      setOverview((await res.json()) as AdminOverview);
    } catch {
      setError("読み込みに失敗しました。");
    }
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    fetch(`${BASE}/api/openai/me`, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) {
          setMe({ role: "denied" });
          return;
        }
        setMe((await res.json()) as { role: string });
      })
      .catch(() => setMe({ role: "denied" }));
  }, [isLoaded, userId]);

  useEffect(() => {
    if (me?.role === "admin") void loadOverview();
  }, [me, loadOverview]);

  const act = useCallback(
    async (action: () => Promise<Response>, reload = true) => {
      setBusy(true);
      try {
        const res = await action();
        if (!res.ok && res.status !== 204) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          setError(body?.error ?? "操作に失敗しました。");
        } else {
          setError(null);
          if (reload) await loadOverview();
        }
      } catch {
        setError("操作に失敗しました。");
      } finally {
        setBusy(false);
      }
    },
    [loadOverview],
  );

  if (!isLoaded || (me === null && !error)) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
      </div>
    );
  }

  if (me?.role !== "admin") {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background px-6 text-center">
        <p className="text-sm text-muted-foreground">
          このページは管理者のみアクセスできます。
        </p>
      </div>
    );
  }

  const users = overview?.users ?? [];

  return (
    <div className="min-h-[100dvh] bg-background">
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-serif text-foreground">
              管理者コンソール
            </h1>
            <p className="text-xs text-muted-foreground">
              {overview
                ? `${overview.month} の利用状況 ・ 一般ユーザーの既定上限 ${formatUsd(overview.defaultBudgetUsd)}／月`
                : "読み込み中…"}
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void loadOverview()}
            className="rounded-[var(--m3-shape-full)] border border-border/60 bg-card/50 px-4 py-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            更新
          </button>
        </div>

        {error ? (
          <div className="rounded-[var(--m3-shape-sm)] border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="space-y-3">
          {users.map((user) => {
            const usageRatio =
              user.budgetUsd && user.budgetUsd > 0
                ? Math.min(1, user.estimatedCostUsd / user.budgetUsd)
                : 0;
            return (
              <div
                key={user.userId}
                className="space-y-3 rounded-[var(--m3-shape-sm)] border border-border/60 bg-card/40 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm text-foreground">
                        {shortUserId(user.userId)}
                      </span>
                      <span
                        className={
                          user.role === "admin"
                            ? "rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary"
                            : "rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
                        }
                      >
                        {user.role === "admin" ? "管理者" : "一般"}
                      </span>
                      {user.suspended ? (
                        <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] text-destructive">
                          停止中
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      会話 {user.conversations} 件 ・ メッセージ {user.messages}{" "}
                      件 ・ トークン{" "}
                      {formatTokens(user.promptTokens + user.completionTokens)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium text-foreground">
                      {formatUsd(user.estimatedCostUsd)}
                      {user.budgetUsd !== null ? (
                        <span className="text-xs text-muted-foreground">
                          {" "}
                          / {formatUsd(user.budgetUsd)}
                        </span>
                      ) : null}
                    </p>
                    {user.budgetUsd !== null ? (
                      <div className="mt-1 h-1.5 w-32 overflow-hidden rounded-full bg-muted">
                        <div
                          className={
                            usageRatio >= 1
                              ? "h-full bg-destructive"
                              : usageRatio > 0.8
                                ? "h-full bg-amber-500"
                                : "h-full bg-primary"
                          }
                          style={{ width: `${Math.round(usageRatio * 100)}%` }}
                        />
                      </div>
                    ) : null}
                  </div>
                </div>

                {user.role === "user" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      placeholder={`${overview?.defaultBudgetUsd ?? 2}`}
                      value={budgetDraft[user.userId] ?? ""}
                      onChange={(event) =>
                        setBudgetDraft((prev) => ({
                          ...prev,
                          [user.userId]: event.target.value,
                        }))
                      }
                      className="h-9 w-28 rounded-[var(--m3-shape-xs)] border border-border/60 bg-background px-2 text-sm text-foreground"
                    />
                    <span className="text-xs text-muted-foreground">
                      $/月（空欄で既定値）
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void act(() => {
                          const raw = budgetDraft[user.userId]?.trim();
                          const parsed = raw ? Number(raw) : null;
                          return fetch(
                            `${BASE}/api/admin/users/${encodeURIComponent(user.userId)}/budget`,
                            {
                              method: "PUT",
                              credentials: "include",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                monthlyBudgetUsd:
                                  parsed === null || Number.isNaN(parsed)
                                    ? null
                                    : parsed,
                              }),
                            },
                          );
                        })
                      }
                      className="rounded-[var(--m3-shape-full)] bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50"
                    >
                      上限を保存
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          fetch(
                            `${BASE}/api/admin/users/${encodeURIComponent(user.userId)}/suspension`,
                            {
                              method: "PUT",
                              credentials: "include",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                suspended: !user.suspended,
                              }),
                            },
                          ),
                        )
                      }
                      className="rounded-[var(--m3-shape-full)] border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      {user.suspended ? "停止を解除" : "一時停止"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `${shortUserId(user.userId)} の会話・記憶・利用記録をすべて削除します。元に戻せません。よろしいですか？`,
                          )
                        )
                          return;
                        void act(() =>
                          fetch(
                            `${BASE}/api/admin/users/${encodeURIComponent(user.userId)}/data`,
                            {
                              method: "DELETE",
                              credentials: "include",
                            },
                          ),
                        );
                      }}
                      className="rounded-[var(--m3-shape-full)] border border-destructive/40 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    >
                      データを削除
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {users.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            ユーザーデータはまだありません。
          </p>
        ) : null}
      </div>
    </div>
  );
}
