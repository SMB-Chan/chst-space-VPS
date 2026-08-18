import { useState, useCallback, useEffect } from "react";
import {
  useListOpenaiConversations,
  useDeleteOpenaiConversation,
  getListOpenaiConversationsQueryKey,
} from "@workspace/api-client-react";
import { Link, useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  MessageSquare,
  Plus,
  Trash2,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Command,
  Loader2,
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
import { useClerk, useUser } from "@clerk/react";
import { LogOut } from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

interface ChatLayoutProps {
  children: React.ReactNode;
}

export function ChatLayout({ children }: ChatLayoutProps) {
  const isMobile = useIsMobile();
  // On mobile, sidebar starts closed. On desktop, starts open.
  const [sidebarOpen, setSidebarOpen] = useState<boolean | undefined>(undefined);
  const [, setLocation] = useLocation();
  const params = useParams();
  const queryClient = useQueryClient();

  const { data: conversations, isLoading, isError, refetch } = useListOpenaiConversations();
  const deleteConversation = useDeleteOpenaiConversation();
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);

  // Wait until the viewport is known so phones don't flash an open drawer.
  useEffect(() => {
    if (sidebarOpen === undefined && isMobile !== undefined) {
      setSidebarOpen(!isMobile);
    }
  }, [isMobile, sidebarOpen]);

  const activeId = params.id ? parseInt(params.id) : null;

  const { signOut } = useClerk();
  const { user } = useUser();

  const handleNewChat = useCallback(() => {
    setLocation("/chat");
    if (isMobile) setSidebarOpen(false);
  }, [setLocation, isMobile]);

  const confirmDelete = useCallback(() => {
    if (pendingDeleteId == null) return;
    const id = pendingDeleteId;
    setPendingDeleteId(null);
    deleteConversation.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
          if (activeId === id) setLocation("/chat");
        },
      }
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
          "flex flex-col border-r border-sidebar-border bg-sidebar transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
          // Desktop: push layout
          !isMobile && (open ? "w-72" : "w-0 opacity-0 border-r-0"),
          // Mobile: fixed overlay
          isMobile && "fixed inset-y-0 left-0 z-30 w-72",
          isMobile && !open && "-translate-x-full",
          isMobile && open && "translate-x-0 shadow-2xl"
        )}
      >
        <div className="flex h-14 items-center justify-between px-4 border-b border-sidebar-border flex-shrink-0">
          <div className="flex items-center gap-2 font-medium text-sidebar-foreground">
            <Command className="w-5 h-5 text-primary" />
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

        <div className="p-3 flex-shrink-0">
          <Button
            onClick={handleNewChat}
            className="w-full justify-start gap-2 h-10 bg-sidebar-accent/50 text-sidebar-foreground hover:bg-sidebar-accent hover:text-primary transition-colors"
            variant="ghost"
          >
            <Plus className="w-4 h-4" />
            新しい会話
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1">
          <div className="px-2 py-2 text-xs font-medium text-sidebar-foreground/40 uppercase tracking-wider">
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
                <Link
                  href={`/conversations/${conv.id}`}
                  onClick={() => isMobile && setSidebarOpen(false)}
                  className={cn(
                    "flex flex-col gap-1 rounded-lg px-3 py-2.5 text-sm transition-all duration-200",
                    activeId === conv.id
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                  )}
                >
                  <div className="font-medium truncate pr-6">{conv.title || "無題"}</div>
                  <div className="text-xs opacity-60">
                    {formatDistanceToNow(new Date(conv.createdAt), { addSuffix: true, locale: ja })}
                  </div>
                </Link>

                <div className={cn(
                  "absolute right-2 top-2.5 transition-opacity",
                  isMobile ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                )}>
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
        <div className="border-t border-sidebar-border p-3 flex items-center gap-2 flex-shrink-0">
          <div className="flex-1 min-w-0">
            <div className="text-xs text-sidebar-foreground/70 truncate">
              {user?.primaryEmailAddress?.emailAddress ?? ""}
            </div>
          </div>
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
              className="w-9 h-9 bg-background/50 backdrop-blur border border-border text-muted-foreground hover:text-foreground shadow-sm"
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
