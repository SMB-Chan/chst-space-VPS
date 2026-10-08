import { useCallback, useEffect, useState } from "react";
import { Check, KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Surface } from "@/design-system/surface";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface AdminAuthMode {
  authMode: "local" | "clerk" | "password";
  user: { id: string; username: string } | null;
}

export function PasswordChangeSection() {
  const [authMode, setAuthMode] = useState<AdminAuthMode["authMode"] | null>(
    null,
  );
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE}/api/auth/me`, { credentials: "include" })
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const body = (await res.json()) as AdminAuthMode;
        if (!cancelled) setAuthMode(body.authMode);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const isVisible = authMode === "password";

  const reset = useCallback(() => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setSuccess(false);
    if (newPassword.length < 8) {
      setError("新しいパスワードは8文字以上で入力してください。");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("確認用パスワードが一致しません。");
      return;
    }
    if (newPassword === currentPassword) {
      setError(
        "新しいパスワードは現在のパスワードと異なるものを指定してください。",
      );
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${BASE}/api/auth/password`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? "パスワード変更に失敗しました。");
        setBusy(false);
        return;
      }
      setSuccess(true);
      reset();
    } catch {
      setError("パスワード変更に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  if (!isVisible) return null;

  return (
    <Surface
      tone="low"
      shape="extraLarge"
      className="space-y-4 border border-[var(--m3-outline-variant)] p-5 shadow-[var(--m3-elevation-1)] sm:p-6"
    >
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-primary" />
          <h2 className="text-base font-semibold tracking-tight">
            パスワード変更
          </h2>
        </div>
        <p className="text-sm leading-relaxed text-[var(--m3-on-surface-variant)]">
          アカウントのパスワードを更新します。変更後は他の端末のセッションも自動的にサインアウトされます。
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3" autoComplete="off">
        <label className="block space-y-1 text-xs">
          <span className="font-medium text-muted-foreground">
            現在のパスワード
          </span>
          <Input
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </label>
        <label className="block space-y-1 text-xs">
          <span className="font-medium text-muted-foreground">
            新しいパスワード（8文字以上）
          </span>
          <Input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </label>
        <label className="block space-y-1 text-xs">
          <span className="font-medium text-muted-foreground">
            新しいパスワード（確認）
          </span>
          <Input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </label>
        {error ? (
          <p className="text-xs text-[var(--m3-error)]">{error}</p>
        ) : null}
        {success ? (
          <p className="flex items-center gap-1 text-xs text-[var(--m3-primary)]">
            <Check className="h-3.5 w-3.5" />
            パスワードを更新しました。
          </p>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" disabled={busy} onClick={reset}>
            クリア
          </Button>
          <Button type="submit" disabled={busy} className="gap-1.5">
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <KeyRound className="h-3.5 w-3.5" />
            )}
            パスワードを更新
          </Button>
        </div>
      </form>
    </Surface>
  );
}
