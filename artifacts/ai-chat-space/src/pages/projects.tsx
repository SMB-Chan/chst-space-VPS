import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { FolderKanban, Loader2, Plus, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Surface } from "@/design-system/surface";
import {
  EmptyState,
  ErrorState,
  ScreenHeader,
} from "@/design-system/components";
import { Spinner } from "@/components/ui/spinner";
import { formatDateJa } from "@/lib/projects-format";
import { projectsApi, type ProjectRecord } from "@/lib/projects-api";

export function ProjectsPage() {
  const [, setLocation] = useLocation();
  const [projects, setProjects] = useState<ProjectRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await projectsApi.list();
      setProjects(list);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : null);
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setCreateError("プロジェクト名を入力してください。");
      return;
    }
    setBusy(true);
    setCreateError(null);
    try {
      const project = await projectsApi.create({
        name: trimmed,
        description: description.trim() || null,
      });
      setName("");
      setDescription("");
      setLocation(`/projects/${project.id}`);
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "作成に失敗しました。",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6 sm:py-10">
        <ScreenHeader
          title="プロジェクト"
          description="会話とカスタム指示、参考ファイルをまとめて管理します。同じ指示や資料を毎回読み込まずに済みます。"
        />

        <Surface
          tone="low"
          shape="extraLarge"
          className="space-y-4 border border-[var(--m3-outline-variant)] p-5 shadow-[var(--m3-elevation-1)] sm:p-6"
        >
          <div className="space-y-1">
            <h2 className="text-base font-semibold tracking-tight">
              新しいプロジェクト
            </h2>
            <p className="text-sm leading-relaxed text-[var(--m3-on-surface-variant)]">
              名前は後から変更できます。説明は任意です。
            </p>
          </div>
          <form className="space-y-3" onSubmit={handleCreate}>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-[var(--m3-on-surface-variant)]">
                プロジェクト名
              </span>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例: 週次レポート"
                maxLength={120}
                required
                aria-label="プロジェクト名"
                data-testid="project-name-input"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-[var(--m3-on-surface-variant)]">
                説明（任意）
              </span>
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="このプロジェクトで何をするか一言で"
                maxLength={2000}
                rows={3}
                aria-label="説明"
                data-testid="project-description-input"
              />
            </label>
            {createError ? (
              <p className="text-xs text-[var(--m3-error)]">{createError}</p>
            ) : null}
            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={busy || !name.trim()}
                className="gap-1.5"
                data-testid="project-create-submit"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                作成
              </Button>
            </div>
          </form>
        </Surface>

        <section className="space-y-3">
          <h2 className="px-1 text-sm font-semibold tracking-tight text-[var(--m3-on-surface-variant)]">
            あなたのプロジェクト
          </h2>

          {projects === null ? (
            <div
              className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--m3-on-surface-variant)]"
              role="status"
            >
              <Spinner className="h-4 w-4" />
              読み込み中...
            </div>
          ) : loadError ? (
            <ErrorState
              title="プロジェクトを読み込めませんでした"
              description={loadError}
              primaryAction={
                <Button variant="tonal" onClick={() => void refresh()}>
                  再試行
                </Button>
              }
            />
          ) : projects.length === 0 ? (
            <EmptyState
              icon={<FolderKanban className="h-6 w-6" />}
              title="プロジェクトがまだありません"
              description="上のフォームから最初のプロジェクトを作成すると、すべてのチャットに共通の指示とファイルをまとめて使えます。"
            />
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {projects.map((project) => (
                <li key={project.id}>
                  <Link
                    href={`/projects/${project.id}`}
                    className="group block h-full"
                    data-testid={`project-card-${project.id}`}
                  >
                    <Surface
                      tone="low"
                      shape="large"
                      className="flex h-full flex-col gap-3 border border-[var(--m3-outline-variant)] p-4 transition-[background-color,border-color,box-shadow] hover:border-[var(--m3-primary)]/60 hover:shadow-[var(--m3-elevation-2)]"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--m3-shape-md)] bg-[var(--m3-primary-container)] text-[var(--m3-on-primary-container)]">
                            <FolderKanban className="h-4 w-4" />
                          </span>
                          <h3 className="truncate text-sm font-semibold">
                            {project.name}
                          </h3>
                        </div>
                        <ArrowRight className="h-4 w-4 shrink-0 text-[var(--m3-on-surface-variant)] transition-transform group-hover:translate-x-0.5" />
                      </div>
                      {project.description ? (
                        <p className="line-clamp-2 text-xs leading-relaxed text-[var(--m3-on-surface-variant)]">
                          {project.description}
                        </p>
                      ) : (
                        <p className="text-xs italic text-[var(--m3-on-surface-variant)]">
                          説明はありません
                        </p>
                      )}
                      <p className="mt-auto text-[10px] uppercase tracking-[0.16em] text-[var(--m3-on-surface-variant)]">
                        作成日 {formatDateJa(project.createdAt)}
                      </p>
                    </Surface>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

export default ProjectsPage;
