/**
 * Google Drive references for a project.
 *
 * Behaviour follows the backend's `/api/project-drive/*` endpoints:
 *  - When the server is not configured AND there are no existing references,
 *    the whole block is hidden (feature is invisible until the operator turns
 *    it on). Already-attached references still show so users can disable /
 *    remove them, with a note explaining the re-fetch gap.
 *  - When configured but the user has not yet connected their Google account
 *    (or is missing the drive scope) we render only the connect button.
 *  - When fully connected, the search dialog is available.
 *
 * All hooks are declared at the top of the component, before any conditional
 * return (rules of hooks). The same pattern caused a React #310 crash in the
 * past on the project detail page; do not introduce `useState` after an early
 * `return` here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  HardDrive,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatBytes } from "@/lib/compress-image";
import { formatDateJa } from "@/lib/projects-format";
import {
  projectsApi,
  type DriveSearchFile,
  type DriveStatus,
  type ProjectDriveFile,
} from "@/lib/projects-api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const SEARCH_DEBOUNCE_MS = 400;

function driveTypeLabel(mimeType: string): string {
  if (!mimeType) return "その他";
  if (mimeType === "application/vnd.google-apps.document")
    return "Googleドキュメント";
  if (mimeType === "application/vnd.google-apps.spreadsheet")
    return "スプレッドシート";
  if (mimeType === "application/vnd.google-apps.presentation")
    return "スライド";
  if (mimeType === "application/vnd.google-apps.form") return "Googleフォーム";
  if (mimeType === "application/vnd.google-apps.drawing") return "図形";
  if (mimeType === "application/pdf") return "PDF";
  if (
    mimeType === "application/msword" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  )
    return "Word";
  if (
    mimeType === "application/vnd.ms-excel" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  )
    return "Excel";
  if (
    mimeType === "application/vnd.ms-powerpoint" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  )
    return "PowerPoint";
  if (mimeType.startsWith("text/")) return "テキスト";
  return "その他";
}

export interface DriveReferencesProps {
  projectId: number;
}

export function DriveReferences({ projectId }: DriveReferencesProps) {
  // All hooks must live above any conditional return (React rules of hooks).
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [files, setFiles] = useState<ProjectDriveFile[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<DriveSearchFile[] | null>(
    null,
  );
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [busyFileId, setBusyFileId] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);

  const [refBusyId, setRefBusyId] = useState<number | null>(null);
  const refBusyIdRef = useRef<number | null>(null);
  refBusyIdRef.current = refBusyId;

  const referencedDriveIds = useMemo(() => {
    const set = new Set<string>();
    for (const f of files ?? []) set.add(f.driveFileId);
    return set;
  }, [files]);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await projectsApi.driveStatus();
      setStatus(next);
      setStatusError(null);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : null);
      setStatus(null);
    }
  }, []);

  const refreshList = useCallback(async () => {
    try {
      const next = await projectsApi.listDriveFiles(projectId);
      setFiles(next);
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : null);
      setFiles([]);
    }
  }, [projectId]);

  useEffect(() => {
    void refreshStatus();
    void refreshList();
  }, [refreshStatus, refreshList]);

  const runSearch = useCallback(async (q: string) => {
    setSearching(true);
    setSearchError(null);
    try {
      const next = await projectsApi.driveSearch(q);
      setSearchResults(next);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : null);
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (!dialogOpen) return;
    if (!status?.connected) return;
    const handle = window.setTimeout(
      () => {
        void runSearch(searchQuery);
      },
      searchQuery.trim() === "" ? 0 : SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(handle);
  }, [dialogOpen, searchQuery, status?.connected, runSearch]);

  const handleAdd = useCallback(
    async (driveFileId: string) => {
      if (busyFileId) return;
      setBusyFileId(driveFileId);
      setSearchError(null);
      try {
        await projectsApi.addDriveFile(projectId, driveFileId);
        // 「追加済み」 follows from the refreshed reference list.
        await refreshList();
      } catch (err) {
        setSearchError(err instanceof Error ? err.message : null);
      } finally {
        setBusyFileId(null);
      }
    },
    [busyFileId, projectId, refreshList],
  );

  const handleUrlAdd = useCallback(async () => {
    const value = urlInput.trim();
    if (!value || urlBusy) return;
    setUrlBusy(true);
    setSearchError(null);
    try {
      await projectsApi.addDriveFile(projectId, value);
      setUrlInput("");
      await refreshList();
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : null);
    } finally {
      setUrlBusy(false);
    }
  }, [projectId, refreshList, urlBusy, urlInput]);

  const handleToggleInclusion = useCallback(
    async (file: ProjectDriveFile, next: boolean) => {
      if (refBusyIdRef.current !== null) return;
      setRefBusyId(file.id);
      try {
        const updated = await projectsApi.setDriveFileInclusion(
          projectId,
          file.id,
          next,
        );
        setFiles((prev) =>
          prev ? prev.map((f) => (f.id === updated.id ? updated : f)) : prev,
        );
      } catch (err) {
        setListError(err instanceof Error ? err.message : null);
      } finally {
        setRefBusyId(null);
      }
    },
    [projectId],
  );

  const handleRefresh = useCallback(
    async (file: ProjectDriveFile) => {
      if (refBusyIdRef.current !== null) return;
      setRefBusyId(file.id);
      try {
        const updated = await projectsApi.refreshDriveFile(projectId, file.id);
        setFiles((prev) =>
          prev ? prev.map((f) => (f.id === updated.id ? updated : f)) : prev,
        );
      } catch (err) {
        setListError(err instanceof Error ? err.message : null);
      } finally {
        setRefBusyId(null);
      }
    },
    [projectId],
  );

  const handleDelete = useCallback(
    async (file: ProjectDriveFile) => {
      if (refBusyIdRef.current !== null) return;
      const confirmed =
        typeof window !== "undefined"
          ? window.confirm(
              "このドライブ参照をプロジェクトから外しますか？（ドライブ上のファイルは削除されません）",
            )
          : true;
      if (!confirmed) return;
      setRefBusyId(file.id);
      try {
        await projectsApi.removeDriveFile(projectId, file.id);
        setFiles((prev) =>
          prev ? prev.filter((f) => f.id !== file.id) : prev,
        );
      } catch (err) {
        setListError(err instanceof Error ? err.message : null);
      } finally {
        setRefBusyId(null);
      }
    },
    [projectId],
  );

  // --- Render gates (after every hook above). ---
  const hasRefs = (files?.length ?? 0) > 0;
  const isConfigured = status?.configured ?? false;
  const isConnected = status?.connected ?? false;
  const hasScope = status?.hasDriveScope ?? false;

  // Invisible until the server is configured (a failed status call counts as
  // "not configured"), unless references already exist.
  if (!isConfigured && !hasRefs) {
    return null;
  }

  const showDisabledNote = !isConfigured && hasRefs;
  const showConnect = isConfigured && (!isConnected || !hasScope);
  const showActive = isConfigured && isConnected && hasScope;

  return (
    <div
      className="space-y-3 border-t border-[var(--m3-outline-variant)]/50 pt-4"
      data-testid="drive-references-block"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-[var(--m3-on-surface-variant)]" />
          <h3 className="text-sm font-semibold tracking-tight">
            Google ドライブ
          </h3>
        </div>
        {showActive ? (
          <Button
            variant="tonal"
            size="sm"
            onClick={() => setDialogOpen(true)}
            className="h-8 gap-1.5"
            data-testid="drive-add-open"
          >
            <Plus className="h-3.5 w-3.5" />
            ドライブから追加
          </Button>
        ) : null}
      </div>

      {statusError ? (
        <p className="text-xs text-[var(--m3-error)]">{statusError}</p>
      ) : null}

      {showDisabledNote ? (
        <p className="text-xs leading-relaxed text-[var(--m3-on-surface-variant)]">
          Googleドライブ連携が無効のため再取得できません
        </p>
      ) : null}

      {showConnect ? (
        <div className="space-y-2">
          <p className="text-xs leading-relaxed text-[var(--m3-on-surface-variant)]">
            大きなファイルはGoogleドライブから参照できます（本文はその都度ドライブから取得）。
          </p>
          <Button
            variant="tonal"
            size="sm"
            className="h-8 gap-1.5"
            data-testid="drive-connect"
            onClick={() => {
              const returnTo = encodeURIComponent(`/projects/${projectId}`);
              window.location.href = `${BASE}/api/google/auth?returnTo=${returnTo}`;
            }}
          >
            <Link2 className="h-3.5 w-3.5" />
            Googleアカウントと連携
          </Button>
        </div>
      ) : null}

      {listError ? (
        <p className="text-xs text-[var(--m3-error)]">{listError}</p>
      ) : null}

      {files === null ? (
        showActive ? (
          <p className="py-1 text-xs text-[var(--m3-on-surface-variant)]">
            読み込み中...
          </p>
        ) : null
      ) : files.length === 0 ? null : (
        <ul
          className="divide-y divide-[var(--m3-outline-variant)]/40"
          data-testid="drive-references"
        >
          {files.map((file) => (
            <li
              key={file.id}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
              data-testid={`drive-ref-${file.id}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <HardDrive className="h-4 w-4 shrink-0 text-[var(--m3-on-surface-variant)]" />
                  {file.webViewLink ? (
                    <a
                      href={file.webViewLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="truncate text-sm font-medium text-[var(--m3-primary)] hover:underline"
                    >
                      {file.name}
                    </a>
                  ) : (
                    <span className="truncate text-sm font-medium">
                      {file.name}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] text-[var(--m3-on-surface-variant)]">
                  抽出 {file.textChars.toLocaleString()} 文字 ・ 取得{" "}
                  {formatDateJa(file.fetchedAt ?? file.createdAt)}
                </p>
                {file.fetchError ? (
                  <p className="mt-0.5 text-[11px] text-[var(--m3-error)]">
                    {file.fetchError}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <label className="flex items-center gap-2 text-xs text-[var(--m3-on-surface-variant)]">
                  <Switch
                    checked={file.includeInContext}
                    onCheckedChange={(value) =>
                      void handleToggleInclusion(file, value)
                    }
                    disabled={refBusyId === file.id}
                    aria-label="チャットで参照"
                  />
                  <span>チャットで参照</span>
                </label>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void handleRefresh(file)}
                  disabled={refBusyId === file.id || !isConfigured}
                  aria-label="ドライブから再取得"
                  className="h-9 w-9 p-0"
                >
                  {refBusyId === file.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void handleDelete(file)}
                  disabled={refBusyId === file.id}
                  aria-label="ドライブ参照を削除"
                  className="h-9 w-9 p-0 text-[var(--m3-error)]"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Googleドライブから追加</DialogTitle>
            <DialogDescription>
              追加時に本文を取得してテキスト化します。Googleドキュメント/スプレッドシート/スライド、PDF・Office・テキストに対応（最大50MB）。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--m3-on-surface-variant)]" />
              <Input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="ファイル名で検索（空欄で最近のファイル）"
                className="h-10 pl-9"
                data-testid="drive-search-input"
              />
            </div>
            {searchError ? (
              <p
                className="text-xs text-[var(--m3-error)]"
                data-testid="drive-search-error"
              >
                {searchError}
              </p>
            ) : null}
            {searching &&
            (searchResults === null || searchResults.length === 0) ? (
              <div className="flex items-center gap-2 py-2 text-xs text-[var(--m3-on-surface-variant)]">
                <Spinner className="h-3.5 w-3.5" />
                検索しています...
              </div>
            ) : null}
            {searchResults === null ? null : searchResults.length === 0 ? (
              <p className="py-2 text-xs text-[var(--m3-on-surface-variant)]">
                該当するファイルはありません。
              </p>
            ) : (
              <ul
                className="max-h-72 divide-y divide-[var(--m3-outline-variant)]/40 overflow-y-auto"
                data-testid="drive-search-results"
              >
                {searchResults.map((file) => {
                  const already = referencedDriveIds.has(file.id);
                  const busy = busyFileId === file.id;
                  return (
                    <li
                      key={file.id}
                      className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <HardDrive className="h-4 w-4 shrink-0 text-[var(--m3-on-surface-variant)]" />
                          {file.webViewLink ? (
                            <a
                              href={file.webViewLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="truncate text-sm font-medium text-[var(--m3-primary)] hover:underline"
                            >
                              {file.name}
                            </a>
                          ) : (
                            <span className="truncate text-sm font-medium">
                              {file.name}
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-[11px] text-[var(--m3-on-surface-variant)]">
                          {driveTypeLabel(file.mimeType)}
                          {file.sizeBytes != null
                            ? ` ・ ${formatBytes(file.sizeBytes)}`
                            : ""}
                          {file.modifiedTime
                            ? ` ・ ${formatDateJa(file.modifiedTime)}`
                            : ""}
                        </p>
                      </div>
                      <Button
                        variant={already ? "outline" : "tonal"}
                        size="sm"
                        onClick={() => void handleAdd(file.id)}
                        disabled={already || busy}
                        className="h-8 gap-1.5"
                        data-testid={`drive-add-${file.id}`}
                      >
                        {busy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : null}
                        {already ? "追加済み" : "追加"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="space-y-2 border-t border-[var(--m3-outline-variant)]/40 pt-3">
              <label className="block text-xs font-medium text-[var(--m3-on-surface-variant)]">
                URLを貼り付けて追加
              </label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  type="text"
                  value={urlInput}
                  onChange={(event) => setUrlInput(event.target.value)}
                  placeholder="https://docs.google.com/..."
                  className="h-10 flex-1"
                  data-testid="drive-url-input"
                />
                <Button
                  variant="tonal"
                  onClick={() => void handleUrlAdd()}
                  disabled={urlBusy || !urlInput.trim()}
                  className="h-10 gap-1.5 sm:w-auto"
                  data-testid="drive-url-add"
                >
                  {urlBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  追加
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default DriveReferences;
