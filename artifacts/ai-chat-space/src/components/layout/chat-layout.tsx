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

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background text-foreground">
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
          "flex flex-col border-r border-sidebar-border/60 bg-sidebar/80 backdrop-blur-2xl transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
          // Desktop: push layout
          !isMobile && (open ? "w-72" : "w-0 opacity-0 border-r-0"),
          // Mobile: fixed overlay
          isMobile && "fixed inset-y-0 left-0 z-30 w-72",
          isMobile && !open && "-translate-x-full",
          isMobile && open && "translate-x-0 shadow-2xl",
        )}
      >
        <div className="flex h-14 items-center justify-between px-4 border-b border-sidebar-border/60 flex-shrink-0">
          <div className="flex items-center gap-2.5 font-medium text-sidebar-foreground">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary/35 to-primary/5 border border-primary/25 flex items-center justify-center shadow-inner">
              <Command className="w-4 h-4 text-primary" />
            </div>
            <span className="tracking-tight">AI Space</span>
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
            className="w-full justify-start gap-2 h-11 rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/15 hover:bg-primary/90 hover:shadow-primary/25 font-medium"
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
              "w-full justify-start gap-2 h-10 rounded-2xl border border-transparent text-sidebar-foreground/80 hover:bg-violet-500/10 hover:text-violet-200 transition-colors",
              location === "/private" &&
                "border-violet-500/25 bg-violet-500/15 text-violet-200 hover:bg-violet-500/20",
            )}
            variant="ghost"
          >
            <Shield className="w-4 h-4" />
            プライベート
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1">
          <div className="px-3 py-2 text-[11px] font-medium text-sidebar-foreground/40 uppercase tracking-wider">
            履歴 {conversations && `(${conversations.length})`}
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
                      "flex flex-col gap-1 rounded-2xl border px-3 py-2.5 text-sm transition-all duration-200",
                      activeId === conv.id
                        ? "border-primary/25 bg-primary/12 text-foreground shadow-sm"
                        : "border-transparent text-sidebar-foreground/70 hover:bg-foreground/5 hover:text-sidebar-foreground",
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
        <div className="border-t border-sidebar-border/60 p-3 flex items-center gap-2 flex-shrink-0">
          <div className="flex-1 min-w-0">
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
      <div className="flex-1 flex flex-col min-w-0 bg-background relative overflow-hidden">
        {/* Top bar — hamburger on mobile, panel toggle on desktop */}
        {!open && (
          <div className="absolute top-3 left-3 z-10">
            <Button
              variant="ghost"
              size="icon"
              className="w-10 h-10 rounded-full glass-panel glass-hover text-muted-foreground hover:text-foreground"
              onClick={() => setSidebarOpen(true)}
            >
              <PanelLeftOpen className="w-4 h-4" />
            </Button>
          </div>
        )}
        {children}
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
