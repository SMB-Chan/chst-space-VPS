import { useEffect, useState, type ReactNode } from "react";
import { Download, Check, Trash2, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Surface } from "@/design-system/surface";
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
import {
  ModelSelector,
  useAvailableModels,
} from "@/components/chat/model-selector";
import { ReasoningSelector } from "@/components/chat/reasoning-selector";
import { loadSettings, pickAuditModel, saveSettings } from "@/lib/settings";
import { Switch } from "@/components/ui/switch";
import { usePwaInstall } from "@/hooks/use-pwa-install";
import { useQueryClient } from "@tanstack/react-query";
import { getListOpenaiConversationsQueryKey } from "@workspace/api-client-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function SettingsSection({
  title,
  description,
  destructive = false,
  children,
}: {
  title: string;
  description: string;
  destructive?: boolean;
  children?: ReactNode;
}) {
  return (
    <Surface
      tone="low"
      shape="extraLarge"
      className="space-y-4 border border-[var(--m3-outline-variant)] p-5 shadow-[var(--m3-elevation-1)] sm:p-6"
    >
      <div className="space-y-1.5">
        <h2
          className={
            destructive
              ? "text-base font-semibold text-[var(--m3-error)]"
              : "text-base font-semibold tracking-tight"
          }
        >
          {title}
        </h2>
        <p className="text-sm leading-relaxed text-[var(--m3-on-surface-variant)]">
          {description}
        </p>
      </div>
      {children}
    </Surface>
  );
}

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
      await queryClient.invalidateQueries({
        queryKey: getListOpenaiConversationsQueryKey(),
      });
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
      <div className="mx-auto max-w-2xl space-y-5 px-4 py-8 sm:px-6 sm:py-10">
        <div className="mb-7 px-1">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--m3-primary)]">
            Preferences
          </p>
          <h1 className="text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
            設定
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-[var(--m3-on-surface-variant)]">
            モデル、監査、インストール、保存データを一か所で管理します。
          </p>
        </div>

        <SettingsSection
          title="既定のモデル"
          description="新しい会話とプライベートセッションで最初に選ばれるモデルです。会話ごとの切替はチャット画面でできます。"
        >
          <div className="flex flex-wrap items-center gap-2">
            <ModelSelector
              selectedModel={settings.defaultModel}
              onSelect={(id) => setSettings(saveSettings({ defaultModel: id }))}
            />
            <ReasoningSelector
              value={settings.defaultReasoning}
              onSelect={(level) =>
                setSettings(saveSettings({ defaultReasoning: level }))
              }
            />
          </div>
        </SettingsSection>

        <SettingsSection
          title="中立監査モード"
          description="回答後に別モデルが会話履歴なしで本文を点検し、使用中のモデルが指摘を踏まえて最終報告を書き直します。監査モデルは別系統を指定してください。"
        >
          <Surface
            tone="container"
            shape="large"
            className="flex items-center justify-between gap-4 px-4 py-3.5"
          >
            <div>
              <div className="text-sm font-medium">監査を有効にする</div>
              <div className="mt-0.5 text-xs text-[var(--m3-on-surface-variant)]">
                回答の生成後に自動で検証します
              </div>
            </div>
            <Switch
              checked={settings.auditEnabled}
              onCheckedChange={(checked) =>
                setSettings(saveSettings({ auditEnabled: checked }))
              }
            />
          </Surface>

          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-xs font-medium text-[var(--m3-on-surface-variant)]">
              監査モデル
            </span>
            <ModelSelector
              selectedModel={pickAuditModel(
                settings.defaultModel,
                models,
                settings.auditModelId,
              )}
              onSelect={(id) => setSettings(saveSettings({ auditModelId: id }))}
              disabled={!settings.auditEnabled}
            />
            <ReasoningSelector
              value={settings.auditReasoning}
              onSelect={(level) =>
                setSettings(saveSettings({ auditReasoning: level }))
              }
              disabled={!settings.auditEnabled}
            />
          </div>
          <p className="text-xs leading-relaxed text-[var(--m3-on-surface-variant)]">
            監査の推論は既定でオフです。深く点検させたい場合だけ上げてください。
          </p>
        </SettingsSection>

        <SettingsSection
          title="アプリとして使う"
          description="ホーム画面に追加するとブラウザの枠なしで開けます。オフライン時も画面の骨格は残りますが、会話の送信には接続が必要です。"
        >
          {installed ? (
            <div className="flex items-center gap-2 text-sm text-[var(--m3-on-surface-variant)]">
              <span className="flex h-9 w-9 items-center justify-center rounded-[var(--m3-shape-full)] bg-[var(--m3-primary-container)] text-[var(--m3-on-primary-container)]">
                <Check className="h-4 w-4" />
              </span>
              この端末ではすでにアプリとして開いています。
            </div>
          ) : canInstall ? (
            <Button
              variant="tonal"
              onClick={async () => {
                const ok = await install();
                setInstallHint(
                  ok
                    ? "インストールを開始しました。"
                    : "キャンセルされました。",
                );
              }}
              className="gap-2"
            >
              <Download className="h-4 w-4" />
              ホーム画面に追加
            </Button>
          ) : (
            <div className="flex items-start gap-3 text-sm leading-relaxed text-[var(--m3-on-surface-variant)]">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--m3-shape-lg)] bg-[var(--m3-secondary-container)] text-[var(--m3-on-secondary-container)]">
                <Smartphone className="h-4 w-4" />
              </span>
              <span>
                ブラウザの共有メニューや「ホーム画面に追加」からインストールできます。Chrome / Edge / Safari に対応しています。
              </span>
            </div>
          )}
          {installHint && (
            <p className="text-xs text-[var(--m3-on-surface-variant)]">
              {installHint}
            </p>
          )}
        </SettingsSection>

        <SettingsSection
          title="プライベートセッション"
          description="ナビゲーションの「プライベート」から始める会話はサーバーに保存されません。タブを閉じると履歴は消えます。通常の会話はアカウントに紐づいて残ります。"
        />

        <SettingsSection
          title="メモリの消去"
          description="このアカウントに保存されている会話とメッセージをすべて削除します。元に戻せません。既定モデルの設定は端末に残ります。"
          destructive
        >
          <Button
            variant="destructive"
            className="gap-2"
            onClick={() => setWipeOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            すべての会話を削除
          </Button>
          {wipeDone && (
            <p className="text-xs text-[var(--m3-on-surface-variant)]">
              会話を削除しました。
            </p>
          )}
          {wipeError && (
            <p className="text-xs text-[var(--m3-error)]">{wipeError}</p>
          )}
        </SettingsSection>
      </div>

      <AlertDialog open={wipeOpen} onOpenChange={setWipeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              保存済みの会話をすべて削除しますか？
            </AlertDialogTitle>
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
              className="bg-[var(--m3-error)] text-[var(--m3-on-error)] hover:brightness-[0.96]"
            >
              {wiping ? "削除中..." : "すべて削除する"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
