import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
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
import { adminApi, type AdminProvider } from "./admin-api";

function renderKeyStatus(provider: AdminProvider): string {
  if (provider.keyHint) return provider.keyHint;
  if (provider.kind === "builtin" && provider.configured)
    return "サーバー環境変数";
  return "未設定";
}

interface ProvidersTabProps {
  /** Callback fired when model list references need invalidating. */
  onInvalidateModels: () => void;
}

export function ProvidersTab({ onInvalidateModels }: ProvidersTabProps) {
  const [providers, setProviders] = useState<AdminProvider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newBaseUrl, setNewBaseUrl] = useState("");
  const [newApiKey, setNewApiKey] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const [editFor, setEditFor] = useState<AdminProvider | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editApiKey, setEditApiKey] = useState("");

  const [deleteFor, setDeleteFor] = useState<AdminProvider | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const result = await adminApi.fetchProviders();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setProviders(result.value);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const customProviders = useMemo(
    () =>
      providers
        ? providers.filter((provider) => provider.kind === "custom")
        : [],
    [providers],
  );
  const builtinProviders = useMemo(
    () =>
      providers
        ? providers.filter((provider) => provider.kind === "builtin")
        : [],
    [providers],
  );

  const handleToggle = async (provider: AdminProvider, enabled: boolean) => {
    setBusy(true);
    const result = await adminApi.updateProvider(provider.id, { enabled });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await load();
    onInvalidateModels();
  };

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setFormError(null);
    const id = newId.trim();
    const label = newLabel.trim();
    const baseUrl = newBaseUrl.trim();
    if (!id || !label || !baseUrl) {
      setFormError("ID / 表示名 / ベースURL はすべて必須です。");
      return;
    }
    if (!newApiKey) {
      setFormError("APIキーを入力してください。");
      return;
    }
    setBusy(true);
    const result = await adminApi.createProvider({
      id,
      label,
      baseUrl,
      apiKey: newApiKey,
    });
    setBusy(false);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    setAddOpen(false);
    setNewId("");
    setNewLabel("");
    setNewBaseUrl("");
    setNewApiKey("");
    await load();
    onInvalidateModels();
  };

  const openEdit = (provider: AdminProvider) => {
    setEditFor(provider);
    setEditLabel(provider.label);
    setEditBaseUrl(provider.baseUrl ?? "");
    setEditApiKey("");
  };

  const handleEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editFor) return;
    setBusy(true);
    const result = await adminApi.updateProvider(editFor.id, {
      label: editLabel.trim() || undefined,
      baseUrl: editBaseUrl.trim() || undefined,
      apiKey: editApiKey ? editApiKey : undefined,
    });
    setBusy(false);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    setEditFor(null);
    setEditApiKey("");
    setFormError(null);
    await load();
    onInvalidateModels();
  };

  const handleDelete = async () => {
    if (!deleteFor) return;
    setBusy(true);
    const result = await adminApi.deleteProvider(deleteFor.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setDeleteFor(null);
    await load();
    onInvalidateModels();
  };

  const renderProviderRow = (provider: AdminProvider) => {
    const disabled = busy;
    return (
      <div
        key={provider.id}
        className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--m3-shape-sm)] border border-border/60 bg-card/40 p-3"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {provider.label}
            </span>
            <span
              className={
                provider.kind === "builtin"
                  ? "rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
                  : "rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary"
              }
            >
              {provider.kind === "builtin" ? "組み込み" : "カスタム"}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {provider.id}
            </span>
          </div>
          {provider.baseUrl ? (
            <p className="break-all text-xs text-muted-foreground">
              {provider.baseUrl}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            APIキー:{" "}
            <span className="font-mono">{renderKeyStatus(provider)}</span>
            {" ・ "}
            モデル数: <span className="font-mono">{provider.modelCount}</span>
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">有効</span>
            <Switch
              checked={provider.enabled}
              disabled={disabled}
              onCheckedChange={(checked) =>
                void handleToggle(provider, checked)
              }
              aria-label={`${provider.label} を${provider.enabled ? "無効化" : "有効化"}`}
            />
          </div>
          {provider.kind === "custom" ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => openEdit(provider)}
              >
                編集
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={disabled}
                onClick={() => setDeleteFor(provider)}
                className="gap-1.5"
              >
                <Trash2 className="h-3.5 w-3.5" />
                削除
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  if (providers === null && !error) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          LLM プロバイダーの一覧と有効状態を管理します。
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
          カスタムプロバイダーを追加
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
                ID（スラグ）
              </span>
              <input
                type="text"
                required
                value={newId}
                onChange={(event) => setNewId(event.target.value)}
                placeholder="例: my-custom-llm"
                className="h-9 w-full rounded-[var(--m3-shape-sm)] border border-border/60 bg-background px-2 font-mono text-sm text-foreground"
              />
            </label>
            <label className="block space-y-1 text-xs">
              <span className="font-medium text-muted-foreground">表示名</span>
              <input
                type="text"
                required
                value={newLabel}
                onChange={(event) => setNewLabel(event.target.value)}
                className="h-9 w-full rounded-[var(--m3-shape-sm)] border border-border/60 bg-background px-2 text-sm text-foreground"
              />
            </label>
            <label className="block space-y-1 text-xs sm:col-span-2">
              <span className="font-medium text-muted-foreground">
                ベースURL（OpenAI互換）
              </span>
              <input
                type="url"
                required
                value={newBaseUrl}
                onChange={(event) => setNewBaseUrl(event.target.value)}
                placeholder="https://api.example.com/v1"
                className="h-9 w-full rounded-[var(--m3-shape-sm)] border border-border/60 bg-background px-2 font-mono text-sm text-foreground"
              />
            </label>
            <label className="block space-y-1 text-xs sm:col-span-2">
              <span className="font-medium text-muted-foreground">APIキー</span>
              <input
                type="password"
                required
                autoComplete="off"
                value={newApiKey}
                onChange={(event) => setNewApiKey(event.target.value)}
                className="h-9 w-full rounded-[var(--m3-shape-sm)] border border-border/60 bg-background px-2 font-mono text-sm text-foreground"
              />
            </label>
          </div>
          {formError ? (
            <p className="text-xs text-destructive">{formError}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              追加
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

      {builtinProviders.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            組み込みプロバイダー
          </p>
          {builtinProviders.map(renderProviderRow)}
        </div>
      ) : null}

      {customProviders.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            カスタムプロバイダー
          </p>
          {customProviders.map(renderProviderRow)}
        </div>
      ) : null}

      {editFor ? (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            編集中: {editFor.label} ({editFor.id})
          </p>
          <form
            onSubmit={handleEdit}
            className="space-y-3 rounded-[var(--m3-shape-sm)] border border-border/60 bg-card/40 p-4"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1 text-xs">
                <span className="font-medium text-muted-foreground">
                  表示名
                </span>
                <input
                  type="text"
                  value={editLabel}
                  onChange={(event) => setEditLabel(event.target.value)}
                  className="h-9 w-full rounded-[var(--m3-shape-sm)] border border-border/60 bg-background px-2 text-sm text-foreground"
                />
              </label>
              <label className="block space-y-1 text-xs">
                <span className="font-medium text-muted-foreground">
                  ベースURL
                </span>
                <input
                  type="url"
                  value={editBaseUrl}
                  onChange={(event) => setEditBaseUrl(event.target.value)}
                  className="h-9 w-full rounded-[var(--m3-shape-sm)] border border-border/60 bg-background px-2 font-mono text-sm text-foreground"
                />
              </label>
              <label className="block space-y-1 text-xs sm:col-span-2">
                <span className="font-medium text-muted-foreground">
                  新しいAPIキー（空欄なら既存を維持）
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  value={editApiKey}
                  onChange={(event) => setEditApiKey(event.target.value)}
                  className="h-9 w-full rounded-[var(--m3-shape-sm)] border border-border/60 bg-background px-2 font-mono text-sm text-foreground"
                />
              </label>
            </div>
            {formError ? (
              <p className="text-xs text-destructive">{formError}</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy}>
                保存
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setEditFor(null);
                  setEditApiKey("");
                  setFormError(null);
                }}
              >
                キャンセル
              </Button>
            </div>
          </form>
        </div>
      ) : null}

      <AlertDialog
        open={deleteFor !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteFor(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteFor?.label} を削除しますか？
            </AlertDialogTitle>
            <AlertDialogDescription>
              このプロバイダーと配下のモデルを削除します。
            </AlertDialogDescription>
          </AlertDialogHeader>
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
