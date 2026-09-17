import { useCallback, useEffect, useState } from "react";
import { Check, ExternalLink, Loader2, Plug, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Surface } from "@/design-system/surface";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type ProviderId = "openai" | "dashscope" | "openrouter" | "xiaomi";

interface ProviderSummary {
  provider: ProviderId;
  label: string;
  configured: boolean;
  source: "user" | "env" | "none";
  keyHint: string | null;
  baseUrl: string | null;
  updatedAt: string | null;
}

const PROVIDER_DOCS: Record<ProviderId, { name: string; url: string }> = {
  openai: {
    name: "OpenAI / Command Code",
    url: "https://platform.openai.com/api-keys",
  },
  dashscope: {
    name: "DashScope",
    url: "https://bailian.console.aliyun.com/?apiKey=1",
  },
  openrouter: {
    name: "OpenRouter",
    url: "https://openrouter.ai/keys",
  },
  xiaomi: {
    name: "Xiaomi MiMo",
    url: "https://xiaomimimo.com",
  },
};

function SourceBadge({ source }: { source: ProviderSummary["source"] }) {
  if (source === "user") {
    return (
      <span className="rounded-full bg-[var(--m3-primary-container)] px-2 py-0.5 text-[10px] font-medium text-[var(--m3-on-primary-container)]">
        個人キー
      </span>
    );
  }
  if (source === "env") {
    return (
      <span className="rounded-full bg-[var(--m3-secondary-container)] px-2 py-0.5 text-[10px] font-medium text-[var(--m3-on-secondary-container)]">
        サーバー既定
      </span>
    );
  }
  return (
    <span className="rounded-full bg-[var(--m3-surface-container-high)] px-2 py-0.5 text-[10px] font-medium text-[var(--m3-on-surface-variant)]">
      未設定
    </span>
  );
}

