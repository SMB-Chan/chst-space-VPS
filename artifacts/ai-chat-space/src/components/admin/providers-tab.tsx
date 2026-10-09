import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRound, Loader2, Plus, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { providerKeyStatusLabel } from "./provider-key-status";

interface ProvidersTabProps {
  /** Callback fired when model list references need invalidating. */
  onInvalidateModels: () => void;
}

type Confirm =
  | { kind: "unlock"; provider: AdminProvider }
  | { kind: "softDelete"; provider: AdminProvider }
  | null;

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

  const [confirm, setConfirm] = useState<Confirm>(null);
  const [builtinKeyFor, setBuiltinKeyFor] = useState<AdminProvider | null>(
    null,
  );
  const [builtinKeyValue, setBuiltinKeyValue] = useState("");
  const [builtinKeyError, setBuiltinKeyError] = useState<string | null>(null);

  const [deletedOpen, setDeletedOpen] = useState(false);

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

  const visibleProviders = useMemo(
    () => (providers ? providers.filter((p) => !p.deleted) : []),
    [providers],
  );
  const deletedProviders = useMemo(
    () => (providers ? providers.filter((p) => p.deleted) : []),
    [providers],
  );
  const customProviders = useMemo(
    () => visibleProviders.filter((provider) => provider.kind === "custom"),
    [visibleProviders],
  );
  const builtinProviders = useMemo(
    () => visibleProviders.filter((provider) => provider.kind === "builtin"),
    [visibleProviders],
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

  const handleUnlock = async (provider: AdminProvider) => {
    setBusy(true);
    const result = await adminApi.deleteProviderKey(provider.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await load();
    onInvalidateModels();
  };

  const handleSoftDelete = async (provider: AdminProvider) => {
    setBusy(true);
    const result = await adminApi.deleteProvider(provider.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await load();
    onInvalidateModels();
  };

  const handleUseEnvKey = async (provider: AdminProvider) => {
    setBusy(true);
    const result = await adminApi.updateProvider(provider.id, {
      useEnvKey: true,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await load();
    onInvalidateModels();
  };

  const openBuiltinKey = (provider: AdminProvider) => {
    setBuiltinKeyFor(provider);
    setBuiltinKeyValue("");
    setBuiltinKeyError(null);
  };

  const submitBuiltinKey = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!builtinKeyFor) return;
    if (!builtinKeyValue) {
      setBuiltinKeyError("APIキーを入力してください。");
      return;
    }
    setBusy(true);
    const result = await adminApi.updateProvider(builtinKeyFor.id, {
      apiKey: builtinKeyValue,
    });
    setBusy(false);
    if (!result.ok) {
      setBuiltinKeyError(result.error);
      return;
    }
    setBuiltinKeyFor(null);
    setBuiltinKeyValue("");
    setBuiltinKeyError(null);
    await load();
    onInvalidateModels();
  };

  const handleRestore = async (provider: AdminProvider) => {
    setBusy(true);
    const result = await adminApi.restoreProvider(provider.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await load();
    onInvalidateModels();
  };

  const renderProviderRow = (provider: AdminProvider) => {
    const disabled = busy;
    const isBuiltin = provider.kind === "builtin";
    const showUnlock = provider.keySource !== "none";
    const showUseEnvKey =
      isBuiltin && !provider.useEnvKey && provider.envKeyPresent;
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
            <span className="font-mono">
              {providerKeyStatusLabel(provider)}
            </span>
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
          {isBuiltin ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => openBuiltinKey(provider)}
                className="gap-1.5"
              >
                <KeyRound className="h-3.5 w-3.5" />
                APIキーを設定
              </Button>
              {showUnlock ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => setConfirm({ kind: "unlock", provider })}
                >
                  キーを解除
                </Button>
              ) : null}
              {showUseEnvKey ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void handleUseEnvKey(provider)}
                >
                  環境変数のキーを使う
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={disabled}
                onClick={() => setConfirm({ kind: "softDelete", provider })}
                className="gap-1.5"
              >
                <Trash2 className="h-3.5 w-3.5" />
                削除
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {showUnlock ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => setConfirm({ kind: "unlock", provider })}
                >
                  キーを解除
                </Button>
              ) : null}
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
          )}
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

      {deletedProviders.length > 0 ? (
        <Collapsible
          open={deletedOpen}
          onOpenChange={setDeletedOpen}
          className="rounded-[var(--m3-shape-sm)] border border-border/60 bg-card/30"
        >
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <span>
                削除済みの組み込みプロバイダー ({deletedProviders.length})
              </span>
              <span className="text-[10px]">{deletedOpen ? "▲" : "▼"}</span>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 px-3 pb-3">
            {deletedProviders.map((provider) => (
              <div
                key={provider.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--m3-shape-sm)] border border-border/40 bg-background/40 p-2"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {provider.label}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {provider.id}
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    復元すると有効状態で再び表示されます。
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void handleRestore(provider)}
                  className="gap-1.5"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  復元
                </Button>
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
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
              このプロバイダーと配下のモデルを削除します。元に戻すことはできません。
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

      <AlertDialog
        open={confirm?.kind === "unlock"}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "unlock" ? confirm.provider.label : ""}{" "}
              のキーを解除しますか？
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "unlock" && confirm.provider.kind === "builtin"
                ? "管理画面のキーを削除し、サーバー環境変数のキーも使わなくなります。「環境変数のキーを使う」でいつでも戻せます。"
                : "保存済みのAPIキーを削除します。再度使うにはAPIキーを設定してください。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                const target =
                  confirm?.kind === "unlock" ? confirm.provider : null;
                setConfirm(null);
                if (target) void handleUnlock(target);
              }}
              disabled={busy}
              className="bg-[var(--m3-error)] text-[var(--m3-on-error)] hover:brightness-[0.96]"
            >
              キーを解除する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirm?.kind === "softDelete"}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "softDelete" ? confirm.provider.label : ""}{" "}
              を削除しますか？
            </AlertDialogTitle>
            <AlertDialogDescription>
              モデル一覧から非表示になり、全員が使えなくなります。下の「削除済みの組み込みプロバイダー」からいつでも復元できます。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                const target =
                  confirm?.kind === "softDelete" ? confirm.provider : null;
                setConfirm(null);
                if (target) void handleSoftDelete(target);
              }}
              disabled={busy}
              className="bg-[var(--m3-error)] text-[var(--m3-on-error)] hover:brightness-[0.96]"
            >
              削除する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={builtinKeyFor !== null}
        onOpenChange={(open) => {
          if (!open) {
            setBuiltinKeyFor(null);
            setBuiltinKeyValue("");
            setBuiltinKeyError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{builtinKeyFor?.label} のAPIキーを設定</DialogTitle>
            <DialogDescription>
              サーバー環境変数のキーより優先して使用されます。空欄にはできません。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitBuiltinKey} className="space-y-3">
            <label className="block space-y-1 text-xs">
              <span className="font-medium text-muted-foreground">
                新しいAPIキー
              </span>
              <input
                type="password"
                autoComplete="off"
                value={builtinKeyValue}
                onChange={(event) => setBuiltinKeyValue(event.target.value)}
                className="h-9 w-full rounded-[var(--m3-shape-sm)] border border-border/60 bg-background px-2 font-mono text-sm text-foreground"
              />
            </label>
            {builtinKeyError ? (
              <p className="text-xs text-destructive">{builtinKeyError}</p>
            ) : null}
            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setBuiltinKeyFor(null);
                  setBuiltinKeyValue("");
                  setBuiltinKeyError(null);
                }}
              >
                キャンセル
              </Button>
              <Button type="submit" disabled={busy}>
                保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
