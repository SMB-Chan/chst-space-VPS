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
import { adminApi, type AdminModel, type AdminProvider } from "./admin-api";

interface ModelsTabProps {
  /** Called when admin mutations should invalidate the model picker cache. */
  onInvalidateModels: () => void;
}

export function ModelsTab({ onInvalidateModels }: ModelsTabProps) {
  const [models, setModels] = useState<AdminModel[] | null>(null);
  const [providers, setProviders] = useState<AdminProvider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [newProviderId, setNewProviderId] = useState("");
  const [newModelId, setNewModelId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newSupportsVision, setNewSupportsVision] = useState(false);
  const [newSupportsReasoning, setNewSupportsReasoning] = useState(false);
  const [newUserVisible, setNewUserVisible] = useState(true);
  const [newEnabled, setNewEnabled] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);

  const [deleteFor, setDeleteFor] = useState<AdminModel | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const [modelsRes, providersRes] = await Promise.all([
      adminApi.fetchModels(),
      adminApi.fetchProviders(),
    ]);
    if (!modelsRes.ok) setError(modelsRes.error);
    if (!providersRes.ok) setError((prev) => prev ?? providersRes.error);
    if (modelsRes.ok) setModels(modelsRes.value);
    if (providersRes.ok) setProviders(providersRes.value);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    if (!models) return new Map<string, AdminModel[]>();
    const map = new Map<string, AdminModel[]>();
    for (const model of models) {
      const list = map.get(model.providerId) ?? [];
      list.push(model);
      map.set(model.providerId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.label.localeCompare(b.label);
      });
    }
    return map;
  }, [models]);

  const handlePatch = async (
    model: AdminModel,
    patch: Parameters<typeof adminApi.updateModel>[1],
  ) => {
    setBusy(true);
    const result = await adminApi.updateModel(model.id, patch);
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
    const id = newModelId.trim();
    const providerId = newProviderId;
    const label = newLabel.trim();
    if (!id || !providerId || !label) {
      setFormError("プロバイダー / モデルID / 表示名は必須です。");
      return;
    }
    setBusy(true);
    const result = await adminApi.createModel({
      id,
      providerId,
      label,
      description: newDescription.trim() || undefined,
      supportsVision: newSupportsVision,
      supportsReasoning: newSupportsReasoning,
      userVisible: newUserVisible,
      enabled: newEnabled,
    });
    setBusy(false);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    setAddOpen(false);
    setNewProviderId("");
    setNewModelId("");
    setNewLabel("");
    setNewDescription("");
    setNewSupportsVision(false);
    setNewSupportsReasoning(false);
    setNewUserVisible(true);
    setNewEnabled(true);
    await load();
    onInvalidateModels();
  };

  const handleDelete = async () => {
    if (!deleteFor) return;
    setBusy(true);
    const result = await adminApi.deleteModel(deleteFor.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setDeleteFor(null);
    await load();
    onInvalidateModels();
  };

  const renderBadges = (model: AdminModel) => {
    const badges: { label: string; tone: "default" | "accent" | "muted" }[] =
      [];
    if (model.supportsVision) badges.push({ label: "画像", tone: "accent" });
    if (model.supportsReasoning) badges.push({ label: "推論", tone: "accent" });
    if (model.builtin) badges.push({ label: "組み込み", tone: "muted" });
    if (badges.length === 0) return null;
    return (
      <div className="flex flex-wrap items-center gap-1">
        {badges.map((badge) => (
          <span
            key={badge.label}
            className={
              badge.tone === "accent"
                ? "rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                : "rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            }
          >
            {badge.label}
          </span>
        ))}
      </div>
    );
  };

  const renderModelRow = (model: AdminModel) => {
    return (
      <div
        key={model.id}
        className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--m3-shape-sm)] border border-border/60 bg-card/40 p-3"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {model.label}
            </span>
            {renderBadges(model)}
          </div>
          <p className="break-all font-mono text-xs text-muted-foreground">
            {model.id}
          </p>
          {model.description ? (
            <p className="text-xs text-muted-foreground">{model.description}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-muted-foreground">
            <label className="flex items-center gap-1.5">
              <Switch
                checked={model.enabled}
                disabled={busy}
                onCheckedChange={(checked) =>
                  void handlePatch(model, { enabled: checked })
                }
                aria-label={`${model.label} を${model.enabled ? "無効化" : "有効化"}`}
              />
              有効
            </label>
            <label className="flex items-center gap-1.5">
              <Switch
                checked={model.userVisible}
                disabled={busy}
                onCheckedChange={(checked) =>
                  void handlePatch(model, { userVisible: checked })
                }
                aria-label={`${model.label} の公開を${model.userVisible ? "非公開" : "公開"}`}
              />
              一般ユーザーに公開
            </label>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => setDeleteFor(model)}
            className="gap-1.5"
          >
            <Trash2 className="h-3.5 w-3.5" />
            削除
          </Button>
        </div>
      </div>
    );
  };

  if (models === null && !error) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const sortedProviders = providers
    ? [...providers].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "builtin" ? -1 : 1;
        return a.label.localeCompare(b.label);
      })
    : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          モデルごとの有効状態・公開範囲・機能を管理します。
        </p>
        <Button
          type="button"
          onClick={() => {
            setFormError(null);
            setNewProviderId(sortedProviders[0]?.id ?? "");
            setAddOpen((open) => !open);
          }}
          className="gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />
          モデルを追加
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
                プロバイダー
              </span>
              <select
                value={newProviderId}
                onChange={(event) => setNewProviderId(event.target.value)}
                required
                className="h-9 w-full rounded-[var(--m3-shape-sm)] border border-border/60 bg-background px-2 text-sm text-foreground"
              >
                <option value="">選択してください…</option>
                {sortedProviders.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1 text-xs">
              <span className="font-medium text-muted-foreground">
                モデルID
              </span>
              <input
                type="text"
                required
                value={newModelId}
                onChange={(event) => setNewModelId(event.target.value)}
                className="h-9 w-full rounded-[var(--m3-shape-sm)] border border-border/60 bg-background px-2 font-mono text-sm text-foreground"
              />
            </label>
            <label className="block space-y-1 text-xs sm:col-span-2">
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
                説明（省略可）
              </span>
              <input
                type="text"
                value={newDescription}
                onChange={(event) => setNewDescription(event.target.value)}
                className="h-9 w-full rounded-[var(--m3-shape-sm)] border border-border/60 bg-background px-2 text-sm text-foreground"
              />
            </label>
            <div className="sm:col-span-2 flex flex-wrap gap-3">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Switch
                  checked={newSupportsVision}
                  onCheckedChange={setNewSupportsVision}
                  aria-label="画像入力対応"
                />
                画像入力対応
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Switch
                  checked={newSupportsReasoning}
                  onCheckedChange={setNewSupportsReasoning}
                  aria-label="推論対応"
                />
                推論対応
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Switch
                  checked={newUserVisible}
                  onCheckedChange={setNewUserVisible}
                  aria-label="一般ユーザーに公開"
                />
                一般ユーザーに公開
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Switch
                  checked={newEnabled}
                  onCheckedChange={setNewEnabled}
                  aria-label="有効"
                />
                有効
              </label>
            </div>
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

      {providers && providers.length > 0
        ? providers.map((provider) => {
            const list = grouped.get(provider.id) ?? [];
            return (
              <div key={provider.id} className="space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {provider.label}
                  <span className="ml-2 font-mono text-[10px] normal-case text-muted-foreground/70">
                    {provider.id} ・ {list.length} 件
                  </span>
                </p>
                {list.length === 0 ? (
                  <p className="rounded-[var(--m3-shape-sm)] border border-border/40 bg-card/20 px-3 py-2 text-xs text-muted-foreground">
                    このプロバイダーに紐づくモデルはまだありません。
                  </p>
                ) : (
                  list.map(renderModelRow)
                )}
              </div>
            );
          })
        : null}

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
              {deleteFor?.builtin
                ? "組み込みモデルを削除しても、同じIDで追加し直すと復元できます。"
                : "この操作は取り消せません。"}
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
