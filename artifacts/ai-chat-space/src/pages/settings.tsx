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
  useAvailableModelsSource,
} from "@/components/chat/model-selector";
import { ReasoningSelector } from "@/components/chat/reasoning-selector";
import {
  loadSettings,
  pickAuditModel,
  saveSettings,
  type AppSettings,
} from "@/lib/settings";
import { Switch } from "@/components/ui/switch";
import { usePwaInstall } from "@/hooks/use-pwa-install";
import { useQueryClient } from "@tanstack/react-query";
import { getListOpenaiConversationsQueryKey } from "@workspace/api-client-react";
import { ProviderCredentialsSection } from "@/components/settings/provider-credentials-section";

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
  const modelSource = useAvailableModelsSource();
  const queryClient = useQueryClient();
  const { canInstall, installed, install } = usePwaInstall();
  const [settings, setSettings] = useState(loadSettings);
  const [wipeOpen, setWipeOpen] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [wipeError, setWipeError] = useState<string | null>(null);
  const [wipeDone, setWipeDone] = useState(false);
  const [installHint, setInstallHint] = useState<string | null>(null);

  // Google 連携 (Calendar / Gmail / Drive) の状態
  const [googleStatus, setGoogleStatus] = useState<{
    configured: boolean;
    connected: boolean;
    accountEmail: string | null;
  } | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleMessage, setGoogleMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE}/api/google/status`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setGoogleStatus(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleGoogleDisconnect = async () => {
    setGoogleBusy(true);
    setGoogleMessage(null);
    try {
      const res = await fetch(`${BASE}/api/google`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setGoogleStatus((prev) =>
        prev ? { ...prev, connected: false, accountEmail: null } : prev,
      );
      setGoogleMessage("Google連携を解除しました。");
    } catch (err) {
      setGoogleMessage(
        err instanceof Error ? err.message : "連携解除に失敗しました。",
      );
    } finally {
      setGoogleBusy(false);
    }
  };

  // Heal stale saved models only against the server-loaded catalog. The
  // bundled fallback list does not contain OpenRouter models; healing against
  // it used to overwrite the saved default on every visit (settings reset bug).
  useEffect(() => {
    if (modelSource !== "api") return;
    const patch: Partial<AppSettings> = {};
    if (
      models.length > 0 &&
      !models.some((m) => m.id === settings.defaultModel)
    ) {
      patch.defaultModel = models[0].id;
    }
    if (
      settings.auditModelId &&
      !models.some((m) => m.id === settings.auditModelId)
    ) {
      // The saved auditor is no longer offered (role-filtered list, retired
      // model): fall back to a valid cross-check model.
      patch.auditModelId = pickAuditModel(settings.defaultModel, models);
    }
    if (Object.keys(patch).length > 0) {
      setSettings(saveSettings(patch));
    }
  }, [models, modelSource, settings.defaultModel, settings.auditModelId]);

  const handleWipe = async () => {
    setWiping(true);
    setWipeError(null);
    try {
      const responses = await Promise.all(
        ["conversations", "memories"].map((resource) =>
          fetch(`${BASE}/api/openai/${resource}`, {
            method: "DELETE",
            credentials: "include",
          }),
        ),
      );
      const failed = responses.find(
        (response) => !response.ok && response.status !== 204,
      );
      if (failed) {
        throw new Error(`削除に失敗しました (HTTP ${failed.status})`);
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
            モデル、LLMプロバイダー、監査、インストール、保存データを一か所で管理します。
          </p>
        </div>

        <ProviderCredentialsSection />

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
              selectedModel={settings.auditModelId}
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
                ブラウザの共有メニューや「ホーム画面に追加」からインストールできます。Chrome
                / Edge / Safari に対応しています。
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
          title="Google 連携"
          description="Googleカレンダーの予定管理、Gmailの検索・閲覧、Googleドライブのファイル検索をチャットから行えるようにします。連携すると、チャットでAIが必要に応じてこれらのツールを利用します。"
        >
          {googleStatus === null ? (
            <p className="text-sm text-[var(--m3-on-surface-variant)]">
              Google連携の状態を取得しています...
            </p>
          ) : !googleStatus.configured ? (
            <p className="text-sm leading-relaxed text-[var(--m3-on-surface-variant)]">
              サーバー側でGoogle
              OAuthクライアントが設定されていません（GOOGLE_CLIENT_ID /
              GOOGLE_CLIENT_SECRET）。
            </p>
          ) : googleStatus.connected ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="flex h-9 w-9 items-center justify-center rounded-[var(--m3-shape-full)] bg-[var(--m3-primary-container)] text-[var(--m3-on-primary-container)]">
                  <Check className="h-4 w-4" />
                </span>
                <div>
                  <div className="font-medium">連携済み</div>
                  {googleStatus.accountEmail && (
                    <div className="text-xs text-[var(--m3-on-surface-variant)]">
                      {googleStatus.accountEmail}
                    </div>
                  )}
                </div>
              </div>
              <Button
                variant="outline"
                disabled={googleBusy}
                onClick={() => void handleGoogleDisconnect()}
              >
                連携を解除
              </Button>
            </div>
          ) : (
            <Button
              variant="tonal"
              disabled={googleBusy}
              onClick={() => {
                window.location.href = `${BASE}/api/google/auth`;
              }}
            >
              Googleアカウントと連携する
            </Button>
          )}
          {googleMessage && (
            <p className="text-xs text-[var(--m3-on-surface-variant)]">
              {googleMessage}
            </p>
          )}
        </SettingsSection>

        <SettingsSection
          title="開発環境"
          description="VPS上のコーディング用ワークスペースです。Tailnet内から開きます（ポートはホスト側に公開）。"
        >
          <div className="flex flex-wrap gap-2">
            <Button
              variant="tonal"
              onClick={() => {
                window.open(
                  `${window.location.protocol}//${window.location.hostname}:8091/`,
                  "_blank",
                  "noopener,noreferrer",
                );
              }}
            >
              ファイルブラウザ
            </Button>
            <Button
              variant="tonal"
              onClick={() => {
                window.open(
                  `${window.location.protocol}//${window.location.hostname}:4096/`,
                  "_blank",
                  "noopener,noreferrer",
                );
              }}
            >
              コーディング (OpenCode)
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-[var(--m3-on-surface-variant)]">
            ワークスペースは <code>code-workspace/</code>{" "}
            配下のプロジェクト一覧です。Basic
            auth（OpenCode）とfilebrowserのログイン情報はサーバー側の設定に従います。
          </p>
        </SettingsSection>

        <SettingsSection
          title="プライベートセッション"
          description="ナビゲーションの「プライベート」から始める会話はサーバーに保存されず、長期メモリの参照・保存も行いません。タブを閉じると履歴は消えます。通常の会話はアカウントに紐づいて残ります。"
        />

        <SettingsSection
          title="保存データの消去"
          description="このアカウントに保存されている会話、メッセージ、長期メモリをすべて削除します。元に戻せません。既定モデルの設定は端末に残ります。"
          destructive
        >
          <Button
            variant="destructive"
            className="gap-2"
            onClick={() => setWipeOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            会話と長期メモリを削除
          </Button>
          {wipeDone && (
            <p className="text-xs text-[var(--m3-on-surface-variant)]">
              会話と長期メモリを削除しました。
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
              保存データをすべて削除しますか？
            </AlertDialogTitle>
            <AlertDialogDescription>
              このアカウントの履歴、メッセージ、長期メモリが消えます。この操作は取り消せません。
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
