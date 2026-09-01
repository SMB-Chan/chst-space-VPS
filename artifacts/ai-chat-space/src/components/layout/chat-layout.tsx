import { useState, useCallback, useEffect, useRef } from "react";
import {
  useListOpenaiConversations,
  useDeleteOpenaiConversation,
  useUpdateOpenaiConversation,
  getListOpenaiConversationsQueryKey,
} from "@workspace/api-client-react";
import { Link, useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Trash2,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Command,
  Loader2,
  Settings,
  Shield,
  Pencil,
  LockKeyhole,
  MessageSquareText,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ja } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { useIsMobile } from "@/hooks/use-mobile";
import { CONVERSATION_TITLE_MAX, normalizeConversationTitle } from "@/lib/chat";
import { useClerk, useUser } from "@clerk/react";
import { LogOut } from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

interface ChatLayoutProps {
  children: React.ReactNode;
}

export function ChatLayout({ children }: ChatLayoutProps) {
  const isMobile = useIsMobile();
  // On mobile, sidebar starts closed. On desktop, starts open.
  const [sidebarOpen, setSidebarOpen] = useState<boolean | undefined>(
    undefined,
  );
  const [location, setLocation] = useLocation();
  const params = useParams();
  const queryClient = useQueryClient();

  const {
    data: conversations,
    isLoading,
    isError,
    refetch,
  } = useListOpenaiConversations();
  const deleteConversation = useDeleteOpenaiConversation();
  const updateConversation = useUpdateOpenaiConversation();
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId != null) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingId]);

  // Wait until the viewport is known so phones don't flash an open drawer.
  useEffect(() => {
    if (sidebarOpen === undefined && isMobile !== undefined) {
      setSidebarOpen(!isMobile);
    }
  }, [isMobile, sidebarOpen]);

  const activeId = params.id ? Number.parseInt(params.id, 10) : null;

  const { signOut } = useClerk();
  const { user } = useUser();

  const handleNewChat = useCallback(() => {
    setLocation("/chat");
    if (isMobile) setSidebarOpen(false);
  }, [setLocation, isMobile]);

  const commitRename = useCallback(() => {
    if (renamingId == null) return;
    const title = normalizeConversationTitle(renameDraft);
    if (!title) {
      setRenamingId(null);
      return;
    }
    const id = renamingId;
    setRenamingId(null);
    updateConversation.mutate(
      { id, data: { title } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListOpenaiConversationsQueryKey(),
          });
        },
      },
    );
  }, [renamingId, renameDraft, updateConversation, queryClient]);

  const confirmDelete = useCallback(() => {
    if (pendingDeleteId == null) return;
    const id = pendingDeleteId;
    setPendingDeleteId(null);
    deleteConversation.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListOpenaiConversationsQueryKey(),
          });
          if (activeId === id) setLocation("/chat");
        },
      },
    );
  }, [pendingDeleteId, activeId, deleteConversation, queryClient, setLocation]);

  const open = sidebarOpen ?? false;
  const activeConversation = conversations?.find(
    (conversation) => conversation.id === activeId,
  );
  const pageTitle =
    location === "/private"
      ? "プライベートセッション"
      : location === "/settings"
        ? "設定"
        : activeConversation?.title || "新しい会話";
  const pageContext =
    location === "/private"
      ? "履歴を保存しない一時的な会話"
      : location === "/settings"
        ? "モデルと応答の環境設定"
        : activeConversation
          ? "AI workspace"
          : "新しいアイデアを始める";

  return (
    <div className="relative flex h-[100dvh] w-full overflow-hidden bg-background text-foreground">
      <div className="ambient-grid pointer-events-none absolute inset-0 opacity-50" />
      {/* Mobile overlay backdrop */}
      {isMobile && open && (
        <div
          className="fixed inset-0 z-20 bg-black/60 backdrop-blur-sm"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={cn(
          "relative z-20 flex flex-col border-r border-sidebar-border/80 bg-sidebar/95 backdrop-blur-xl transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
          // Desktop: push layout
          !isMobile && (open ? "w-72" : "w-0 opacity-0 border-r-0"),
          // Mobile: fixed overlay
          isMobile && "fixed inset-y-0 left-0 z-30 w-72",
          isMobile && !open && "-translate-x-full",
          isMobile && open && "translate-x-0 shadow-2xl",
        )}
      >
        <div className="flex h-16 items-center justify-between border-b border-sidebar-border/70 px-4 flex-shrink-0">
          <div className="flex items-center gap-2 font-medium text-sidebar-foreground">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 shadow-sm">
              <Command className="w-4 h-4 text-primary" />
            </div>
            <div className="leading-none">
              <div className="tracking-tight">AI Space</div>
              <div className="mt-1 text-[9px] uppercase tracking-[0.18em] text-sidebar-foreground/40">
                Workspace
              </div>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="w-8 h-8 text-sidebar-foreground/60 hover:text-sidebar-foreground"
            onClick={() => setSidebarOpen(false)}
          >
            <PanelLeftClose className="w-4 h-4" />
          </Button>
        </div>

        <div className="p-3 flex-shrink-0 space-y-1.5">
          <Button
            onClick={handleNewChat}
            className="w-full justify-start gap-2 h-11 rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/15 hover:bg-primary/90 hover:shadow-primary/25 transition-colors font-medium"
          >
            <Plus className="w-4 h-4" />
            新しい会話
          </Button>
          <Button
            onClick={() => {
              setLocation("/private");
              if (isMobile) setSidebarOpen(false);
            }}
            className={cn(
              "w-full justify-start gap-2 h-10 rounded-xl text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors",
              location === "/private" &&
                "bg-violet-500/15 text-violet-200 hover:bg-violet-500/20",
            )}
            variant="ghost"
          >
            <Shield className="w-4 h-4" />
            プライベート
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1">
          <div className="flex items-center justify-between px-2 pb-2 pt-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-sidebar-foreground/40">
            <span>会話履歴</span>
            {conversations ? <span>{conversations.length}</span> : null}
          </div>

          {isLoading ? (
            <div className="px-2 py-4 flex justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-sidebar-foreground/20" />
            </div>
          ) : isError ? (
            <div className="px-2 py-4 text-sm text-sidebar-foreground/60 text-center space-y-2">
              <p>履歴を読み込めませんでした。</p>
              <Button variant="ghost" size="sm" onClick={() => refetch()}>
                再試行
              </Button>
            </div>
          ) : conversations?.length === 0 ? (
            <div className="px-2 py-4 text-sm text-sidebar-foreground/40 text-center">
              まだ会話はありません
            </div>
          ) : (
            conversations?.map((conv) => (
              <div key={conv.id} className="relative group">
                {renamingId === conv.id ? (
                  <div className="px-2 py-1.5">
                    <input
                      ref={renameInputRef}
                      value={renameDraft}
                      maxLength={CONVERSATION_TITLE_MAX}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitRename();
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setRenamingId(null);
                        }
                      }}
                      className="w-full h-8 rounded-xl bg-background/70 border border-border px-2 text-sm text-foreground outline-none focus:border-primary/60"
                      aria-label="会話名"
                    />
                  </div>
                ) : (
                  <Link
                    href={`/conversations/${conv.id}`}
                    onClick={() => isMobile && setSidebarOpen(false)}
                    className={cn(
                      "relative flex flex-col gap-1 rounded-xl px-3 py-2.5 text-sm transition-all duration-200",
                      activeId === conv.id
                        ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-primary"
                        : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                    )}
                  >
                    <div className="font-medium truncate pr-6">
                      {conv.title || "無題"}
                    </div>
                    <div className="text-xs opacity-60">
                      {formatDistanceToNow(new Date(conv.createdAt), {
                        addSuffix: true,
                        locale: ja,
                      })}
                    </div>
                  </Link>
                )}

                <div
                  className={cn(
                    "absolute right-2 top-2.5 transition-opacity",
                    isMobile
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                  )}
                >
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="w-6 h-6 hover:bg-background/50 text-sidebar-foreground/50"
                      >
                        <MoreVertical className="w-3.5 h-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setRenameDraft(conv.title || "");
                          setRenamingId(conv.id);
                        }}
                        className="cursor-pointer"
                      >
                        <Pencil className="w-4 h-4 mr-2" />
                        名前を変更
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setPendingDeleteId(conv.id);
                        }}
                        className="text-destructive focus:bg-destructive/10 focus:text-destructive cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4 mr-2" />
                        削除
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))
          )}
        </div>

        {/* User footer */}
        <div className="border-t border-sidebar-border/70 p-3 flex items-center gap-2 flex-shrink-0">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-sidebar-border bg-sidebar-accent text-xs font-semibold text-sidebar-foreground">
            {(
              user?.firstName?.[0] ??
              user?.primaryEmailAddress?.emailAddress?.[0] ??
              "U"
            ).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-sidebar-foreground truncate">
              {user?.firstName || "Account"}
            </div>
            <div className="text-xs text-sidebar-foreground/70 truncate">
              {user?.primaryEmailAddress?.emailAddress ?? ""}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            title="設定"
            className={cn(
              "w-8 h-8 text-sidebar-foreground/60 hover:text-sidebar-foreground",
              location === "/settings" && "text-foreground",
            )}
            onClick={() => {
              setLocation("/settings");
              if (isMobile) setSidebarOpen(false);
            }}
          >
            <Settings className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="ログアウト"
            className="w-8 h-8 text-sidebar-foreground/60 hover:text-sidebar-foreground"
            onClick={() => signOut({ redirectUrl: basePath || "/" })}
          >
            <LogOut className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Main content */}
      <div className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden bg-background/55">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-border/60 bg-background/70 px-3 backdrop-blur-xl sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0 rounded-xl border border-border/70 bg-card/50 text-muted-foreground shadow-sm hover:bg-card hover:text-foreground"
              onClick={() => setSidebarOpen((current) => !current)}
              aria-label={open ? "サイドバーを閉じる" : "サイドバーを開く"}
            >
              {open ? (
                <PanelLeftClose className="w-4 h-4" />
              ) : (
                <PanelLeftOpen className="w-4 h-4" />
              )}
            </Button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {location === "/private" ? (
                  <LockKeyhole className="h-3.5 w-3.5 shrink-0 text-violet-400" />
                ) : (
                  <MessageSquareText className="h-3.5 w-3.5 shrink-0 text-primary" />
                )}
                <h1 className="truncate text-sm font-medium tracking-tight sm:text-[15px]">
                  {pageTitle}
                </h1>
              </div>
              <p className="mt-0.5 truncate text-[10px] text-muted-foreground sm:text-[11px]">
                {pageContext}
              </p>
            </div>
          </div>
          <div className="hidden items-center gap-2 text-[10px] text-muted-foreground sm:flex">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-40" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            Ready
          </div>
        </header>
        <div className="min-h-0 flex-1">{children}</div>
      </div>

      <AlertDialog
        open={pendingDeleteId != null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>この会話を削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              削除するとメッセージは元に戻せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              削除する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
