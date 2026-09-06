import type { Response } from "express";
import type { ExtractedArtifact } from "./artifacts";
import type { FactualityReport } from "./factuality";
import type { GeneratedFile } from "./file-generation";
import { logger, safeFailureFields } from "./logger";
import { executeRunStep, failCurrentRun } from "./run-execution";
import type { GeneratedAsset } from "./specialist-capabilities";

export interface ChatCompletionInput {
  content: string;
  sources: {
    title: string;
    url: string;
    publishedAt?: string | null;
    fetchedAt?: string | null;
  }[];
  audit?: { content: string; modelId: string };
  factuality?: FactualityReport;
  artifacts?: ExtractedArtifact[];
  generatedFiles?: GeneratedFile[];
  generatedAssets?: GeneratedAsset[];
}

export interface ChatCompletionPersistenceResult {
  artifacts?: {
    sourceIndex: number;
    id: number;
    filename: string;
    mime: string;
    size: number;
  }[];
  assets?: { id: number; filename: string; mimeType: string; size: number }[];
  quotaExceeded?: boolean;
}

export type ChatCompletionCallback = (
  input: ChatCompletionInput,
) => Promise<ChatCompletionPersistenceResult | void>;

interface ArtifactSsePayload {
  id?: number;
  filename: string;
  mime: string;
  size: number;
  downloadUrl?: string;
  content?: string;
}

export function buildArtifactSsePayload(args: {
  artifacts: ExtractedArtifact[];
  saved?: ChatCompletionPersistenceResult["artifacts"];
  includeContent: boolean;
}): ArtifactSsePayload[] {
  const saved = args.saved ?? [];
  return args.artifacts.map((artifact, index) => {
    const persisted = saved.find((item) => item.sourceIndex === index);
    const payload: ArtifactSsePayload = {
      id: persisted?.id,
      filename: persisted?.filename ?? artifact.filename,
      mime: persisted?.mime ?? artifact.mime,
      size: persisted?.size ?? artifact.size,
      downloadUrl: persisted
        ? `/api/openai/artifacts/${persisted.id}`
        : undefined,
    };
    if (args.includeContent) payload.content = artifact.content;
    return payload;
  });
}

function writeEvent(res: Response, event: unknown): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** Persist the final turn, then emit only artifacts backed by that outcome. */
export async function persistAndEmitChatCompletion(args: {
  res: Response;
  clientGone: () => boolean;
  onComplete?: ChatCompletionCallback;
  input: ChatCompletionInput;
  includeArtifactContent: boolean;
}): Promise<boolean> {
  let completion: ChatCompletionPersistenceResult | void;
  try {
    completion = args.onComplete
      ? await executeRunStep(
          "persistence",
          () => args.onComplete!(args.input),
          { metadata: { phase: "chat_completion" } },
        )
      : undefined;
  } catch (error) {
    failCurrentRun("CHAT_COMPLETION_PERSIST_FAILED");
    logger.error(
      safeFailureFields(error, "chat-stream", "CHAT_COMPLETION_PERSIST_FAILED"),
      "Failed to persist chat completion",
    );
    if (!args.clientGone()) {
      writeEvent(args.res, {
        error: "メッセージの保存に失敗しました。もう一度お試しください。",
      });
    }
    return false;
  }

  if (completion?.quotaExceeded && !args.clientGone()) {
    writeEvent(args.res, {
      status: "file_warning",
      message:
        "保存容量の上限により、一部の生成ファイルを保存できませんでした。",
    });
  }

  if (completion?.assets?.length && !args.clientGone()) {
    for (const asset of completion.assets) {
      writeEvent(args.res, { file: asset });
    }
  }

  const generatedAssets = args.input.generatedAssets ?? [];
  if (
    generatedAssets.length > 0 &&
    !completion?.assets?.length &&
    !args.clientGone()
  ) {
    writeEvent(args.res, {
      artifacts: generatedAssets.map((asset) => ({
        filename: asset.filename,
        mime: asset.mimeType,
        size: asset.size,
        content: `data:${asset.mimeType};base64,${asset.buffer.toString("base64")}`,
      })),
    });
  }

  const artifacts = args.input.artifacts ?? [];
  if (artifacts.length > 0 && !args.clientGone()) {
    writeEvent(args.res, {
      artifacts: buildArtifactSsePayload({
        artifacts,
        saved: completion?.artifacts,
        includeContent: args.includeArtifactContent,
      }),
    });
  }

  if (!args.clientGone()) writeEvent(args.res, { done: true });
  return true;
}
