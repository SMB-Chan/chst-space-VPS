import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  assets,
  artifacts,
  conversations,
  messages,
} from "@workspace/db/schema";
import type { ExtractedArtifact } from "./artifacts";
import type { GeneratedFile } from "./file-generation";
import type { GeneratedAsset } from "./specialist-capabilities";
import { validateGeneratedAsset } from "./generated-assets";
import { logger } from "./logger";
import type { FactualityReport } from "./factuality";

export const DEFAULT_MAX_USER_GENERATED_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ARTIFACTS_PER_MESSAGE = 3;

export interface PersistedGeneratedAsset {
  id: number;
  filename: string;
  mimeType: string;
  size: number;
}

export interface PersistedTextArtifact {
  sourceIndex: number;
  id: number;
  filename: string;
  mime: string;
  size: number;
}

export interface PersistCompletionResult {
  assets: PersistedGeneratedAsset[];
  artifacts: PersistedTextArtifact[];
  quotaExceeded: boolean;
}

export interface PersistChatCompletionInput {
  userId: string;
  conversationId: number;
  userContent: string;
  assistantContent: string;
  modelId: string;
  sources: { title: string; url: string }[];
  audit?: { content: string; modelId: string };
  factuality?: FactualityReport;
  generatedFiles?: GeneratedFile[];
  generatedAssets?: GeneratedAsset[];
  extractedArtifacts?: ExtractedArtifact[];
}

function parseQuotaBytes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "")
    return DEFAULT_MAX_USER_GENERATED_FILE_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0)
    return DEFAULT_MAX_USER_GENERATED_FILE_BYTES;
  return value;
}

/**
 * Total durable generated-file quota per user. This covers both binary
 * PDF/Office assets and text-like downloadable artifacts. A value of 0 means
 * unlimited storage; invalid values fall back to 50 MiB.
 */
export function getGeneratedFileQuotaBytes(
  env: { MAX_USER_GENERATED_FILE_BYTES?: string } = process.env,
): number {
  return parseQuotaBytes(env.MAX_USER_GENERATED_FILE_BYTES);
}

function validateGeneratedFile(file: GeneratedFile): void {
  if (
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.buffer.length !== file.size
  ) {
    throw new Error("Generated file metadata does not match its buffer");
  }
}

/**
 * Persist a completed chat response and every downloadable file in one DB
 * transaction. Generated binaries remain in memory until this function runs,
 * so a message-persistence failure cannot leave an unreachable permanent
 * asset behind.
 *
 * The per-user advisory transaction lock serializes quota decisions even when
 * Autoscale serves concurrent requests in separate Node processes.
 */
