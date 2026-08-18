import { useEffect, useState } from "react";
import { Download, Check, Trash2, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { ModelSelector, useAvailableModels } from "@/components/chat/model-selector";
import { ReasoningSelector } from "@/components/chat/reasoning-selector";
import { loadSettings, pickAuditModel, saveSettings } from "@/lib/settings";
import { Switch } from "@/components/ui/switch";
import { usePwaInstall } from "@/hooks/use-pwa-install";
import { useQueryClient } from "@tanstack/react-query";
import { getListOpenaiConversationsQueryKey } from "@workspace/api-client-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export function SettingsPage() {
  const models = useAvailableModels();
  const queryClient = useQueryClient();
  const { canInstall, installed, install } = usePwaInstall();
  const [settings, setSettings] = useState(loadSettings);
  const [wipeOpen, setWipeOpen] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [wipeError, setWipeError] = useState<string | null>(null);
  const [wipeDone, setWipeDone] = useState(false);
  const [installHint, setInstallHint] = useState<string | null>(null);

  useEffect(() => {
    const current = models.find((m) => m.id === settings.defaultModel);
    if (!current && models.length > 0) {
      const next = saveSettings({ defaultModel: models[0].id });
      setSettings(next);
    }
  }, [models, settings.defaultModel]);

  const handleWipe = async () => {
    setWiping(true);
    setWipeError(null);
    try {
      const res = await fetch(`${BASE}/api/openai/conversations`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`削除に失敗しました (HTTP ${res.status})`);
      }
      await queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
      setWipeDone(true);
      setWipeOpen(false);
    } catch (err) {
      setWipeError(err instanceof Error ? err.message : "削除に失敗しました。");
    } finally {
      setWiping(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-xl mx-auto px-5 py-10 space-y-10">
        <div>
          <h1 className="text-2xl font-serif font-medium tracking-tight mb-1">設定</h1>
          <p className="text-sm text-muted-foreground">既定のモデル、インストール、保存データの管理。</p>
        </div>

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-foreground">既定のモデル</h2>
          <p className="text-xs text-muted-foreground">
            新しい会話とプライベートセッションで最初に選ばれるモデルです。会話ごとの切替はチャット画面でできます。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <ModelSelector
              selectedModel={settings.defaultModel}
              onSelect={(id) => setSettings(saveSettings({ defaultModel: id }))}
            />
            <ReasoningSelector
              value={settings.defaultReasoning}
              onSelect={(level) => setSettings(saveSettings({ defaultReasoning: level }))}
            />
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-foreground">中立監査モード</h2>
          <p className="text-xs text-muted-foreground leading-relaxed">
            回答のあと、別モデルが会話履歴なしで本文を点検します。使用中のモデルがその指摘を読んで最終報告を書き直し、それを本文として出します。監査モデルは別の系統を指定してください。
          </p>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2">
            <span className="text-sm">監査を有効にする</span>
            <Switch
              checked={settings.auditEnabled}
              onCheckedChange={(checked) => setSettings(saveSettings({ auditEnabled: checked }))}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">監査モデル</span>
            <ModelSelector
              selectedModel={pickAuditModel(settings.defaultModel, models, settings.auditModelId)}
              onSelect={(id) => setSettings(saveSettings({ auditModelId: id }))}
              disabled={!settings.auditEnabled}
            />
            <ReasoningSelector
              value={settings.auditReasoning}
              onSelect={(level) => setSettings(saveSettings({ auditReasoning: level }))}
              disabled={!settings.auditEnabled}
            />
          </div>
          <p className="text-[11px] text-muted-foreground/80">
            監査の推論は既定でオフです。深く点検させたい場合だけ上げてください。
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-foreground">アプリとして使う</h2>
          <p className="text-xs text-muted-foreground">
            ホーム画面に追加すると、ブラウザの枠なしで開けます。オフライン時も画面の骨格は残ります（会話の送信には接続が必要です）。
          </p>
          {installed ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Check className="w-4 h-4 text-primary" />
              この端末ではすでにアプリとして開いています。
            </div>
          ) : canInstall ? (
            <Button
              onClick={async () => {
                const ok = await install();
                setInstallHint(ok ? "インストールを開始しました。" : "キャンセルされました。");
              }}
              className="gap-2"
            >
              <Download className="w-4 h-4" />
              ホーム画面に追加
            </Button>
          ) : (
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <Smartphone className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                ブラウザの共有メニューや「ホーム画面に追加」からインストールできます。Chrome / Edge / Safari に対応しています。
              </span>
            </div>
          )}
          {installHint && <p className="text-xs text-muted-foreground">{installHint}</p>}
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-foreground">プライベートセッション</h2>
          <p className="text-xs text-muted-foreground leading-relaxed">
            サイドバーの「プライベート」から始める会話はサーバーに保存されません。タブを閉じると履歴は消えます。
            通常の会話はアカウントに紐づいて残ります。
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-destructive">メモリの消去</h2>
          <p className="text-xs text-muted-foreground">
            このアカウントに保存されている会話とメッセージをすべて削除します。元に戻せません。既定モデルの設定は端末に残ります。
          </p>
          <Button variant="destructive" className="gap-2" onClick={() => setWipeOpen(true)}>
            <Trash2 className="w-4 h-4" />
            すべての会話を削除
          </Button>
          {wipeDone && <p className="text-xs text-muted-foreground">会話を削除しました。</p>}
          {wipeError && <p className="text-xs text-destructive">{wipeError}</p>}
        </section>
      </div>

      <AlertDialog open={wipeOpen} onOpenChange={setWipeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>保存済みの会話をすべて削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              このアカウントの履歴とメッセージが消えます。この操作は取り消せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={wiping}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleWipe();
              }}
              disabled={wiping}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {wiping ? "削除中..." : "すべて削除する"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
