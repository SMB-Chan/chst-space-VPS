import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Download,
  FileText,
  FolderKanban,
  Loader2,
  MessageSquareText,
  Plus,
  Save,
  Trash2,
  X,
  MessageSquarePlus,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Surface } from "@/design-system/surface";
import {
  EmptyState,
  ErrorState,
  ScreenHeader,
} from "@/design-system/components";
import { Spinner } from "@/components/ui/spinner";
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
  useListOpenaiConversations,
  getListOpenaiConversationsQueryKey,
} from "@workspace/api-client-react";
import { formatBytes } from "@/lib/compress-image";
import { formatDateJa } from "@/lib/projects-format";
import {
  fileToBase64,
  projectsApi,
  type ProjectFile,
  type ProjectRecord,
  type ProjectsLimits,
} from "@/lib/projects-api";

const ACCEPTED_FILE_EXTENSIONS = [
  "text/*",
  ".md",
  ".txt",
  ".csv",
  ".json",
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".sh",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".css",
  ".scss",
  ".sql",
];

const ACCEPT_ATTRIBUTE = ACCEPTED_FILE_EXTENSIONS.join(",");

export function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const projectId = useMemo(() => {
    const parsed = Number.parseInt(params.id ?? "", 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }, [params.id]);

  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [metaDirty, setMetaDirty] = useState(false);
  const [metaBusy, setMetaBusy] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);

  const [instructions, setInstructions] = useState("");
  const [instructionsDirty, setInstructionsDirty] = useState(false);
  const [instructionsBusy, setInstructionsBusy] = useState(false);
  const [instructionsError, setInstructionsError] = useState<string | null>(
    null,
  );

  const [limits, setLimits] = useState<ProjectsLimits | null>(null);
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busyFileId, setBusyFileId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [conversations, setConversations] = useState<
    | { id: number; title: string; createdAt: string; updatedAt?: string }[]
    | null
  >(null);
  const [convError, setConvError] = useState<string | null>(null);
  const [convBusyId, setConvBusyId] = useState<number | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const { data: allConversations } = useListOpenaiConversations();

  const refreshProject = useCallback(async () => {
    if (projectId == null) return;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await projectsApi.get(projectId);
      setProject(next);
      setName(next.name);
      setDescription(next.description ?? "");
      setMetaDirty(false);
      setInstructions(next.instructions ?? "");
      setInstructionsDirty(false);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const refreshLimits = useCallback(async () => {
    try {
      const next = await projectsApi.limits();
      setLimits(next);
    } catch {
      setLimits(null);
    }
  }, []);

  const refreshFiles = useCallback(async () => {
    if (projectId == null) return;
    try {
      const list = await projectsApi.listFiles(projectId);
      setFiles(list);
    } catch (err) {
      setFileError(err instanceof Error ? err.message : null);
      setFiles([]);
    }
  }, [projectId]);

  const refreshConversations = useCallback(async () => {
    if (projectId == null) return;
    try {
      const list = await projectsApi.listConversations(projectId);
      setConversations(list);
    } catch (err) {
      setConvError(err instanceof Error ? err.message : null);
      setConversations([]);
    }
  }, [projectId]);

  useEffect(() => {
    void refreshProject();
    void refreshLimits();
    void refreshFiles();
    void refreshConversations();
  }, [refreshProject, refreshLimits, refreshFiles, refreshConversations]);

  const instructionsMax = limits?.instructionsMaxChars ?? 4000;
  const instructionsOver = instructions.length > instructionsMax;

  const projectConversationsById = useMemo(() => {
    const map = new Map<number, { id: number; title: string }>();
    for (const conv of conversations ?? []) map.set(conv.id, conv);
    return map;
  }, [conversations]);

  const assignableConversations = useMemo(() => {
    if (!allConversations) return [];
    return allConversations.filter(
      (conv) => !projectConversationsById.has(conv.id),
    );
  }, [allConversations, projectConversationsById]);

  if (projectId == null) {
    return <NotFoundState onBack={() => setLocation("/projects")} />;
  }

  if (loading && !project) {
    return (
      <CenteredStatus>
        <Spinner className="h-5 w-5" />
        プロジェクトを読み込んでいます...
      </CenteredStatus>
    );
  }

  if (loadError && !project) {
    return (
      <ErrorState
        title="プロジェクトが見つかりません"
        description={loadError}
        primaryAction={
          <Button variant="tonal" onClick={() => setLocation("/projects")}>
            プロジェクト一覧へ
          </Button>
        }
        className="mx-auto max-w-md px-4 py-16"
      />
    );
  }

  if (!project) {
    return <NotFoundState onBack={() => setLocation("/projects")} />;
  }

  const handleMetaSave = async () => {
    setMetaBusy(true);
    setMetaError(null);
    try {
      const updated = await projectsApi.update(project.id, {
        name: name.trim() || project.name,
        description: description.trim() ? description.trim() : null,
      });
      setProject(updated);
      setName(updated.name);
      setDescription(updated.description ?? "");
      setMetaDirty(false);
    } catch (err) {
      setMetaError(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setMetaBusy(false);
    }
  };

  const handleInstructionsSave = async () => {
    if (instructionsOver) return;
    setInstructionsBusy(true);
    setInstructionsError(null);
    try {
      const updated = await projectsApi.update(project.id, {
        instructions,
      });
      setProject(updated);
      setInstructions(updated.instructions ?? "");
      setInstructionsDirty(false);
    } catch (err) {
      setInstructionsError(
        err instanceof Error ? err.message : "保存に失敗しました。",
      );
    } finally {
      setInstructionsBusy(false);
    }
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const selected = Array.from(input.files ?? []);
    // Allow re-selecting the same file again.
    input.value = "";
    if (selected.length === 0) return;
    if (!limits) {
      setFileError("上限情報を取得できていません。");
      return;
    }
    const oversize = selected.filter((file) => file.size > limits.fileMaxBytes);
    if (oversize.length > 0) {
      setFileError(
        `${oversize[0].name} は1ファイル最大 ${formatBytes(limits.fileMaxBytes)} を超えています。`,
      );
      return;
    }
    const projectedCount = (files?.length ?? 0) + selected.length;
    if (projectedCount > limits.maxFiles) {
      setFileError(
        `最大 ${limits.maxFiles} ファイルまでです。${
          files?.length ?? 0
        } 件登録済みで、追加できるのは ${Math.max(
          0,
          limits.maxFiles - (files?.length ?? 0),
        )} 件です。`,
      );
      return;
    }
    const projectedBytes = selected.reduce(
      (sum, file) => sum + file.size,
      limits.usage?.totalBytes ?? 0,
    );
    if (projectedBytes > limits.userMaxTotalBytes) {
      setFileError(
        `使用量が上限 (${formatBytes(limits.userMaxTotalBytes)}) を超えます。`,
      );
      return;
    }
    setFileBusy(true);
    setFileError(null);
    let lastError: string | null = null;
    try {
      for (const file of selected) {
        try {
          const dataBase64 = await fileToBase64(file);
          await projectsApi.uploadFile(project.id, {
            filename: file.name,
            dataBase64,
          });
        } catch (err) {
          lastError = err instanceof Error ? err.message : null;
        }
      }
      await refreshFiles();
      void refreshLimits();
      if (lastError) setFileError(lastError);
    } finally {
      setFileBusy(false);
    }
  };

  const handleToggleInclusion = async (file: ProjectFile, next: boolean) => {
    setBusyFileId(file.id);
    try {
      const updated = await projectsApi.setFileInclusion(
        project.id,
        file.id,
        next,
      );
      setFiles((prev) =>
        prev
          ? prev.map((entry) => (entry.id === updated.id ? updated : entry))
          : prev,
      );
    } catch (err) {
      setFileError(err instanceof Error ? err.message : null);
    } finally {
      setBusyFileId(null);
    }
  };

  const handleDeleteFile = async (file: ProjectFile) => {
    const confirmed =
      typeof window !== "undefined"
        ? window.confirm(
            `「${file.filename}」を削除します。元に戻せません。よろしいですか？`,
          )
        : true;
    if (!confirmed) return;
    setBusyFileId(file.id);
    try {
      await projectsApi.removeFile(project.id, file.id);
      await refreshFiles();
      void refreshLimits();
    } catch (err) {
      setFileError(err instanceof Error ? err.message : null);
    } finally {
      setBusyFileId(null);
    }
  };

  const handleUnassign = async (conversationId: number) => {
    setConvBusyId(conversationId);
    try {
      await projectsApi.unassignConversation(project.id, conversationId);
      await refreshConversations();
      void queryClient.invalidateQueries({
        queryKey: getListOpenaiConversationsQueryKey(),
      });
    } catch (err) {
      setConvError(err instanceof Error ? err.message : null);
    } finally {
      setConvBusyId(null);
    }
  };

  const handleAssign = async (conversationId: number) => {
    setConvBusyId(conversationId);
    try {
      await projectsApi.assignConversation(project.id, conversationId);
      await refreshConversations();
      void queryClient.invalidateQueries({
        queryKey: getListOpenaiConversationsQueryKey(),
      });
    } catch (err) {
      setConvError(err instanceof Error ? err.message : null);
    } finally {
      setConvBusyId(null);
    }
  };

  const handleDeleteProject = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await projectsApi.remove(project.id);
      setDeleteOpen(false);
      setLocation("/projects");
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "削除できませんでした。",
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
        <BackBar name={project.name} onBack={() => setLocation("/projects")} />

        <Button
          onClick={() => setLocation(`/chat?project=${project.id}`)}
          className="h-11 w-full gap-1.5 sm:w-auto"
          data-testid="project-new-chat"
        >
          <MessageSquarePlus className="h-4 w-4" />
          このプロジェクトで新しいチャット
        </Button>

        <Surface
          tone="low"
          shape="extraLarge"
          className="space-y-4 border border-[var(--m3-outline-variant)] p-5 shadow-[var(--m3-elevation-1)] sm:p-6"
        >
          <ScreenHeader
            title="基本情報"
            description="プロジェクト名と説明を変更できます。"
          />
          <div className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-[var(--m3-on-surface-variant)]">
                プロジェクト名
              </span>
              <Input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setMetaDirty(true);
                }}
                maxLength={120}
                aria-label="プロジェクト名"
                data-testid="project-edit-name"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-[var(--m3-on-surface-variant)]">
                説明
              </span>
              <Textarea
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                  setMetaDirty(true);
                }}
                maxLength={2000}
                rows={3}
                aria-label="説明"
                data-testid="project-edit-description"
              />
            </label>
            {metaError ? (
              <p className="text-xs text-[var(--m3-error)]">{metaError}</p>
            ) : null}
            <div className="flex justify-end">
              <Button
                variant="tonal"
                disabled={metaBusy || !metaDirty}
                onClick={() => void handleMetaSave()}
                data-testid="project-save-meta"
                className="gap-1.5"
              >
                {metaBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                保存
              </Button>
            </div>
          </div>
        </Surface>

        <Surface
          tone="low"
          shape="extraLarge"
          className="space-y-4 border border-[var(--m3-outline-variant)] p-5 shadow-[var(--m3-elevation-1)] sm:p-6"
        >
          <div className="space-y-1.5">
            <h2 className="text-base font-semibold tracking-tight">
              カスタム指示
            </h2>
            <p className="text-sm leading-relaxed text-[var(--m3-on-surface-variant)]">
              このプロジェクトのすべてのチャットで、AIへの指示として使われます。書き方の例:
              口調、視点、出力形式、参照すべき資料など。
            </p>
          </div>
          <Textarea
            value={instructions}
            onChange={(event) => {
              setInstructions(event.target.value);
              setInstructionsDirty(true);
            }}
            rows={8}
            maxLength={Math.max(instructionsMax + 1, 1)}
            className="font-mono text-sm"
            placeholder="例: あなたは有能なリサーチアシスタントです..."
            data-testid="project-instructions"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p
              className={
                instructionsOver
                  ? "text-xs text-[var(--m3-error)]"
                  : "text-xs text-[var(--m3-on-surface-variant)]"
              }
            >
              {instructions.length} / {instructionsMax} 文字
              {instructionsOver ? " — 上限を超えています" : ""}
            </p>
            <Button
              variant="tonal"
              disabled={
                instructionsBusy || instructionsOver || !instructionsDirty
              }
              onClick={() => void handleInstructionsSave()}
              data-testid="project-save-instructions"
              className="gap-1.5"
            >
              {instructionsBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              保存
            </Button>
          </div>
          {instructionsError ? (
            <p className="text-xs text-[var(--m3-error)]">
              {instructionsError}
            </p>
          ) : null}
        </Surface>

        <Surface
          tone="low"
          shape="extraLarge"
          className="space-y-4 border border-[var(--m3-outline-variant)] p-5 shadow-[var(--m3-elevation-1)] sm:p-6"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="space-y-1.5">
              <h2 className="text-base font-semibold tracking-tight">
                参考ファイル
              </h2>
              <p className="text-sm leading-relaxed text-[var(--m3-on-surface-variant)]">
                ここに置いたファイルは「チャットで参照」をオンにしたものがこのプロジェクトの全チャットで参照されます。
              </p>
              {limits ? (
                <p className="text-xs text-[var(--m3-on-surface-variant)]">
                  1ファイル最大 {formatBytes(limits.fileMaxBytes)} / 最大{" "}
                  {limits.maxFiles} ファイル / 使用量{" "}
                  {formatBytes(limits.usage?.totalBytes ?? 0)} /{" "}
                  {formatBytes(limits.userMaxTotalBytes)}
                </p>
              ) : null}
              <p className="text-xs text-[var(--m3-on-surface-variant)]">
                トークン節約のため、AIに渡すファイル本文は約{" "}
                {limits?.filesContextMaxChars
                  ? `${limits.filesContextMaxChars.toLocaleString()} 文字`
                  : "数KB"}{" "}
                に制限されます。先頭のファイルから優先されます。
              </p>
            </div>
            <div className="flex flex-col items-stretch gap-2 sm:items-end">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPT_ATTRIBUTE}
                className="hidden"
                onChange={(event) => void handleUpload(event)}
                data-testid="project-file-input"
              />
              <Button
                variant="tonal"
                onClick={() => fileInputRef.current?.click()}
                disabled={fileBusy || !limits}
                className="gap-1.5"
                data-testid="project-upload"
              >
                {fileBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                ファイルを追加
              </Button>
            </div>
          </div>
          {fileError ? (
            <p className="text-xs text-[var(--m3-error)]">{fileError}</p>
          ) : null}
          {files === null ? (
            <p className="py-4 text-sm text-[var(--m3-on-surface-variant)]">
              読み込み中...
            </p>
          ) : files.length === 0 ? (
            <EmptyState
              compact
              icon={<FileText className="h-5 w-5" />}
              title="参考ファイルはまだありません"
              description="上のボタンから仕様書や議事録を追加すると、すべてのチャットで参照できます。"
            />
          ) : (
            <ul className="divide-y divide-[var(--m3-outline-variant)]/40">
              {files.map((file) => (
                <li
                  key={file.id}
                  className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 shrink-0 text-[var(--m3-on-surface-variant)]" />
                      <span className="truncate text-sm font-medium">
                        {file.filename}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-[var(--m3-on-surface-variant)]">
                      {formatBytes(file.sizeBytes)} ・ 抽出{" "}
                      {file.textChars.toLocaleString()} 文字 ・{" "}
                      {formatDateJa(file.createdAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                    <label className="flex items-center gap-2 text-xs text-[var(--m3-on-surface-variant)]">
                      <Switch
                        checked={file.includeInContext}
                        onCheckedChange={(value) =>
                          void handleToggleInclusion(file, value)
                        }
                        disabled={busyFileId === file.id}
                        aria-label="チャットで参照"
                      />
                      <span>チャットで参照</span>
                    </label>
                    <a
                      href={projectsApi.fileDownloadUrl(project.id, file.id)}
                      className="inline-flex h-9 items-center gap-1.5 rounded-[var(--m3-shape-md)] border border-[var(--m3-outline-variant)] px-3 text-xs hover:bg-[var(--m3-surface-container)]"
                      data-testid={`project-file-download-${file.id}`}
                    >
                      <Download className="h-3.5 w-3.5" />
                      ダウンロード
                    </a>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleDeleteFile(file)}
                      disabled={busyFileId === file.id}
                      aria-label="ファイルを削除"
                      className="h-9 w-9 p-0 text-[var(--m3-error)]"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Surface>

        <Surface
          tone="low"
          shape="extraLarge"
          className="space-y-4 border border-[var(--m3-outline-variant)] p-5 shadow-[var(--m3-elevation-1)] sm:p-6"
        >
          <div className="space-y-1.5">
            <h2 className="text-base font-semibold tracking-tight">会話</h2>
            <p className="text-sm leading-relaxed text-[var(--m3-on-surface-variant)]">
              このプロジェクトに属する会話と、新規追加できる会話の一覧です。
            </p>
          </div>
          {convError ? (
            <p className="text-xs text-[var(--m3-error)]">{convError}</p>
          ) : null}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--m3-on-surface-variant)]">
              このプロジェクトの会話
            </h3>
            {conversations === null ? (
              <p className="py-2 text-sm text-[var(--m3-on-surface-variant)]">
                読み込み中...
              </p>
            ) : conversations.length === 0 ? (
              <p className="py-2 text-sm text-[var(--m3-on-surface-variant)]">
                まだ会話はありません。「このプロジェクトで新しいチャット」から始められます。
              </p>
            ) : (
              <ul className="divide-y divide-[var(--m3-outline-variant)]/40">
                {conversations.map((conv) => (
                  <li
                    key={conv.id}
                    className="flex items-center gap-2 py-2.5"
                    data-testid={`project-conversation-${conv.id}`}
                  >
                    <Link
                      href={`/conversations/${conv.id}`}
                      className="flex min-w-0 flex-1 items-center gap-2 text-sm"
                    >
                      <MessageSquareText className="h-4 w-4 shrink-0 text-[var(--m3-on-surface-variant)]" />
                      <span className="truncate">{conv.title || "無題"}</span>
                    </Link>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleUnassign(conv.id)}
                      disabled={convBusyId === conv.id}
                      className="h-9 gap-1.5 px-2.5 text-xs text-[var(--m3-on-surface-variant)]"
                    >
                      <X className="h-3.5 w-3.5" />
                      プロジェクトから外す
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--m3-on-surface-variant)]">
              既存の会話を追加
            </h3>
            {assignableConversations.length === 0 ? (
              <p className="py-2 text-sm text-[var(--m3-on-surface-variant)]">
                追加できる会話がありません。
              </p>
            ) : (
              <ul className="max-h-64 divide-y divide-[var(--m3-outline-variant)]/40 overflow-y-auto">
                {assignableConversations.map((conv) => (
                  <li key={conv.id} className="flex items-center gap-2 py-2.5">
                    <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-[var(--m3-on-surface-variant)]">
                      <MessageSquareText className="h-4 w-4 shrink-0" />
                      <span className="truncate">{conv.title || "無題"}</span>
                    </span>
                    <Button
                      variant="tonal"
                      size="sm"
                      onClick={() => void handleAssign(conv.id)}
                      disabled={convBusyId === conv.id}
                      className="h-9 gap-1.5 px-2.5 text-xs"
                    >
                      {convBusyId === conv.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      追加
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Surface>

        <Surface
          tone="low"
          shape="extraLarge"
          className="space-y-3 border border-[var(--m3-error)]/40 p-5 sm:p-6"
        >
          <h2 className="text-base font-semibold tracking-tight text-[var(--m3-error)]">
            プロジェクトを削除
          </h2>
          <p className="text-sm leading-relaxed text-[var(--m3-on-surface-variant)]">
            削除すると、すべての参考ファイルが完全に削除されます。会話はサーバーに残り、プロジェクトからは外れます（元に戻せます）。
          </p>
          {deleteError ? (
            <p className="text-xs text-[var(--m3-error)]">{deleteError}</p>
          ) : null}
          <div>
            <Button
              variant="destructive"
              onClick={() => setDeleteOpen(true)}
              className="gap-1.5"
              data-testid="project-delete"
            >
              <Trash2 className="h-4 w-4" />
              プロジェクトを削除
            </Button>
          </div>
        </Surface>
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              「{project.name}」を削除しますか？
            </AlertDialogTitle>
            <AlertDialogDescription>
              すべての参考ファイルが削除されます。会話はサーバーに残ります（元に戻せます）。この操作は取り消せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              キャンセル
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleDeleteProject();
              }}
              disabled={deleting}
              className="bg-[var(--m3-error)] text-[var(--m3-on-error)] hover:brightness-[0.96]"
            >
              {deleting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              削除する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function BackBar({ name, onBack }: { name: string; onBack: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex h-10 items-center gap-1.5 rounded-[var(--m3-shape-md)] px-2 text-sm text-[var(--m3-on-surface-variant)] hover:bg-[var(--m3-surface-container)]"
        data-testid="project-back"
      >
        <ArrowLeft className="h-4 w-4" />
        プロジェクト一覧
      </button>
      <div className="flex min-w-0 items-center gap-2 text-sm text-[var(--m3-on-surface-variant)]">
        <FolderKanban className="h-4 w-4 shrink-0" />
        <span className="truncate font-medium text-[var(--m3-on-surface)]">
          {name}
        </span>
      </div>
    </div>
  );
}

function CenteredStatus({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex h-full items-center justify-center gap-2 text-sm text-[var(--m3-on-surface-variant)]"
      role="status"
    >
      {children}
    </div>
  );
}

function NotFoundState({ onBack }: { onBack: () => void }) {
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <ErrorState
        title="プロジェクトが見つかりません"
        description="このプロジェクトは存在しないか、削除された可能性があります。"
        primaryAction={
          <Button variant="tonal" onClick={onBack} className="gap-1.5">
            <ArrowLeft className="h-4 w-4" />
            プロジェクト一覧へ
          </Button>
        }
      />
    </div>
  );
}

export default ProjectDetailPage;