export async function persistChatCompletion(
  input: PersistChatCompletionInput,
  options: { quotaBytes?: number } = {},
): Promise<PersistCompletionResult> {
  const generatedFiles = input.generatedFiles ?? [];
  const generatedAssets = input.generatedAssets ?? [];
  for (const file of generatedFiles) validateGeneratedFile(file);
  for (const asset of generatedAssets) {
    try {
      validateGeneratedAsset(asset);
    } catch {
      throw new Error("Generated specialist asset metadata is invalid");
    }
    if (
      asset.capability !== "image-generate" &&
      asset.capability !== "image-edit" &&
      asset.capability !== "audio-synthesis"
    ) {
      throw new Error("Generated specialist asset metadata is invalid");
    }
  }

  const quotaBytes = options.quotaBytes ?? getGeneratedFileQuotaBytes();
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 0) {
    throw new Error("Generated-file quota must be a non-negative safe integer");
  }

  return db.transaction(async (tx) => {
    // Serialize all generated-file quota decisions for one authenticated user
    // across conversations and across independent Autoscale processes.
    const lockKey = `chat-space:generated-files:${input.userId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

    // The conversation may have been deleted while the model was generating.
    // Re-check ownership inside the same transaction that will persist data.
    const [ownedConversation] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.userId, input.userId),
        ),
      )
      .limit(1);
    if (!ownedConversation) {
      throw new Error("Conversation is no longer available for persistence");
    }

    let usedBytes = 0;
    const hasCandidates =
      generatedFiles.length > 0 ||
      generatedAssets.length > 0 ||
      (input.extractedArtifacts?.length ?? 0) > 0;
    if (quotaBytes > 0 && hasCandidates) {
      const binaryRows = await tx
        .select({ size: assets.size })
        .from(assets)
        .innerJoin(conversations, eq(assets.conversationId, conversations.id))
        .where(eq(conversations.userId, input.userId));
      const textRows = await tx
        .select({ size: artifacts.size })
        .from(artifacts)
        .where(eq(artifacts.userId, input.userId));
      usedBytes = [...binaryRows, ...textRows].reduce(
        (sum, row) => sum + row.size,
        0,
      );
    }

    let quotaExceeded = false;
    const acceptedGeneratedFiles: GeneratedFile[] = [];
    const acceptedGeneratedAssets: GeneratedAsset[] = [];
    const acceptedArtifacts: Array<{
      sourceIndex: number;
      artifact: ExtractedArtifact;
    }> = [];

    const acceptIfWithinQuota = (size: number): boolean => {
      if (quotaBytes === 0 || usedBytes + size <= quotaBytes) {
        usedBytes += size;
        return true;
      }
      quotaExceeded = true;
      return false;
    };

    // A specifically requested PDF/Office file takes precedence over optional
    // text artifact blocks when the remaining storage budget is tight.
    for (const file of generatedFiles) {
      if (acceptIfWithinQuota(file.size)) acceptedGeneratedFiles.push(file);
    }
    for (const asset of generatedAssets) {
      if (acceptIfWithinQuota(asset.size)) acceptedGeneratedAssets.push(asset);
    }
    for (const [sourceIndex, artifact] of (input.extractedArtifacts ?? [])
      .slice(0, MAX_ARTIFACTS_PER_MESSAGE)
      .entries()) {
      if (acceptIfWithinQuota(artifact.size)) {
        acceptedArtifacts.push({ sourceIndex, artifact });
      }
    }

    const insertedMessages = await tx
      .insert(messages)
      .values([
        {
          conversationId: input.conversationId,
          role: "user",
          content: input.userContent,
        },
        {
          conversationId: input.conversationId,
          role: "assistant",
          content: input.assistantContent,
          modelId: input.modelId,
          sources:
            input.sources.length > 0
              ? JSON.stringify(input.sources)
              : undefined,
          auditContent: input.audit?.content,
          auditModelId: input.audit?.modelId,
          factuality: input.factuality
            ? JSON.stringify(input.factuality)
            : undefined,
        },
      ])
      .returning();

    const assistantMessage = insertedMessages.find(
      (message) => message.role === "assistant",
    );
    if (!assistantMessage) {
      throw new Error("Assistant message was not returned from persistence");
    }

    let persistedAssets: PersistedGeneratedAsset[] = [];
    if (
      acceptedGeneratedFiles.length > 0 ||
      acceptedGeneratedAssets.length > 0
    ) {
      persistedAssets = await tx
        .insert(assets)
        .values(
          [...acceptedGeneratedFiles, ...acceptedGeneratedAssets].map(
            (file) => ({
              conversationId: input.conversationId,
              messageId: assistantMessage.id,
              filename: file.filename,
              mimeType: file.mimeType,
              size: file.size,
              data: file.buffer.toString("base64"),
            }),
          ),
        )
        .returning({
          id: assets.id,
          filename: assets.filename,
          mimeType: assets.mimeType,
          size: assets.size,
        });

      if (persistedAssets.length > 0) {
        await tx
          .update(messages)
          .set({
            assetIds: JSON.stringify(persistedAssets.map((asset) => asset.id)),
          })
          .where(eq(messages.id, assistantMessage.id));
      }
    }

    const persistedArtifacts: PersistedTextArtifact[] = [];
    for (const { sourceIndex, artifact } of acceptedArtifacts) {
      const [row] = await tx
        .insert(artifacts)
        .values({
          conversationId: input.conversationId,
          messageId: assistantMessage.id,
          userId: input.userId,
          filename: artifact.filename,
          mime: artifact.mime,
          size: artifact.size,
          content: artifact.content,
        })
        .returning({
          id: artifacts.id,
          filename: artifacts.filename,
          mime: artifacts.mime,
          size: artifacts.size,
        });
      if (row) persistedArtifacts.push({ sourceIndex, ...row });
    }

    if (quotaExceeded) {
      logger.warn(
        {
          component: "completion-persistence",
          errorCode: "GENERATED_FILE_QUOTA_EXCEEDED",
          quotaBytes,
          usedBytes,
          generatedFiles: generatedFiles.length,
          generatedAssets: generatedAssets.length,
          persistedAssets: persistedAssets.length,
          extractedArtifacts: input.extractedArtifacts?.length ?? 0,
          persistedArtifacts: persistedArtifacts.length,
        },
        "Generated-file quota prevented one or more files from being persisted",
      );
    }

    return {
      assets: persistedAssets,
      artifacts: persistedArtifacts,
      quotaExceeded,
    };
  });
}

/** Delete only owned messages and their generated binary assets atomically. */
export async function deleteOwnedMessagesAndAssets(
  userId: string,
  requestedIds: number[],
): Promise<number[]> {
  if (requestedIds.length === 0) return [];
  return db.transaction(async (tx) => {
    const owned = await tx
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(
        and(
          inArray(messages.id, requestedIds),
          eq(conversations.userId, userId),
        ),
      );
    const ownedIds = owned.map((row) => row.id);
    if (ownedIds.length === 0) return [];

    // Explicit deletion protects existing deployments whose legacy FK still
    // uses ON DELETE SET NULL. New schemas use CASCADE as an additional guard.
    await tx.delete(assets).where(inArray(assets.messageId, ownedIds));
    await tx.delete(messages).where(inArray(messages.id, ownedIds));
    return ownedIds;
  });
}
