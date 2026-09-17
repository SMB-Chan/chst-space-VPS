import { useCallback, useEffect, useState } from "react";
import {
  ChevronLeft,
  File,
  FileText,
  Folder,
  FolderPlus,
  Loader2,
  RefreshCw,
  Save,
  Trash2,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface FileItem {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: string | null;
}

interface ListResponse {
  path: string;
  parent: string | null;
  items: FileItem[];
  root: string;
}

interface FileBrowserProps {
  className?: string;
  /** Optional: open a specific project folder first. */
  initialPath?: string;
}

export function FileBrowser({ className, initialPath = "" }: FileBrowserProps) {
  const [path, setPath] = useState(initialPath);
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    path: string;
    content: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [newDir, setNewDir] = useState("");
  const [showNewDir, setShowNewDir] = useState(false);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${BASE}/api/files?path=${encodeURIComponent(p)}`,
        { credentials: "include" },
      );
      const body = (await res.json().catch(() => ({}))) as ListResponse & {
        error?: string;
      };
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "読み込みに失敗しました。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(path);
  }, [path, load]);

  useEffect(() => {
    if (initialPath) setPath(initialPath);
  }, [initialPath]);

  const openItem = async (item: FileItem) => {
    if (item.isDir) {
      setEditing(null);
      setPath(item.path);
      return;
    }
    try {
      const res = await fetch(
        `${BASE}/api/files/content?path=${encodeURIComponent(item.path)}`,
        { credentials: "include" },
      );
      const body = (await res.json().catch(() => ({}))) as {
        content?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error || "読み込み失敗");
      setEditing({ path: item.path, content: body.content ?? "" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "ファイルを開けませんでした。");
    }
  };

  const saveFile = async () => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${BASE}/api/files/content`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: editing.path, content: editing.content }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || "保存失敗");
      await load(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setSaving(false);
    }
  };

  const mkdir = async () => {
    const name = newDir.trim();
    if (!name) return;
    const target = path ? `${path}/${name}` : name;
    try {
      const res = await fetch(`${BASE}/api/files/mkdir`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: target }),
      });
      if (!res.ok) throw new Error("作成に失敗");
      setNewDir("");
      setShowNewDir(false);
      await load(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "作成に失敗しました。");
    }
  };

  const remove = async (item: FileItem) => {
    if (!window.confirm(`「${item.name}」を削除しますか？`)) return;
    try {
      const res = await fetch(
        `${BASE}/api/files?path=${encodeURIComponent(item.path)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok) throw new Error("削除に失敗");
      if (editing?.path === item.path) setEditing(null);
      await load(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "削除に失敗しました。");
    }
  };

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col rounded-[var(--m3-shape-xl)] border border-[var(--m3-outline-variant)] bg-[var(--m3-surface-container-low)]",
        className,
      )}
      data-testid="file-browser"
    >
      <div className="flex items-center gap-2 border-b border-[var(--m3-outline-variant)] px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          disabled={!data?.parent && !path}
          onClick={() => {
            setEditing(null);
            setPath(data?.parent ?? "");
          }}
          aria-label="親フォルダ"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--m3-on-surface-variant)]">
          /{path || "."}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => void load(path)}
          aria-label="再読み込み"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => setShowNewDir((v) => !v)}
          aria-label="フォルダ作成"
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {showNewDir && (
        <div className="flex gap-2 border-b border-[var(--m3-outline-variant)] p-2">
          <Input
            value={newDir}
            onChange={(e) => setNewDir(e.target.value)}
            placeholder="新しいフォルダ名"
            className="h-8 text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter") void mkdir();
            }}
          />
          <Button size="sm" onClick={() => void mkdir()}>
            作成
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-[var(--m3-on-surface-variant)]" />
          </div>
        ) : error ? (
          <p className="p-4 text-sm text-[var(--m3-error)]">{error}</p>
        ) : (
          <ul className="divide-y divide-[var(--m3-outline-variant)]/50">
            {(data?.items ?? []).map((item) => (
              <li key={item.path}>
                <div className="flex items-center gap-2 px-3 py-2 hover:bg-[var(--m3-surface-container)]">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => void openItem(item)}
                  >
                    {item.isDir ? (
                      <Folder className="h-4 w-4 shrink-0 text-[var(--m3-primary)]" />
                    ) : (
                      <FileText className="h-4 w-4 shrink-0 text-[var(--m3-on-surface-variant)]" />
                    )}
                    <span className="truncate text-sm">{item.name}</span>
                  </button>
                  {!item.isDir && (
                    <a
                      href={`${BASE}/api/files/download?path=${encodeURIComponent(item.path)}`}
                      className="p-1 text-[var(--m3-on-surface-variant)] hover:text-[var(--m3-on-surface)]"
                      title="ダウンロード"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </a>
                  )}
                  <button
                    type="button"
                    className="p-1 text-[var(--m3-on-surface-variant)] hover:text-[var(--m3-error)]"
                    onClick={() => void remove(item)}
                    aria-label={`${item.name} を削除`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
            {(data?.items.length ?? 0) === 0 && (
              <li className="px-4 py-6 text-center text-sm text-[var(--m3-on-surface-variant)]">
                このフォルダは空です
              </li>
            )}
          </ul>
        )}
      </div>

      {editing && (
        <div className="flex min-h-0 flex-[1.2] flex-col border-t border-[var(--m3-outline-variant)]">
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <File className="h-3.5 w-3.5" />
              <span className="truncate font-mono">{editing.path}</span>
            </div>
            <div className="flex gap-1">
              <Button
                size="sm"
                disabled={saving}
                onClick={() => void saveFile()}
                className="h-7 gap-1 px-2 text-xs"
              >
                {saving ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Save className="h-3 w-3" />
                )}
                保存
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => setEditing(null)}
              >
                閉じる
              </Button>
            </div>
          </div>
          <textarea
            value={editing.content}
            onChange={(e) =>
              setEditing((s) =>
                s ? { ...s, content: e.target.value } : s,
              )
            }
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-[var(--m3-surface)] px-3 py-2 font-mono text-xs outline-none"
          />
        </div>
      )}
    </div>
  );
}