export function ProviderCredentialsSection() {
  const [providers, setProviders] = useState<ProviderSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyProvider, setBusyProvider] = useState<ProviderId | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProviderId | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [draftBaseUrl, setDraftBaseUrl] = useState("");

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(`${BASE}/api/openai/providers`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { providers: ProviderSummary[] };
      setProviders(data.providers);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "読み込みに失敗しました。",
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startEdit = (provider: ProviderId, current?: ProviderSummary) => {
    setEditing(provider);
    setDraftKey("");
    setDraftBaseUrl(current?.baseUrl ?? "");
    setMessage(null);
  };

  const handleSave = async (provider: ProviderId) => {
    setBusyProvider(provider);
    setMessage(null);
    try {
      const testRes = await fetch(`${BASE}/api/openai/providers/${provider}/test`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: draftKey,
          baseUrl: draftBaseUrl || null,
        }),
      });
      if (!testRes.ok) {
        const data = (await testRes.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error || `接続確認に失敗しました (HTTP ${testRes.status})`);
      }

      const putRes = await fetch(`${BASE}/api/openai/providers/${provider}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: draftKey,
          baseUrl: draftBaseUrl || null,
        }),
      });
      if (!putRes.ok) {
        const data = (await putRes.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error || "保存に失敗しました。");
      }

      setMessage(`${PROVIDER_DOCS[provider].name} のAPIキーを保存しました。`);
      setEditing(null);
      setDraftKey("");
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setBusyProvider(null);
    }
  };

  const handleDelete = async (provider: ProviderId) => {
    setBusyProvider(provider);
    setMessage(null);
    try {
      const res = await fetch(`${BASE}/api/openai/providers/${provider}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`削除に失敗しました (HTTP ${res.status})`);
      }
      setMessage(`${PROVIDER_DOCS[provider].name} の個人キーを削除しました。`);
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "削除に失敗しました。");
    } finally {
      setBusyProvider(null);
    }
  };

  if (loadError) {
    return (
      <Surface
        tone="low"
        shape="extraLarge"
        className="space-y-3 border border-[var(--m3-outline-variant)] p-5 sm:p-6"
      >
        <h2 className="text-base font-semibold tracking-tight">
          LLMプロバイダー
        </h2>
        <p className="text-sm text-[var(--m3-error)]">{loadError}</p>
        <Button variant="outline" onClick={() => void refresh()}>
          再試行
        </Button>
      </Surface>
    );
  }

  return (
    <Surface
      tone="low"
      shape="extraLarge"
      className="space-y-4 border border-[var(--m3-outline-variant)] p-5 shadow-[var(--m3-elevation-1)] sm:p-6"
    >
      <div className="space-y-1.5">
        <h2 className="text-base font-semibold tracking-tight">
          LLMプロバイダー
        </h2>
        <p className="text-sm leading-relaxed text-[var(--m3-on-surface-variant)]">
          APIキーを設定画面から追加できます。保存するとサーバー側で暗号化され、そのプロバイダーのモデルが即座に使えます。サーバー既定のキーがある場合はそちらが優先されます（個人キーがある場合は個人キーを優先）。
        </p>
      </div>

      {!providers ? (
        <div className="flex items-center gap-2 text-sm text-[var(--m3-on-surface-variant)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          プロバイダー設定を読み込み中...
        </div>
      ) : (
        <div className="space-y-3">
          {providers.map((item) => {
            const docs = PROVIDER_DOCS[item.provider];
            const isEditing = editing === item.provider;
            const busy = busyProvider === item.provider;
            return (
              <div
                key={item.provider}
                className="space-y-3 rounded-[var(--m3-shape-lg)] border border-[var(--m3-outline-variant)] bg-[var(--m3-surface-container-low)] p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{item.label}</span>
                      <SourceBadge source={item.source} />
                      {item.configured ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-[var(--app-status-success)]">
                          <Check className="h-3 w-3" />
                          利用可能
                        </span>
                      ) : null}
                    </div>
                    <div className="text-xs text-[var(--m3-on-surface-variant)]">
                      {item.keyHint
                        ? `キー: ${item.keyHint}`
                        : "APIキーが未設定です"}
                      {item.baseUrl ? ` · ${item.baseUrl}` : ""}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      href={docs.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-[var(--m3-primary)] hover:underline"
                    >
                      キーを取得
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    {item.source === "user" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void handleDelete(item.provider)}
                        className="gap-1.5 text-[var(--m3-error)]"
                      >
                        {busy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                        削除
                      </Button>
                    ) : null}
                    <Button
                      variant="tonal"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        isEditing ? setEditing(null) : startEdit(item.provider, item)
                      }
                      className="gap-1.5"
                    >
                      <Plug className="h-3.5 w-3.5" />
                      {isEditing ? "閉じる" : item.source === "user" ? "更新" : "接続"}
                    </Button>
                  </div>
                </div>

                {isEditing ? (
                  <div className="space-y-3 border-t border-[var(--m3-outline-variant)] pt-3">
                    <div className="space-y-1.5">
                      <label
                        className="text-xs font-medium text-[var(--m3-on-surface-variant)]"
                        htmlFor={`provider-key-${item.provider}`}
                      >
                        APIキー
                      </label>
                      <Input
                        id={`provider-key-${item.provider}`}
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        value={draftKey}
                        onChange={(e) => setDraftKey(e.target.value)}
                        placeholder="sk-..."
                        className="font-mono text-sm"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label
                        className="text-xs font-medium text-[var(--m3-on-surface-variant)]"
                        htmlFor={`provider-url-${item.provider}`}
                      >
                        ベースURL（任意・OpenAI互換ゲートウェイ用）
                      </label>
                      <Input
                        id={`provider-url-${item.provider}`}
                        type="url"
                        value={draftBaseUrl}
                        onChange={(e) => setDraftBaseUrl(e.target.value)}
                        placeholder={
                          item.baseUrl || "https://api.example.com/v1"
                        }
                        className="text-sm"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        disabled={busy || draftKey.trim().length === 0}
                        onClick={() => void handleSave(item.provider)}
                        className="gap-1.5"
                      >
                        {busy ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Check className="h-4 w-4" />
                        )}
                        接続を確認して保存
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setEditing(null)}
                      >
                        キャセル
                      </Button>
                    </div>
                    <p className="text-[11px] leading-relaxed text-[var(--m3-on-surface-variant)]">
                      保存前にプロバイダーの <code>/models</code>{" "}
                      へ疎通確認します。キーはAES-256で暗号化して保存され、一覧には末尾4文字だけ表示されます。
                    </p>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {message && (
        <p
          className={cn(
            "text-xs",
            /失敗|拒否|不正|エラー/.test(message)
              ? "text-[var(--m3-error)]"
              : "text-[var(--m3-on-surface-variant)]",
          )}
        >
          {message}
        </p>
      )}
    </Surface>
  );
}
