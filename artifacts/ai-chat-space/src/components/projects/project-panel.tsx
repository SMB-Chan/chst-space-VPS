import { useCallback, useEffect, useState } from "react";
import { FolderKanban, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FileBrowser } from "@/components/files/file-browser";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface ProjectSummary {
  id: number;
  name: string;
  slug: string;
  description: string | null;
}

interface ProjectPanelProps {
  /** Called after a project is created (e.g. refresh work list). */
  onProjectCreated?: (project: ProjectSummary) => void;
  /** Called when user opens files for a project. */
  onOpenFiles?: (folder: string) => void;
  compact?: boolean;
}

export function ProjectPanel({
  onProjectCreated,
  onOpenFiles,
  compact,
}: ProjectPanelProps) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [filesPath, setFilesPath] = useState("");

  const refresh = useCallback(async () => {
    const res = await fetch(`${BASE}/api/projects`, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { projects: ProjectSummary[] };
    setProjects(data.projects);
    return data.projects;
  }, []);

  useEffect(() => {
    void refresh().catch(() => setMessage("一覧を読み込めませんでした。"));
  }, [refresh]);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${BASE}/api/projects`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        project?: ProjectSummary;
        folder?: string;
        error?: string;
      };
      if (!res.ok || !data.project) {
        throw new Error(data.error || "作成に失敗しました。");
      }
      setName("");
      await refresh();
      setMessage(
        `「${data.project.name}」を作成しました${
          data.folder ? `（フォルダ: ${data.folder}/）` : ""
        }`,
      );
      if (data.folder) {
        setFilesPath(data.folder);
        onProjectCreated?.(data.project);
        // Compact (Work tab) navigates; only the full panel embeds a browser.
        if (!compact) setShowFiles(true);
        else onOpenFiles?.(data.folder);
      } else {
        onProjectCreated?.(data.project);
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "作成に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {compact ? (
        <div className="flex items-center justify-between px-2 pb-2 pt-3">
          <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--m3-on-surface-variant)]">
            プロジェクト
          </span>
          <button
            type="button"
            onClick={() => {
              if (compact) {
                onOpenFiles?.(filesPath || "");
                return;
              }
              setShowFiles((v) => !v);
              if (!showFiles && !filesPath) setFilesPath("");
            }}
            className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--m3-on-surface-variant)] transition-colors hover:text-foreground"
            aria-expanded={showFiles}
          >
            ファイル
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <FolderKanban className="h-4 w-4" />
            プロジェクト
          </h3>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1 text-xs"
            onClick={() => {
              setShowFiles((v) => !v);
              if (!showFiles && !filesPath) setFilesPath("");
            }}
          >
            ファイル
          </Button>
        </div>
      )}

      <div className={compact ? "flex gap-1.5 px-2" : "flex gap-2"}>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="新しいプロジェクト名"
          className={
            compact
              ? "h-9 rounded-[var(--m3-shape-md)] border-[var(--m3-outline-variant)] bg-[var(--m3-surface-container)] text-sm"
              : ""
          }
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleCreate();
          }}
        />
        <Button
          disabled={busy || !name.trim()}
          onClick={() => void handleCreate()}
          className={
            compact
              ? "h-9 w-9 shrink-0 rounded-[var(--m3-shape-md)] p-0"
              : "gap-1"
          }
          size={compact ? "sm" : "default"}
          aria-label="プロジェクトを作成"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          {compact ? null : "作成"}
        </Button>
      </div>

      {!projects ? (
        <p className="px-2 text-xs text-[var(--m3-on-surface-variant)]">
          読み込み中...
        </p>
      ) : projects.length === 0 ? (
        <p className="px-2 text-xs text-[var(--m3-on-surface-variant)]">
          まだプロジェクトがありません。名前を付けて作成すると、ワークスペースにフォルダも作られます。
        </p>
      ) : (
        <ul className={compact ? "space-y-0.5 px-1" : "space-y-1"}>
          {projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-2.5 text-left text-sm text-[var(--m3-on-surface)] transition-[background-color,color] duration-[var(--m3-duration-medium)] ease-[var(--m3-motion-standard)]",
                  compact
                    ? "rounded-[var(--m3-shape-md)] px-3 py-2 hover:bg-[var(--m3-surface-container)]"
                    : "rounded-[var(--m3-shape-md)] px-2 py-1.5 hover:bg-[var(--m3-surface-container)]",
                )}
                onClick={() => {
                  const folder = project.slug || project.name;
                  if (compact) {
                    // Never expand the inline browser inside Work — layout breaks.
                    onOpenFiles?.(folder);
                    return;
                  }
                  setFilesPath(folder);
                  setShowFiles(true);
                  onOpenFiles?.(folder);
                }}
              >
                <FolderKanban className="h-4 w-4 shrink-0 text-[var(--m3-on-surface-variant)]" />
                <span className="truncate">{project.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {showFiles && (
        <div
          className={
            compact ? "mx-2 h-[min(50dvh,420px)]" : "h-[min(50dvh,420px)]"
          }
        >
          <FileBrowser initialPath={filesPath} />
        </div>
      )}

      {message && (
        <p className="px-2 text-xs text-[var(--m3-on-surface-variant)]">
          {message}
        </p>
      )}
    </div>
  );
}
