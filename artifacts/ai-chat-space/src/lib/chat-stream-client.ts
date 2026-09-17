import type { MutableRefObject } from "react";
import type { ChatArtifact } from "@/components/chat/message-feed";
import type {
  FileFormat,
  OutgoingAttachment,
} from "@/components/chat/message-input";
import type { ReasoningLevel } from "./reasoning";
import { loadSettings } from "./settings";
import {
  normalizeFactualityReport,
  type FactualityReport,
} from "@/components/chat/factuality-card";
import { ChatStreamError, readChatEvents } from "./chat-events";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export async function streamMessage(
  conversationId: number,
  content: string,
  model: string,
  reasoning: ReasoningLevel,
  onChunk: (text: string) => void,
  onDone: () => void | Promise<void>,
  onError: (err: Error, turnSaved?: boolean) => void,
  onStatus: (status: string | null, query?: string) => void,
  onSpecialist: (event: {
    capability: string;
    phase: string;
    message?: string;
  }) => void,
  onSearchWarning: (message: string) => void,
  onResearchStep: (step: { step: number; maxSteps: number }) => void,
  onSources: (
    sources: {
      title: string;
      url: string;
      publishedAt?: string | null;
      fetchedAt?: string | null;
    }[],
  ) => void,
  onFactuality: (report: FactualityReport) => void,
  onSkills: (skills: { id: string; label: string }[]) => void,
  onAudit: (text: string) => void,
  onArtifacts: (artifacts: ChatArtifact[]) => void,
  onResetContent: () => void,
  onPatch: (operations: unknown) => void,
  onFile: (file: { id: number; filename: string; mimeType: string }) => void,
  artifactBlobUrlCache: MutableRefObject<Map<string, string>>,
  signal?: AbortSignal,
  extra?: {
    ephemeral?: boolean;
    history?: { role: "user" | "assistant"; content: string }[];
    auditModel?: string;
    fileFormat?: FileFormat;
    attachments?: OutgoingAttachment[];
    translationMode?: string;
    codingMode?: boolean;
    projectId?: number | null;
    onFilesMeta?: (
      files: {
        path: string;
        kind: string;
        added?: number | null;
        removed?: number | null;
      }[],
    ) => void;
  },
) {
  try {
    const path = extra?.ephemeral
      ? `${BASE}/api/openai/ephemeral/messages`
      : `${BASE}/api/openai/conversations/${conversationId}/messages`;
    const auditQuery = extra?.auditModel
      ? `&auditModel=${encodeURIComponent(extra.auditModel)}&auditReasoning=${encodeURIComponent(loadSettings().auditReasoning)}`
      : "";
    const translateQuery = extra?.translationMode
      ? `&translate=${encodeURIComponent(extra.translationMode)}`
      : "";
    const res = await fetch(
      `${path}?model=${encodeURIComponent(model)}&reasoning=${encodeURIComponent(reasoning)}${auditQuery}${translateQuery}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          modelId: model,
          ...(extra?.fileFormat ? { fileFormat: extra.fileFormat } : {}),
          ...(extra?.codingMode
            ? { codingMode: true, projectId: extra.projectId ?? null }
            : {}),
          ...(extra?.attachments?.length
            ? {
                attachments: extra.attachments.map((attachment) => ({
                  // バイナリ文書・音声は base64 でも kind "file"（画像のみ "image"）
                  kind:
                    attachment.kind ?? (attachment.isBase64 ? "image" : "file"),
                  name: attachment.name,
                  content: attachment.content,
                  isBase64: attachment.isBase64,
                })),
              }
            : {}),
          ...(extra?.ephemeral && extra.history
            ? { history: extra.history }
            : {}),
        }),
        credentials: "include",
        signal,
      },
    );

    if (!res.ok) {
      // JSONエラー本文を読み取り、具体的なメッセージを表示する
      let errorMessage: string;
      try {
        const errorBody = await res.json();
        errorMessage = errorBody.error ?? errorBody.message ?? res.statusText;
      } catch {
        errorMessage = res.statusText || `エラー (HTTP ${res.status})`;
      }
      throw new Error(errorMessage);
    }

    if (!res.body) throw new Error("応答ストリームを開けませんでした。");
    await readChatEvents(
      res.body,
      (parsed) => {
        if (parsed.status === "skill" && Array.isArray(parsed.skills)) {
          onSkills(
            parsed.skills.filter(
              (s): s is { id: string; label: string } =>
                !!s &&
                typeof s === "object" &&
                typeof (s as { id?: unknown }).id === "string" &&
                typeof (s as { label?: unknown }).label === "string",
            ),
          );
        }
        if (parsed.status === "searching")
          onStatus("searching", parsed.query as string | undefined);
        if (parsed.status === "fetching") onStatus("fetching");
        if (parsed.status === "researching") {
          onStatus("researching");
          if (
            typeof parsed.step === "number" &&
            typeof parsed.maxSteps === "number"
          ) {
            onResearchStep({ step: parsed.step, maxSteps: parsed.maxSteps });
          }
        }
        if (parsed.status === "reading-images") onStatus("reading-images");
        if (parsed.status === "reading-files") onStatus("reading-files");
        if (parsed.status === "thinking") onStatus("thinking");
        if (parsed.status === "generating") onStatus("generating");
        if (
          (parsed.status === "specialist" ||
            parsed.status === "specialist_warning") &&
          typeof parsed.capability === "string" &&
          typeof parsed.phase === "string"
        ) {
          onSpecialist({
            capability: parsed.capability,
            phase: parsed.phase,
            message:
              typeof parsed.message === "string" ? parsed.message : undefined,
          });
          onStatus("specialist");
          if (
            parsed.status === "specialist_warning" &&
            typeof parsed.message === "string"
          ) {
            onSearchWarning(parsed.message);
          }
        }
        if (parsed.status === "auditing") onStatus("auditing");
        if (parsed.status === "verifying") onStatus("verifying");
        if (parsed.status === "revising") {
          onStatus("revising");
          if (parsed.resetContent) onResetContent();
          if (Array.isArray(parsed.patch)) onPatch(parsed.patch);
        }
        if (typeof parsed.audit === "string" && parsed.audit) {
          onStatus("auditing");
          onAudit(parsed.audit);
        }
        if (parsed.status === "generating-file") onStatus("generating-file");
        if (parsed.status === "reviewing-layout") onStatus("reviewing-layout");
        if (parsed.status === "revising-layout") onStatus("revising-layout");
        if (
          parsed.status === "file_warning" &&
          typeof parsed.message === "string"
        ) {
          onSearchWarning(parsed.message);
        }
        if (
          parsed.status === "search_warning" &&
          typeof parsed.message === "string"
        ) {
          onSearchWarning(parsed.message);
        }
        if (
          parsed.file &&
          typeof parsed.file === "object" &&
          parsed.file !== null
        ) {
          const f = parsed.file as {
            id?: unknown;
            filename?: unknown;
            mimeType?: unknown;
          };
          if (
            typeof f.id === "number" &&
            typeof f.filename === "string" &&
            typeof f.mimeType === "string"
          ) {
            onFile({ id: f.id, filename: f.filename, mimeType: f.mimeType });
          }
        }
        if (Array.isArray(parsed.sources)) {
          onSources(
            parsed.sources as {
              title: string;
              url: string;
              publishedAt?: string | null;
              fetchedAt?: string | null;
            }[],
          );
        }
        if (parsed.factuality) {
          const report = normalizeFactualityReport(parsed.factuality);
          if (report) onFactuality(report);
        }
        if (Array.isArray(parsed.artifacts)) {
          const artifacts = parsed.artifacts.flatMap((item): ChatArtifact[] => {
            if (!item || typeof item !== "object") return [];
            const raw = item as Record<string, unknown>;
            if (
              typeof raw.filename !== "string" ||
              typeof raw.mime !== "string"
            )
              return [];
            const artifact: ChatArtifact = {
              id: typeof raw.id === "number" ? raw.id : undefined,
              filename: raw.filename,
              mime: raw.mime,
              size: typeof raw.size === "number" ? raw.size : 0,
              downloadUrl:
                typeof raw.downloadUrl === "string"
                  ? raw.downloadUrl
                  : undefined,
              content:
                typeof raw.content === "string" ? raw.content : undefined,
            };
            if (!artifact.downloadUrl && artifact.content) {
              if (
                (artifact.mime.startsWith("image/") ||
                  artifact.mime.startsWith("audio/")) &&
                artifact.content.startsWith("data:")
              ) {
                artifact.downloadUrl = artifact.content;
              } else {
                const cacheKey = `${artifact.filename}:${artifact.content.length}:${artifact.mime}`;
                let url = artifactBlobUrlCache.current.get(cacheKey);
                if (!url) {
                  url = URL.createObjectURL(
                    new Blob([artifact.content], { type: artifact.mime }),
                  );
                  artifactBlobUrlCache.current.set(cacheKey, url);
                }
                artifact.downloadUrl = url;
              }
            }
            return artifact.downloadUrl ? [artifact] : [];
          });
          if (artifacts.length > 0) onArtifacts(artifacts);
        }
        if (Array.isArray(parsed.filesMeta) && extra?.onFilesMeta) {
          const files = parsed.filesMeta.flatMap((item) => {
            if (!item || typeof item !== "object") return [];
            const record = item as Record<string, unknown>;
            if (typeof record.path !== "string" || !record.path) return [];
            if (
              record.kind !== "edit" &&
              record.kind !== "create" &&
              record.kind !== "generate"
            ) {
              return [];
            }
            return [
              {
                path: record.path,
                kind: record.kind,
                added:
                  typeof record.added === "number" ? record.added : undefined,
                removed:
                  typeof record.removed === "number"
                    ? record.removed
                    : undefined,
              },
            ];
          });
          if (files.length > 0) extra.onFilesMeta(files);
        }
        if (typeof parsed.content === "string" && parsed.content) {
          if (parsed.status === "revising") {
            onStatus("revising");
          } else {
            onStatus("generating");
          }
          onChunk(parsed.content);
        }
      },
      signal,
    );
    if (!signal?.aborted) await onDone();
  } catch (err) {
    if (signal?.aborted) return;
    if (err instanceof DOMException && err.name === "AbortError") return;
    if (err instanceof Error && err.name === "AbortError") return;
    onError(
      err instanceof Error ? err : new Error(String(err)),
      err instanceof ChatStreamError && err.turnSaved,
    );
  }
}
