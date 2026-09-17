import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  FolderOpen,
  Loader2,
  LogOut,
  MessageSquareText,
  MonitorSmartphone,
  Plus,
  Settings,
  Shield,
} from "lucide-react";
import { useLocation, useParams } from "wouter";
import { useClerk, useUser } from "@clerk/react";
import {
  useListOpenaiConversations,
  type OpenaiConversation,
} from "@workspace/api-client-react";
import { loadSettings, saveSettings, type AppSettings } from "@/lib/settings";
import type { ReasoningLevel } from "@/lib/reasoning";
import { SegmentedControl, type MobileTab } from "./segmented-control";
import { WorkList, type WorkItem } from "./work-list";
import { GithubMark } from "./github-mark";
import { ProjectPanel } from "@/components/projects/project-panel";
import {
  ModelSettingsSheet,
  type SpeedPreference,
} from "./model-settings-sheet";
import "./mobile.css";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const SPEED_KEY = "chat-space.mobile.speed.v1";

function loadSpeed(): SpeedPreference {
  try {
    const raw = localStorage.getItem(SPEED_KEY);
    return raw === "fast" ? "fast" : "standard";
  } catch {
    return "standard";
  }
}

function conversationIconKind(title: string): WorkItem["kind"] {
  if (/github|git|vps|deploy|repo|branch|pr\b/i.test(title)) return "github";
  if (/image|auth|tool|device|pc|prototype/i.test(title)) return "device";
  return "chat";
}

interface MobileShellProps {
  children: ReactNode;
  /** Current page title for the drawer context. */
  pageTitle?: string;
}

