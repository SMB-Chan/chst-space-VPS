import { useCallback, useEffect, useState } from "react";
import {
  Archive,
  Check,
  Copy,
  Loader2,
  Plus,
  ScrollText,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Surface } from "@/design-system/surface";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface ToolItem {
  id: number;
  name: string;
  slug: string;
  summary: string;
  language: string;
  code: string;
  usage: string;
  tags: string[];
  status: "active" | "deprecated" | "archived";
  version: number;
  changeSummary: string;
  useCount: number;
  lastUsedAt: string | null;
  deletedAt: string | null;
}

interface ProjectOption {
  id: number;
  name: string;
}

export function ToolBankSection() {
  const [tools, setTools] = useState<ToolItem[] | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showPolicy, setShowPolicy] = useState(false);
  const [policyDoc, setPolicyDoc] = useState("");
  const [draft, setDraft] = useState({
    name: "",
    code: "",
    summary: "",
    language: "typescript",
    usage: "",
    tags: "",
  });
  const [edit, setEdit] = useState<{
    code: string;
    summary: string;
    changeSummary: string;
  } | null>(null);
  const [copyProjectId, setCopyProjectId] = useState<number | "">("");

  const refresh = useCallback(async () => {
    const res = await fetch(`${BASE}/api/tool-bank`, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { tools: ToolItem[] };
    setTools(data.tools);
    return data.tools;
  }, []);

  useEffect(() => {
    void refresh().catch(() => setMessage("ツールバンクを読み込めませんでした。"));
    void fetch(`${BASE}/api/projects`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { projects?: ProjectOption[] } | null) => {
        if (data?.projects) setProjects(data.projects);
      })
      .catch(() => {});
    void fetch(`${BASE}/api/tool-bank/policy`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { doc?: string } | null) => {
        if (data?.doc) setPolicyDoc(data.doc);
      })
      .catch(() => {});
  }, [refresh]);

  const selected = tools?.find((t) => t.id === selectedId) ?? null;

  const handleCreate = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${BASE}/api/tool-bank`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          code: draft.code,
          summary: draft.summary,
          language: draft.language,
          usage: draft.usage,
          tags: draft.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        tool?: ToolItem;
        error?: string;
      };
      if (!res.ok || !data.tool) throw new Error(data.error || "登録に失敗");
      setShowCreate(false);
      setDraft({
        name: "",
        code: "",
        summary: "",
        language: "typescript",
        usage: "",
        tags: "",
      });
      await refresh();
      setSelectedId(data.tool.id);
      setMessage(`「${data.tool.name}」を bank しました。`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "登録に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const handleUpdate = async () => {
    if (!selected || !edit) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${BASE}/api/tool-bank/${selected.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: edit.code,
          summary: edit.summary,
          changeSummary: edit.changeSummary,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "更新に失敗");
      setEdit(null);
      await refresh();
      setMessage("更新しました（version を加算）。");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "更新に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const handleSoftDelete = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await fetch(`${BASE}/api/tool-bank/${selected.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
      setSelectedId(null);
      setMessage("soft delete しました。30日後に物理削除できます。");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "削除に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    if (!selected || copyProjectId === "") return;
    setBusy(true);
    try {
      const res = await fetch(`${BASE}/api/tool-bank/${selected.id}/copy`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: copyProjectId }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "コピーに失敗");
      await refresh();
      setMessage(`プロジェクトへコピーしました (useCount++)。`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "コピーに失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Surface
      tone="low"
      shape="extraLarge"
      className="space-y-4 border border-[var(--m3-outline-variant)] p-5 shadow-[var(--m3-elevation-1)] sm:p-6"
    >
      <div className="space-y-1.5">
        <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
          <ScrollText className="h-4 w-4" />
          ツールバンク
        </h2>
        <p className="text-sm leading-relaxed text-[var(--m3-on-surface-variant)]">
          プロジェクト遂行中に作った再利用価値の高いコードを bank
          し、他プロジェクトへコピーして使います。更新・削除には基準があります。
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="tonal"
          size="sm"
          onClick={() => setShowCreate((v) => !v)}
          className="gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />
          新規 bank
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowPolicy((v) => !v)}
        >
          更新・削除基準
        </Button>
      </div>

      {showPolicy && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-[var(--m3-shape-md)] bg-[var(--m3-surface-container)] p-3 text-xs leading-relaxed text-[var(--m3-on-surface-variant)]">
          {policyDoc || "読み込み中..."}
        </pre>
      )}

      {showCreate && (
        <div className="space-y-2 rounded-[var(--m3-shape-lg)] border border-[var(--m3-outline-variant)] p-3">
          <Input
            placeholder="ツール名"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
          <Input
            placeholder="language (typescript / python / bash)"
            value={draft.language}
            onChange={(e) =>
              setDraft((d) => ({ ...d, language: e.target.value }))
            }
          />
          <Textarea
            placeholder="summary — 何が・どこで使えるか"
            value={draft.summary}
            onChange={(e) => setDraft((d) => ({ ...d, summary: e.target.value }))}
            rows={2}
          />
          <Textarea
            placeholder="code"
            value={draft.code}
            onChange={(e) => setDraft((d) => ({ ...d, code: e.target.value }))}
            rows={8}
            className="font-mono text-xs"
          />
          <Textarea
            placeholder="usage（任意）"
            value={draft.usage}
            onChange={(e) => setDraft((d) => ({ ...d, usage: e.target.value }))}
            rows={2}
          />
          <Input
            placeholder="tags（カンマ区切り）"
            value={draft.tags}
            onChange={(e) => setDraft((d) => ({ ...d, tags: e.target.value }))}
          />
          <Button
            disabled={busy || !draft.name.trim() || !draft.code.trim()}
            onClick={() => void handleCreate()}
          >
            登録
          </Button>
        </div>
      )}

      {!tools ? (
        <div className="flex items-center gap-2 text-sm text-[var(--m3-on-surface-variant)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          読み込み中...
        </div>
      ) : tools.length === 0 ? (
        <p className="text-sm text-[var(--m3-on-surface-variant)]">
          まだ bank されたツールはありません。チャットから
          <code>tool_bank_save</code> でも登録できます。
        </p>
      ) : (
        <div className="space-y-2">
          {tools.map((tool) => (
            <button
              key={tool.id}
              type="button"
              onClick={() => {
                setSelectedId(tool.id);
                setEdit(null);
              }}
              className={
                "flex w-full items-start justify-between gap-3 rounded-[var(--m3-shape-md)] border px-3 py-2 text-left " +
                (selectedId === tool.id
                  ? "border-[var(--m3-primary)] bg-[var(--m3-primary-container)]"
                  : "border-[var(--m3-outline-variant)]")
              }
            >
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  {tool.name}{" "}
                  <span className="text-xs text-[var(--m3-on-surface-variant)]">
                    v{tool.version} · {tool.language} · {tool.status}
                  </span>
                </div>
                <div className="truncate text-xs text-[var(--m3-on-surface-variant)]">
                  {tool.summary || "（要約なし）"} · uses {tool.useCount}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div className="space-y-3 rounded-[var(--m3-shape-lg)] border border-[var(--m3-outline-variant)] p-3">
          <div className="text-sm font-medium">{selected.name}</div>
          {edit ? (
            <>
              <Textarea
                value={edit.summary}
                onChange={(e) =>
                  setEdit((s) => (s ? { ...s, summary: e.target.value } : s))
                }
                rows={2}
                placeholder="summary"
              />
              <Textarea
                value={edit.code}
                onChange={(e) =>
                  setEdit((s) => (s ? { ...s, code: e.target.value } : s))
                }
                rows={8}
                className="font-mono text-xs"
              />
              <Input
                value={edit.changeSummary}
                onChange={(e) =>
                  setEdit((s) =>
                    s ? { ...s, changeSummary: e.target.value } : s,
                  )
                }
                placeholder="changeSummary（必須）何をなぜ変えたか"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy || !edit.changeSummary.trim()}
                  onClick={() => void handleUpdate()}
                >
                  <Check className="mr-1 h-3.5 w-3.5" />
                  保存
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>
                  キャンセル
                </Button>
              </div>
            </>
          ) : (
            <>
              <pre className="max-h-48 overflow-auto rounded bg-[var(--m3-surface-container)] p-2 font-mono text-[11px]">
                {selected.code}
              </pre>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selected.status === "archived"}
                  onClick={() =>
                    setEdit({
                      code: selected.code,
                      summary: selected.summary,
                      changeSummary: "",
                    })
                  }
                >
                  編集
                </Button>
                {projects.length > 0 && (
                  <>
                    <select
                      className="h-8 rounded border border-[var(--m3-outline-variant)] bg-transparent px-2 text-xs"
                      value={copyProjectId}
                      onChange={(e) =>
                        setCopyProjectId(
                          e.target.value ? Number(e.target.value) : "",
                        )
                      }
                    >
                      <option value="">コピー先プロジェクト</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="tonal"
                      disabled={busy || copyProjectId === ""}
                      onClick={() => void handleCopy()}
                    >
                      <Copy className="mr-1 h-3.5 w-3.5" />
                      コピー
                    </Button>
                  </>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || Boolean(selected.deletedAt)}
                  onClick={() => void handleSoftDelete()}
                  className="text-[var(--m3-error)]"
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                  soft delete
                </Button>
                {selected.status === "archived" && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-[var(--m3-on-surface-variant)]">
                    <Archive className="h-3 w-3" />
                    archived
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {message && (
        <p className="text-xs text-[var(--m3-on-surface-variant)]">{message}</p>
      )}
    </Surface>
  );
}
