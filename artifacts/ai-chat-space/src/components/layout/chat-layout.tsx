import { useState, useCallback, useEffect, useRef, useMemo } from "react";
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
  LogOut,
} from "lucide-react";
import { isToday, isYesterday, isThisWeek } from "date-fns";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Surface } from "@/design-system/surface";
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

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

interface ChatLayoutProps {
  children: React.ReactNode;
}

export function ChatLayout({ children }: ChatLayoutProps) {
  const isMobile = useIsMobile();
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

  const handlePrivate = useCallback(() => {
    setLocation("/private");
    if (isMobile) setSidebarOpen(false);
  }, [setLocation, isMobile]);

  const handleSettings = useCallback(() => {
    setLocation("/settings");
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


  type ConvItem = NonNullable<typeof conversations>[number];
  type ConvGroup = { label: string; items: ConvItem[] };

  const groupedConversations = useMemo<ConvGroup[]>(() => {
    if (!conversations?.length) return [];
    const today: ConvGroup = { label: "今日", items: [] };
    const yesterday: ConvGroup = { label: "昨日", items: [] };
    const thisWeek: ConvGroup = { label: "今週", items: [] };
    const older: ConvGroup = { label: "それ以前", items: [] };

    for (const conv of conversations) {
      const date = new Date(conv.createdAt);
      if (isToday(date)) today.items.push(conv);
      else if (isYesterday(date)) yesterday.items.push(conv);
      else if (isThisWeek(date, { weekStartsOn: 1 })) thisWeek.items.push(conv);
      else older.items.push(conv);
    }

    return [today, yesterday, thisWeek, older].filter((g) => g.items.length > 0);
  }, [conversations]);

  const open = sidebarOpen ?? false;
  const compactRail = isMobile === false && !open;
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
    <div className="m3-surface relative flex h-[100dvh] w-full overflow-hidden">
      <div className="ambient-grid pointer-events-none absolute inset-0 opacity-25" />

      {isMobile && open && (
        <button
          type="button"
          aria-label="ナビゲーションを閉じる"
          className="fixed inset-0 z-20 bg-black/55 backdrop-blur-[2px]"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <Surface
        asChild
        tone="low"
        shape="none"
        className={cn(
          "relative z-30 flex shrink-0 flex-col border-r border-[var(--m3-outline-variant)] transition-[width,transform,box-shadow] duration-[var(--m3-duration-long)] ease-[var(--m3-motion-emphasized)]",
          isMobile === false &&
            (open
              ? "w-[var(--m3-navigation-drawer-width)]"
              : "w-[var(--m3-navigation-rail-width)]"),
          isMobile &&
            "fixed inset-y-0 left-0 w-[min(var(--m3-navigation-drawer-width),88vw)] shadow-[var(--m3-elevation-3)]",
          isMobile && !open && "-translate-x-full",
          isMobile && open && "translate-x-0",
          isMobile === undefined && "w-0 overflow-hidden border-r-0",
        )}
      >
        <aside aria-label="メインナビゲーション">
          <div
            className={cn(
              "flex h-16 shrink-0 items-center border-b border-[var(--m3-outline-variant)]",
              compactRail ? "justify-center px-2" : "justify-between px-4",
            )}
          >
            <div className="flex min-w-0 items-center gap-2.5 font-medium">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--m3-shape-lg)] bg-[var(--m3-primary-container)] text-[var(--m3-on-primary-container)]">
                <Command className="h-[18px] w-[18px]" />
              </div>
              {!compactRail && (
                <div className="min-w-0 leading-none">
                  <div className="truncate tracking-tight">AI Space</div>
                  <div className="mt-1.5 text-[9px] uppercase tracking-[0.18em] text-[var(--m3-on-surface-variant)]">
                    Workspace
                  </div>
                </div>
              )}
            </div>
            {!compactRail && (
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0"
                onClick={() => setSidebarOpen(false)}
                aria-label="ナビゲーションを折りたたむ"
              >
                <PanelLeftClose className="h-4 w-4" />
              </Button>
            )}
          </div>

          {compactRail ? (
            <nav className="flex flex-1 flex-col items-center gap-2 py-3">
              <Button
                variant="filled"
                size="icon"
                className="h-12 w-12 rounded-[var(--m3-shape-xl)]"
                onClick={handleNewChat}
                title="新しい会話"
                aria-label="新しい会話"
              >
                <Plus className="h-5 w-5" />
              </Button>
              <Button
                variant={location === "/private" ? "tonal" : "ghost"}
                size="icon"
                className="h-12 w-12 rounded-[var(--m3-shape-xl)]"
                onClick={handlePrivate}
                title="プライベート"
                aria-label="プライベート"
              >
                <Shield className="h-5 w-5" />
              </Button>
              <div className="flex-1" />
              <Button
                variant={location === "/settings" ? "tonal" : "ghost"}
                size="icon"
                className="h-12 w-12 rounded-[var(--m3-shape-xl)]"
                onClick={handleSettings}
                title="設定"
                aria-label="設定"
              >
                <Settings className="h-5 w-5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-12 w-12 rounded-[var(--m3-shape-xl)]"
                title="ログアウト"
                aria-label="ログアウト"
                onClick={() => signOut({ redirectUrl: basePath || "/" })}
              >
                <LogOut className="h-5 w-5" />
              </Button>
            </nav>
          ) : (
            <>
              <div className="shrink-0 space-y-1.5 p-3">
                <Button
                  variant="filled"
                  onClick={handleNewChat}
                  className="h-11 w-full justify-start rounded-[var(--m3-shape-lg)] px-4"
                >
                  <Plus className="h-4 w-4" />
                  新しい会話
                </Button>
                <Button
                  onClick={handlePrivate}
                  className="h-10 w-full justify-start rounded-[var(--m3-shape-md)]"
                  variant={location === "/private" ? "tonal" : "ghost"}
                >
                  <Shield className="h-4 w-4" />
                  プライベート
                </Button>
              </div>

              <div className="flex-1 space-y-1 overflow-y-auto px-3 pb-3">
                <div className="flex items-center justify-between px-2 pb-2 pt-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--m3-on-surface-variant)]">
                  <span>会話履歴</span>
                  {conversations ? <span>{conversations.length}</span> : null}
                </div>

                {isLoading ? (
                  <div className="flex justify-center px-2 py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-[var(--m3-on-surface-variant)]" />
                  </div>
                ) : isError ? (
                  <div className="space-y-2 px-2 py-4 text-center text-sm text-[var(--m3-on-surface-variant)]">
                    <p>履歴を読み込めませんでした。</p>
                    <Button variant="ghost" size="sm" onClick={() => refetch()}>
                      再試行
                    </Button>
                  </div>
                ) : conversations?.length === 0 ? (
                  <div className="px-2 py-4 text-center text-sm text-[var(--m3-on-surface-variant)]">
                    まだ会話はありません
                  </div>
                ) : (
                  groupedConversations.map((group) => (
                    <div key={group.label}>
                      <div className="px-2 pb-1 pt-2.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--m3-on-surface-variant)]/50">
                        {group.label}
                      </div>
                      {group.items.map((conv) => (
                        <div key={conv.id} className="group relative">
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
                                className="m3-focus-ring h-9 w-full rounded-[var(--m3-shape-sm)] border border-[var(--m3-outline-variant)] bg-[var(--m3-surface-container)] px-2.5 text-sm outline-none"
                                aria-label="会話名"
                              />
                            </div>
                          ) : (
                            <Link
                              href={`/conversations/${conv.id}`}
                              onClick={() => isMobile && setSidebarOpen(false)}
                              className={cn(
                                "relative flex items-center rounded-[var(--m3-shape-md)] px-3 py-2 text-sm transition-[background-color,color,transform] duration-[var(--m3-duration-medium)] ease-[var(--m3-motion-standard)] active:scale-[0.99]",
                                activeId === conv.id
                                  ? "bg-[var(--m3-primary-container)] text-[var(--m3-on-primary-container)]"
                                  : "text-[var(--m3-on-surface-variant)] hover:bg-[var(--m3-surface-container)] hover:text-[var(--m3-on-surface)]",
                              )}
                            >
                              <div className="min-w-0 flex-1 truncate pr-6 font-medium">
                                {conv.title || "無題"}
                              </div>
                            </Link>
                          )}

                          <div
                            className={cn(
                              "absolute right-2 top-1.5 transition-opacity",
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
                                  className="h-7 w-7"
                                  aria-label="会話メニュー"
                                >
                                  <MoreVertical className="h-3.5 w-3.5" />
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
                                  <Pencil className="h-4 w-4" />
                                  名前を変更
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setPendingDeleteId(conv.id);
                                  }}
                                  className="cursor-pointer text-[var(--m3-error)] focus:text-[var(--m3-error)]"
                                >
                                  <Trash2 className="h-4 w-4" />
                                  削除
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2 border-t border-[var(--m3-outline-variant)] p-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--m3-shape-lg)] bg-[var(--m3-secondary-container)] text-xs font-semibold text-[var(--m3-on-secondary-container)]">
                  {(
                    user?.firstName?.[0] ??
                    user?.primaryEmailAddress?.emailAddress?.[0] ??
                    "U"
                  ).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">
                    {user?.firstName || "Account"}
                  </div>
                  <div className="truncate text-xs text-[var(--m3-on-surface-variant)]">
                    {user?.primaryEmailAddress?.emailAddress ?? ""}
                  </div>
                </div>
                <Button
                  variant={location === "/settings" ? "tonal" : "ghost"}
                  size="icon"
                  title="設定"
                  className="h-9 w-9"
                  onClick={handleSettings}
                >
                  <Settings className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title="ログアウト"
                  className="h-9 w-9"
                  onClick={() => signOut({ redirectUrl: basePath || "/" })}
                >
                  <LogOut className="h-4 w-4" />
                </Button>
              </div>
            </>
          )}
        </aside>
      </Surface>

      <main className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden">
        <Surface
          asChild
          tone="low"
          shape="none"
          className="flex h-16 shrink-0 items-center justify-between border-b border-[var(--m3-outline-variant)] px-3 sm:px-5"
        >
          <header>
            <div className="flex min-w-0 items-center gap-3">
              <Button
                variant="elevated"
                size="icon"
                className="h-10 w-10 shrink-0 rounded-[var(--m3-shape-lg)]"
                onClick={() => setSidebarOpen((current) => !current)}
                aria-label={
                  open ? "ナビゲーションを折りたたむ" : "ナビゲーションを開く"
                }
              >
                {open ? (
                  <PanelLeftClose className="h-4 w-4" />
                ) : (
                  <PanelLeftOpen className="h-4 w-4" />
                )}
              </Button>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {location === "/private" ? (
                    <LockKeyhole className="h-3.5 w-3.5 shrink-0 [color:var(--app-status-accent)]" />
                  ) : (
                    <MessageSquareText className="h-3.5 w-3.5 shrink-0 text-[var(--m3-primary)]" />
                  )}
                  <h1 className="truncate text-sm font-medium tracking-tight sm:text-[15px]">
                    {pageTitle}
                  </h1>
                </div>
                <p className="mt-0.5 truncate text-[10px] text-[var(--m3-on-surface-variant)] sm:text-[11px]">
                  {pageContext}
                </p>
              </div>
            </div>
            <div className="hidden items-center gap-2 text-[10px] text-[var(--m3-on-surface-variant)] sm:flex">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-[var(--m3-shape-full)] [background:var(--app-status-success)] opacity-35" />
                <span className="relative inline-flex h-2 w-2 rounded-[var(--m3-shape-full)] [background:var(--app-status-success)]" />
              </span>
              Ready
            </div>
          </header>
        </Surface>
        <div className="min-h-0 flex-1">{children}</div>
      </main>

      <AlertDialog
        open={pendingDeleteId != null}
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) setPendingDeleteId(null);
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
