import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { ChevronLeft, Loader2, ShieldCheck } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OverviewTab } from "@/components/admin/overview-tab";
import { UsersTab } from "@/components/admin/users-tab";
import { ProvidersTab } from "@/components/admin/providers-tab";
import { ModelsTab } from "@/components/admin/models-tab";
import { refreshAvailableModels } from "@/components/chat/model-selector";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface AdminRoleResponse {
  role: string;
}

function shortRole(role: string): string {
  if (role === "admin") return "管理者";
  if (role === "user") return "一般ユーザー";
  return role;
}

const TABS = [
  { value: "overview", label: "利用状況" },
  { value: "users", label: "ユーザー" },
  { value: "providers", label: "プロバイダー" },
  { value: "models", label: "モデル" },
] as const;

type TabValue = (typeof TABS)[number]["value"];

export default function AdminPage() {
  const [me, setMe] = useState<AdminRoleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE}/api/openai/me`, { credentials: "include" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setMe({ role: "denied" });
          setError(null);
          return;
        }
        const body = (await res.json()) as AdminRoleResponse;
        setMe(body);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) {
          setMe({ role: "denied" });
          setError("サーバーへの接続に失敗しました。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE}/api/auth/me`, { credentials: "include" })
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const body = (await res.json()) as {
          user?: { id?: string } | null;
        };
        if (body.user?.id) setCurrentUserId(body.user.id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const invalidateModelCache = useCallback(() => {
    // The picker uses a module-level cache in model-selector.tsx, not
    // react-query. Trigger a refetch so the next opened picker sees the
    // updated provider/model list immediately.
    void refreshAvailableModels();
  }, []);

  if (!me) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (me.role !== "admin") {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background px-6 text-center">
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            このページは管理者のみアクセスできます。
          </p>
          <Link
            href="/chat"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            チャットに戻る
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background">
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              <h1 className="text-xl font-serif text-foreground">
                管理者コンソール
              </h1>
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
                {shortRole(me.role)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              ユーザー・プロバイダー・モデルを一か所で管理します。
            </p>
          </div>
          <Link
            href="/chat"
            className="inline-flex items-center gap-1 rounded-[var(--m3-shape-full)] border border-border/60 bg-card/50 px-4 py-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            チャットに戻る
          </Link>
        </div>

        {error ? (
          <div className="rounded-[var(--m3-shape-sm)] border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <Tabs
          defaultValue="overview"
          className="space-y-3"
          onValueChange={(value) => {
            void value;
          }}
        >
          <TabsList className="flex flex-wrap bg-card/40 p-1">
            {TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {TABS.map((tab) => (
            <TabsContent key={tab.value} value={tab.value as TabValue}>
              {renderTabContent(tab.value, currentUserId, invalidateModelCache)}
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </div>
  );
}

function renderTabContent(
  value: TabValue,
  currentUserId: string | null,
  invalidateModelCache: () => void,
) {
  switch (value) {
    case "overview":
      return <OverviewTab />;
    case "users":
      return <UsersTab currentUserId={currentUserId} />;
    case "providers":
      return <ProvidersTab onInvalidateModels={invalidateModelCache} />;
    case "models":
      return <ModelsTab onInvalidateModels={invalidateModelCache} />;
  }
}