export function MobileShell({ children }: MobileShellProps) {
  const [tab, setTab] = useState<MobileTab>("chat");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [location, setLocation] = useLocation();
  const params = useParams();
  const { signOut } = useClerk();
  const { user } = useUser();
  const { data: conversations, isLoading } = useListOpenaiConversations();

  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [speed, setSpeed] = useState<SpeedPreference>(() => loadSpeed());
  const [sessionModel, setSessionModel] = useState<string | null>(null);
  const [sessionReasoning, setSessionReasoning] =
    useState<ReasoningLevel | null>(null);

  useEffect(() => {
    setSettings(loadSettings());
  }, [location]);

  const activeId = params.id ? Number.parseInt(params.id, 10) : null;

  const selectedModel = sessionModel ?? settings.defaultModel;
  const reasoningLevel = sessionReasoning ?? settings.defaultReasoning;

  const workItems = useMemo<WorkItem[]>(() => {
    const list = (conversations ?? []) as OpenaiConversation[];
    return list.map((conversation) => ({
      id: conversation.id,
      title: conversation.title || "無題",
      kind: conversationIconKind(conversation.title || ""),
    }));
  }, [conversations]);

  useEffect(() => {
    if (activeId != null) setTab("chat");
  }, [activeId]);

  const handleSelectWork = useCallback(
    (item: WorkItem) => {
      setLocation(`/conversations/${item.id}`);
      setTab("chat");
      setDrawerOpen(false);
    },
    [setLocation],
  );

  const handleNewChat = useCallback(() => {
    setSessionModel(null);
    setSessionReasoning(null);
    setLocation("/chat");
    setTab("chat");
    setDrawerOpen(false);
  }, [setLocation]);

  const handleSelectModel = useCallback(
    (modelId: string) => {
      setSessionModel(modelId);
      const next = { ...settings, defaultModel: modelId };
      setSettings(next);
      saveSettings(next);
    },
    [settings],
  );

  const handleReasoningChange = useCallback(
    (level: ReasoningLevel) => {
      setSessionReasoning(level);
      const next = { ...settings, defaultReasoning: level };
      setSettings(next);
      saveSettings(next);
    },
    [settings],
  );

  const handleSpeedChange = useCallback((value: SpeedPreference) => {
    setSpeed(value);
    try {
      localStorage.setItem(SPEED_KEY, value);
    } catch {
      /* ignore quota errors */
    }
  }, []);

  return (
    <div
      className="mobile-shell flex h-[100dvh] w-full flex-col overflow-hidden"
      data-testid="mobile-shell"
      data-tab={tab}
    >
      <header className="mobile-topbar shrink-0">
        <button
          type="button"
          className="mobile-menu-btn"
          aria-label="メニューを開く"
          onClick={() => setDrawerOpen(true)}
          data-testid="mobile-menu"
        >
          <svg width="20" height="14" viewBox="0 0 20 14" fill="none" aria-hidden>
            <path
              d="M2 7h16"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <path
              d="M2 2.5h16"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <SegmentedControl value={tab} onChange={setTab} />
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {tab === "work" && (
          <div
            className="absolute inset-x-0 top-0 bottom-[140px] z-20 flex flex-col bg-[var(--mx-bg)]"
            data-testid="mobile-work-panel"
          >
            <div className="mobile-body flex-1 space-y-4 px-3 pt-4">
              <div className="rounded-[20px] bg-[var(--mx-panel)] p-3">
                <ProjectPanel
                  compact
                  onProjectCreated={() => {
                    /* list refreshes internally */
                  }}
                />
              </div>
              {isLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-[var(--mx-ink-muted)]" />
                </div>
              ) : (
                <WorkList
                  items={workItems}
                  onSelect={handleSelectWork}
                  emptyLabel="作業はまだありません。上の欄からプロジェクトを作成できます。"
                />
              )}
            </div>
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mobile-body min-h-0 flex-1">{children}</div>
        </div>
      </div>

      {/* Drawer */}
      {drawerOpen && (
        <button
          type="button"
          className="mobile-drawer-overlay"
          aria-label="メニューを閉じる"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <aside
        className="mobile-drawer-panel"
        data-open={drawerOpen}
        aria-hidden={!drawerOpen}
      >
        <div className="mb-6 flex items-center gap-3 px-1">
          <div className="grid h-10 w-10 place-items-center rounded-[var(--m3-shape-lg)] bg-[var(--m3-primary-container)] text-[var(--m3-on-primary-container)]">
            <MessageSquareText className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">AI Space</div>
            <div className="truncate text-xs text-[var(--mx-ink-muted)]">
              {user?.primaryEmailAddress?.emailAddress ?? "Workspace"}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <button
            type="button"
            className="mobile-drawer-item"
            onClick={handleNewChat}
          >
            <Plus className="h-4 w-4" />
            新しい会話
          </button>
          <button
            type="button"
            className="mobile-drawer-item"
            data-active={location === "/private"}
            onClick={() => {
              setLocation("/private");
              setTab("chat");
              setDrawerOpen(false);
            }}
          >
            <Shield className="h-4 w-4" />
            プライベート
          </button>
          <button
            type="button"
            className="mobile-drawer-item"
            onClick={() => {
              setLocation("/files");
              setTab("chat");
              setDrawerOpen(false);
            }}
          >
            <FolderOpen className="h-4 w-4" />
            ファイル
          </button>
          <button
            type="button"
            className="mobile-drawer-item"
            data-active={location === "/settings"}
            onClick={() => {
              setLocation("/settings");
              setTab("chat");
              setDrawerOpen(false);
            }}
          >
            <Settings className="h-4 w-4" />
            設定
          </button>
          <button
            type="button"
            className="mobile-drawer-item"
            onClick={() => signOut({ redirectUrl: basePath || "/" })}
          >
            <LogOut className="h-4 w-4" />
            ログアウト
          </button>
        </div>

        <div className="mt-6 border-t border-white/10 pt-4">
          <div className="px-1 pb-2 text-[11px] uppercase tracking-wider text-[var(--mx-ink-dim)]">
            会話
          </div>
          {(conversations ?? []).slice(0, 12).map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              className="mobile-drawer-item"
              data-active={activeId === conversation.id}
              onClick={() =>
                handleSelectWork({
                  id: conversation.id,
                  title: conversation.title || "無題",
                })
              }
            >
              {conversationIconKind(conversation.title || "") === "github" ? (
                <GithubMark className="h-4 w-4 shrink-0" />
              ) : conversationIconKind(conversation.title || "") ===
                "device" ? (
                <MonitorSmartphone className="h-4 w-4 shrink-0" />
              ) : (
                <MessageSquareText className="h-4 w-4 shrink-0" />
              )}
              <span className="truncate">
                {conversation.title || "無題"}
              </span>
            </button>
          ))}
          {isLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-[var(--mx-ink-dim)]" />
            </div>
          ) : null}
        </div>
      </aside>

      {/* Shared model chip bar is rendered inside pages; shell exposes sheet via CustomEvent */}
      <ModelSettingsSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        selectedModel={selectedModel}
        onSelectModel={handleSelectModel}
        reasoningLevel={reasoningLevel}
        onReasoningChange={handleReasoningChange}
        speed={speed}
        onSpeedChange={handleSpeedChange}
      />

      {/* Expose sheet opener for composer chips */}
      <MobileSheetBridge onOpen={() => setSheetOpen(true)} />
    </div>
  );
}

/** Listens for `mobile-open-model-sheet` so deep children can open the sheet. */
function MobileSheetBridge({ onOpen }: { onOpen: () => void }) {
  useEffect(() => {
    const handler = () => onOpen();
    window.addEventListener("mobile-open-model-sheet", handler);
    return () => window.removeEventListener("mobile-open-model-sheet", handler);
  }, [onOpen]);
  return null;
}

export function openMobileModelSheet() {
  window.dispatchEvent(new CustomEvent("mobile-open-model-sheet"));
}

