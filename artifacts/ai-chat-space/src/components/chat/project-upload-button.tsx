import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Upload } from "lucide-react";
import { projectsApi, type ProjectsLimits } from "@/lib/projects-api";
import {
  formatUploadFailures,
  summarizeUploadOutcomes,
  uploadFilesToProject,
  type UploadOutcome,
} from "@/lib/project-upload";

export interface ProjectUploadButtonProps {
  projectId: number;
  /**
   * Override the default "this project's reference file" message that shows
   * when the user hovers or focuses the button.
   */
  title?: string;
}

/**
 * Small pill button used in the chat composer to upload a file into the
 * current project's reference-files set without leaving the chat.
 *
 * Picking the file opens the OS picker (no `accept` filter — Android pickers
 * grey out files with unknown MIME; the server validates the type and
 * returns a Japanese error message). Limits and existing counts are fetched
 * lazily so the button works in the composer without a project-page mount.
 *
 * The result (summary plus one "name: error" line per failure) is shown as
 * inline status text beside the button for ~10 s.
 */
export function ProjectUploadButton({
  projectId,
  title = "このプロジェクトの参考ファイルとして保存（全チャットで参照）",
}: ProjectUploadButtonProps) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [inlineStatus, setInlineStatus] = useState<string | null>(null);
  const inlineStatusTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (inlineStatusTimerRef.current != null) {
        window.clearTimeout(inlineStatusTimerRef.current);
      }
    },
    [],
  );

  const showInlineStatus = useCallback((text: string) => {
    setInlineStatus(text);
    if (inlineStatusTimerRef.current != null) {
      window.clearTimeout(inlineStatusTimerRef.current);
    }
    inlineStatusTimerRef.current = window.setTimeout(() => {
      setInlineStatus(null);
      inlineStatusTimerRef.current = null;
    }, 10_000);
  }, []);

  const notify = useCallback(
    (outcomes: UploadOutcome[]) => {
      const summary = summarizeUploadOutcomes(outcomes);
      const failures = formatUploadFailures(outcomes);
      showInlineStatus(
        failures.length > 0 ? `${summary}\n${failures.join("\n")}` : summary,
      );
    },
    [showInlineStatus],
  );

  const handleFiles = useCallback(
    async (selected: File[]) => {
      if (selected.length === 0) return;
      setBusy(true);
      try {
        const limits: ProjectsLimits = await projectsApi.limits();
        const existing = await projectsApi.listFiles(projectId);
        const outcomes = await uploadFilesToProject(
          projectId,
          selected,
          limits,
          existing.length,
        );
        queryClient.invalidateQueries({ queryKey: ["project", projectId] });
        notify(outcomes);
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "アップロード中にエラーが発生しました。";
        notify([{ name: "(アップロード)", ok: false, error: message }]);
      } finally {
        setBusy(false);
      }
    },
    [projectId, queryClient, notify],
  );

  const onChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const selected = Array.from(input.files ?? []);
    input.value = "";
    void handleFiles(selected);
  };

  return (
    <span className="inline-flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onChange}
        data-testid="chat-project-file-input"
        aria-hidden="true"
      />
      <button
        type="button"
        title={title}
        aria-label="プロジェクトにファイルを追加"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="inline-flex h-8 items-center gap-1.5 rounded-[var(--m3-shape-full)] border border-[var(--m3-outline-variant)] px-3 text-xs text-[var(--m3-on-secondary-container)] transition-colors hover:bg-[var(--m3-surface-container-high)] disabled:pointer-events-none disabled:opacity-[var(--m3-state-disabled)]"
        data-testid="chat-project-upload"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Upload className="h-3.5 w-3.5" />
        )}
        ファイルを追加
      </button>
      {inlineStatus ? (
        <span
          className="whitespace-pre-line text-[11px] text-[var(--m3-on-surface-variant)]"
          data-testid="chat-project-upload-status"
          role="status"
          aria-live="polite"
        >
          {inlineStatus}
        </span>
      ) : null}
    </span>
  );
}
