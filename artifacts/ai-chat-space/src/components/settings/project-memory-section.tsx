import { useCallback, useEffect, useState } from "react";
import { Check, FolderKanban, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Surface } from "@/design-system/surface";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const SECTIONS = [
  { id: "todo", label: "TODO / 次の作業" },
  { id: "credentials", label: "認証情報・接続先" },
  { id: "structure", label: "構成・構造" },
  { id: "decisions", label: "決定事項" },
  { id: "notes", label: "メモ" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

interface ProjectSummary {
  id: number;
  name: string;
  slug: string;
  description: string | null;
}

interface ProjectMemory {
  todo: string;
  credentials: string;
  structure: string;
  decisions: string;
  notes: string;
}

export function ProjectMemorySection() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [memory, setMemory] = useState<ProjectMemory | null>(null);
  const [drafts, setDrafts] = useState<Record<SectionId, string>>({
    todo: "",
    credentials: "",
    structure: "",
    decisions: "",
    notes: "",
  });
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [savingSection, setSavingSection] = useState<SectionId | null>(null);

  const refreshProjects = useCallback(async () => {
    const res = await fetch(`${BASE}/api/projects`, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { projects: ProjectSummary[] };
    setProjects(data.projects);
    return data.projects;
  }, []);

  const loadMemory = useCallback(async (projectId: number) => {
    const res = await fetch(`${BASE}/api/projects/${projectId}/memory`, {
      credentials: "include",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { memory: ProjectMemory };
    setMemory(data.memory);
    setDrafts({
      todo: data.memory.todo,
      credentials: data.memory.credentials,
      structure: data.memory.structure,
      decisions: data.memory.decisions,
      notes: data.memory.notes,
    });
  }, []);

  useEffect(() => {
    void refreshProjects()
      .then((list) => {
        if (list[0]) setSelectedId(list[0].id);
      })
      .catch(() => setMessage("プロジェクト一覧を読み込めませんでした。"));
  }, [refreshProjects]);

  useEffect(() => {
    if (selectedId == null) {
      setMemory(null);
      return;
    }
    void loadMemory(selectedId).catch(() =>
      setMessage("メモリを読み込めませんでした。"),
    );
  }, [selectedId, loadMemory]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${BASE}/api/projects`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        project?: ProjectSummary;
        error?: string;
      };
      if (!res.ok || !data.project) {
        throw new Error(data.error || "作成に失敗しました。");
      }
      setNewName("");
      const list = await refreshProjects();
      setSelectedId(data.project.id);
      setMessage(`プロジェクト「${data.project.name}」を作成しました。`);
      void list;
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "作成に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const handleSaveSection = async (section: SectionId) => {
    if (selectedId == null) return;
    setSavingSection(section);
    setMessage(null);
    try {
      const res = await fetch(
        `${BASE}/api/projects/${selectedId}/memory/${section}`,
        {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: drafts[section] }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "保存に失敗しました。");
      setMessage(
        `${SECTIONS.find((s) => s.id === section)?.label} を保存しました。`,
      );
      await loadMemory(selectedId);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setSavingSection(null);
    }
  };

  const handleDelete = async () => {
    if (selectedId == null) return;
    if (
      !window.confirm(
        "このプロジェクトを削除しますか？メモリとワークスペースフォルダも削除されます。",
      )
    )
      return;
    setBusy(true);
    try {
      const res = await fetch(`${BASE}/api/projects/${selectedId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      setSelectedId(null);
      const list = await refreshProjects();
      setSelectedId(list[0]?.id ?? null);
      setMessage("プロジェクトとワークスペースフォルダを削除しました。");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "削除に失敗しました。");
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
          <FolderKanban className="h-4 w-4" />
          プロジェクトメモリ
        </h2>
        <p className="text-sm leading-relaxed text-[var(--m3-on-surface-variant)]">
          プロジェクトごとに TODO・認証情報・構成・決定事項を保存します。
          会話をプロジェクトに紐づけると、モデルを切り替えても同じ文脈で作業を続けられます。
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="例: Chat-Space VPS"
          className="max-w-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleCreate();
          }}
        />
        <Button
          variant="tonal"
          disabled={busy || !newName.trim()}
          onClick={() => void handleCreate()}
          className="gap-1.5"
        >
          <Plus className="h-4 w-4" />
          作成
        </Button>
      </div>

      {!projects ? (
        <div className="flex items-center gap-2 text-sm text-[var(--m3-on-surface-variant)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          読み込み中...
        </div>
      ) : projects.length === 0 ? (
        <p className="text-sm text-[var(--m3-on-surface-variant)]">
          プロジェクトはまだありません。上の欄から作成してください。
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {projects.map((project) => (
              <Button
                key={project.id}
                size="sm"
                variant={selectedId === project.id ? "filled" : "outline"}
                onClick={() => setSelectedId(project.id)}
              >
                {project.name}
              </Button>
            ))}
          </div>

          {selectedId != null && memory ? (
            <div className="space-y-4">
              {SECTIONS.map((section) => (
                <div key={section.id} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      className="text-xs font-medium text-[var(--m3-on-surface-variant)]"
                      htmlFor={`pm-${section.id}`}
                    >
                      {section.label}
                    </label>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={savingSection === section.id}
                      onClick={() => void handleSaveSection(section.id)}
                      className="h-7 gap-1 px-2 text-xs"
                    >
                      {savingSection === section.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Check className="h-3 w-3" />
                      )}
                      保存
                    </Button>
                  </div>
                  <Textarea
                    id={`pm-${section.id}`}
                    value={drafts[section.id]}
                    onChange={(e) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [section.id]: e.target.value,
                      }))
                    }
                    rows={section.id === "credentials" ? 3 : 4}
                    placeholder={
                      section.id === "credentials"
                        ? "接続先・キーの場所など（チャットへは注意書き付きで注入されます）"
                        : "Markdown 可"
                    }
                    className="text-sm"
                  />
                </div>
              ))}
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void handleDelete()}
                className="gap-1.5 text-[var(--m3-error)]"
              >
                <Trash2 className="h-4 w-4" />
                プロジェクトを削除
              </Button>
            </div>
          ) : null}
        </>
      )}

      {message && (
        <p className="text-xs text-[var(--m3-on-surface-variant)]">{message}</p>
      )}
    </Surface>
  );
}
