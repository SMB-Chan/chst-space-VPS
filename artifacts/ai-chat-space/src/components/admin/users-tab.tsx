import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { adminApi, type AdminAccount, type AdminAuthMode } from "./admin-api";

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tokyo",
  }).format(date);
}

interface UsersTabProps {
  currentUserId: string | null;
}

export function UsersTab({ currentUserId }: UsersTabProps) {
  const [me, setMe] = useState<AdminAuthMode | null>(null);
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "user">("user");
  const [formError, setFormError] = useState<string | null>(null);

  const [pendingDelete, setPendingDelete] = useState<AdminAccount | null>(null);
  const [purgeData, setPurgeData] = useState(false);

  const [pwResetFor, setPwResetFor] = useState<AdminAccount | null>(null);
  const [pwResetValue, setPwResetValue] = useState("");

  const load = useCallback(async () => {
    setError(null);
    const [meRes, acctsRes] = await Promise.all([
      adminApi.fetchMe(),
      adminApi.fetchAccounts(),
    ]);
    if (meRes.ok) {
      setMe(meRes.value);
    } else {
      setError(meRes.error);
      return;
    }
    if (acctsRes.ok) {
      setAccounts(acctsRes.value.accounts);
    } else {
      setError(acctsRes.error);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const isSelf = useCallback(
    (account: AdminAccount) =>
      currentUserId !== null && account.id === currentUserId,
    [currentUserId],
  );

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setFormError(null);
    const trimmedUsername = newUsername.trim();
    if (!trimmedUsername) {
      setFormError("ユーザー名を入力してください。");
      return;
    }
    if (newPassword.length < 8) {
      setFormError("初期パスワードは8文字以上で指定してください。");
      return;
    }
    setBusy(true);
    const result = await adminApi.createAccount({
      username: trimmedUsername,
      displayName: newDisplayName.trim() || undefined,
      password: newPassword,
      role: newRole,
    });
    setBusy(false);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    setAddOpen(false);
    setNewUsername("");
    setNewDisplayName("");
    setNewPassword("");
    setNewRole("user");
    await load();
  };

  const toggleRole = async (account: AdminAccount) => {
    if (isSelf(account)) return;
    const next: "admin" | "user" = account.role === "admin" ? "user" : "admin";
    setBusy(true);
    const result = await adminApi.updateAccount(account.id, { role: next });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await load();
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    const result = await adminApi.deleteAccount(pendingDelete.id, purgeData);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPendingDelete(null);
    await load();
  };

  const handleResetPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!pwResetFor || pwResetValue.length < 8) return;
    setBusy(true);
    const result = await adminApi.updateAccount(pwResetFor.id, {
      password: pwResetValue,
    });
    setBusy(false);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    setPwResetFor(null);
    setPwResetValue("");
    setFormError(null);
    await load();
  };

  const isPasswordMode = me?.authMode === "password";

  const sorted = useMemo(() => {
    if (!accounts) return [];
    return [...accounts].sort((a, b) => {
      if (a.role !== b.role) return a.role === "admin" ? -1 : 1;
      return a.username.localeCompare(b.username);
    });
  }, [accounts]);

  if (!me && !error) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (me && !isPasswordMode) {
    return (
      <div className="rounded-[var(--m3-shape-sm)] border border-border/60 bg-card/40 p-4 text-sm text-muted-foreground">
        ユーザーの追加・削除はパスワード認証モード（AUTH_MODE=password）で利用できます。
        現在は <span className="font-mono">{me.authMode}</span> モードです。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          登録済みユーザーの一覧と権限変更を行います。
        </p>
        <Button
          type="button"
          onClick={() => {
            setFormError(null);
            setAddOpen((open) => !open);
          }}
          className="gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />
          ユーザーを追加
        </Button>
      </div>

      {error ? (
        <div className="rounded-[var(--m3-shape-sm)] border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {addOpen ? (
        <form
          onSubmit={handleAdd}
          className="space-y-3 rounded-[var(--m3-shape-sm)] border border-border/60 bg-card/40 p-4"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1 text-xs">
              <span className="font-medium text-muted-foreground">
                ユーザー名
              </span>
              <input
                type="text"
                required
                value={newUsername}
                onChange={(event) => setNewUsername(event.target.value)}
                className="h-9 w-full rounded-[var(--m3-shape-sm)] border border-border/60 bg-background px-2 text-sm text-foreground"
              />
            </label>
            <label className="block space-y-1 text-xs">
              <span className="font-medium text-muted-foreground">
                表示名（省略可）
              </span>
              <input
                type="text"
                value={newDisplayName}
                onChange={(event) => setNewDisplayName(event.target.value)}
                className="h-9 w-full rounded-[var(--m3-shape-sm)] border border-border/60 bg-background px-2 text-sm text-foreground"
              />
            </label>
            <label className="block space-y-1 text-xs">
              <span className="font-medium text-muted-foreground">
                初期パスワード
              </span>
              <input
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                className="h-9 w-full rounded-[var(--m3-shape-sm)] border border-border/60 bg-background px-2 text-sm text-foreground"
              />
            </label>
            <label className="block space-y-1 text-xs">
              <span className="font-medium text-muted-foreground">役割</span>
              <select
                value={newRole}
                onChange={(event) =>
                  setNewRole(event.target.value === "admin" ? "admin" : "user")
                }
                className="h-9 w-full rounded-[var(--m3-shape-sm)] border border-border/60 bg-background px-2 text-sm text-foreground"
              >
                <option value="user">一般</option>
                <option value="admin">管理者</option>
              </select>
            </label>
          </div>
          {formError ? (
            <p className="text-xs text-destructive">{formError}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              ユーザーを作成
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAddOpen(false)}
              disabled={busy}
            >
              キャンセル
            </Button>
          </div>
        </form>
      ) : null}

      <div className="space-y-2">
        {sorted.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            ユーザーはまだ登録されていません。
          </p>
        ) : (
          sorted.map((account) => {
            const self = isSelf(account);
            return (
              <div
                key={account.id}
                className="space-y-2 rounded-[var(--m3-shape-sm)] border border-border/60 bg-card/40 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {account.displayName || account.username}
                      </span>
                      <span
                        className={
                          account.role === "admin"
                            ? "rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary"
                            : "rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
                        }
                      >
                        {account.role === "admin" ? "管理者" : "一般"}
                      </span>
                      {self ? (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                          あなた
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      @{account.username} ・ 作成{" "}
                      {formatDate(account.createdAt)} ・ 最終ログイン{" "}
                      {formatDate(account.lastLoginAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy || self}
                      onClick={() => toggleRole(account)}
                    >
                      {account.role === "admin" ? "一般に変更" : "管理者に昇格"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setFormError(null);
                        setPwResetValue("");
                        setPwResetFor(account);
                      }}
                    >
                      パスワード再設定
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={busy || self}
                      onClick={() => {
                        setPurgeData(false);
                        setPendingDelete(account);
                      }}
                      className="gap-1.5"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      削除
                    </Button>
                  </div>
                </div>
                {pwResetFor?.id === account.id ? (
                  <form
                    onSubmit={handleResetPassword}
                    className="flex flex-wrap items-end gap-2 rounded-[var(--m3-shape-xs)] border border-border/40 bg-background/40 p-2"
                  >
                    <label className="block flex-1 space-y-1 text-xs">
                      <span className="font-medium text-muted-foreground">
                        新しいパスワード（8文字以上）
                      </span>
                      <input
                        type="password"
                        required
                        minLength={8}
                        autoComplete="new-password"
                        value={pwResetValue}
                        onChange={(event) =>
                          setPwResetValue(event.target.value)
                        }
                        className="h-9 w-full rounded-[var(--m3-shape-sm)] border border-border/60 bg-background px-2 text-sm text-foreground"
                      />
                    </label>
                    <Button
                      type="submit"
                      size="sm"
                      disabled={busy || pwResetValue.length < 8}
                    >
                      保存
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setPwResetFor(null);
                        setPwResetValue("");
                        setFormError(null);
                      }}
                    >
                      キャンセル
                    </Button>
                    {formError ? (
                      <span className="text-xs text-destructive">
                        {formError}
                      </span>
                    ) : null}
                  </form>
                ) : null}
                {self ? (
                  <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <AlertTriangle className="h-3 w-3" />
                    自分自身のアカウントは削除・降格できません。
                  </p>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDelete?.displayName || pendingDelete?.username}{" "}
              を削除しますか？
            </AlertDialogTitle>
            <AlertDialogDescription>
              ログインできなくなり、登録済みのAPIキーとセッションも削除されます。この操作は取り消せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded-[var(--m3-shape-sm)] border border-border/60 bg-background/40 p-3 text-sm",
            )}
          >
            <Switch
              checked={purgeData}
              onCheckedChange={setPurgeData}
              className="mt-0.5"
            />
            <span>
              <span className="block font-medium">
                会話などのデータも削除する
              </span>
              <span className="block text-xs text-muted-foreground">
                オフの場合、会話などのデータはデータベースに残ります（画面からは参照できません）。
              </span>
            </span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
              disabled={busy}
              className="bg-[var(--m3-error)] text-[var(--m3-on-error)] hover:brightness-[0.96]"
            >
              削除する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
