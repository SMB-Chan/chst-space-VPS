import OpenAI from "openai";
import { db, llmModels, llmProviders } from "@workspace/db";
import {
  AVAILABLE_MODELS,
  type ChatModel,
  type ModelProvider,
  type ReasoningKind,
} from "./ai-clients";
import { createLlmTimeContextFetch } from "./llm-time-context";
import { decryptSecret, PROVIDER_LABELS } from "./provider-credentials";
import { logger } from "./logger";
import {
  getCatalogSnapshot,
  setCatalogSnapshot,
  type CatalogModel,
  type CatalogProvider,
} from "./model-registry";

export type { CatalogModel, CatalogProvider } from "./model-registry";

/**
 * Admin-managed model catalog backed by llm_providers / llm_models.
 *
 * The in-code AVAILABLE_MODELS list stays the seed: every boot inserts the
 * built-in providers and models with ON CONFLICT DO NOTHING, so admin edits
 * (disable, hide from general users, delete = tombstone) survive restarts
 * while models added to the code later still appear automatically.
 */

export type BuiltinProviderId = Exclude<ModelProvider, "custom">;
export const BUILTIN_PROVIDER_IDS: readonly BuiltinProviderId[] = [
  "openai",
  "dashscope",
  "openrouter",
  "xiaomi",
];

export function isBuiltinProviderId(id: string): id is BuiltinProviderId {
  return (BUILTIN_PROVIDER_IDS as readonly string[]).includes(id);
}

/** Default general-user visibility of a seeded model (today's policy). */
function seedUserVisible(provider: ModelProvider): boolean {
  return provider === "openrouter";
}

const customProviderFetch = createLlmTimeContextFetch();

function buildCustomClient(baseURL: string, apiKey: string): OpenAI {
  return new OpenAI({ apiKey, baseURL, fetch: customProviderFetch });
}

async function loadSnapshot(): Promise<void> {
  const [providerRows, modelRows] = await Promise.all([
    db.select().from(llmProviders),
    db.select().from(llmModels),
  ]);
  const providers = new Map<string, CatalogProvider>();
  const customClients = new Map<string, OpenAI>();
  for (const row of providerRows) {
    const kind = row.kind === "custom" ? "custom" : "builtin";
    let apiKey: string | null = null;
    if (row.apiKeyEncrypted) {
      try {
        apiKey = decryptSecret(row.apiKeyEncrypted);
      } catch (err) {
        logger.warn(
          { component: "model-catalog", providerId: row.id, err },
          "Provider key could not be decrypted; provider unavailable",
        );
        apiKey = null;
      }
    }
    providers.set(row.id, {
      id: row.id,
      label: row.label,
      kind,
      baseUrl: row.baseUrl ?? null,
      enabled: row.enabled,
      hasKey: Boolean(row.apiKeyEncrypted),
      keyHint: row.keyHint ?? null,
      useEnvKey: row.useEnvKey ?? true,
      deleted: row.deleted ?? false,
      apiKey,
      updatedAt: row.updatedAt,
    });
    if (kind !== "custom" || !row.enabled) continue;
    if (!row.apiKeyEncrypted || !row.baseUrl || !apiKey) continue;
    customClients.set(row.id, buildCustomClient(row.baseUrl, apiKey));
  }
  const models = new Map<string, CatalogModel>();
  for (const row of modelRows) {
    models.set(row.id, {
      id: row.id,
      providerId: row.providerId,
      label: row.label,
      description: row.description,
      supportsVision: row.supportsVision,
      supportsReasoning: row.supportsReasoning,
      enabled: row.enabled,
      userVisible: row.userVisible,
      builtin: row.builtin,
      deleted: row.deleted,
      sortOrder: row.sortOrder,
    });
  }
  setCatalogSnapshot({ providers, models, customClients });
}

/**
 * Reload the registry from the database. Called at boot and after every
 * admin mutation. On failure the previous snapshot stays in place so a
 * transient DB error never breaks the chat path.
 */
export async function refreshModelCatalog(): Promise<void> {
  try {
    await loadSnapshot();
  } catch (err) {
    logger.warn(
      { component: "model-catalog", err },
      "Failed to refresh model catalog; keeping the previous snapshot",
    );
  }
}

/** Boot-time seed of the built-in providers and models (idempotent). */
export async function seedModelCatalog(): Promise<void> {
  const now = new Date();
  await db
    .insert(llmProviders)
    .values(
      BUILTIN_PROVIDER_IDS.map((id) => ({
        id,
        label: PROVIDER_LABELS[id],
        kind: "builtin",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing();
  await db
    .insert(llmModels)
    .values(
      AVAILABLE_MODELS.map((model, index) => ({
        id: model.id,
        providerId: model.provider,
        label: model.label,
        description: model.description,
        supportsVision: model.supportsVision,
        supportsReasoning: model.supportsReasoning,
        enabled: true,
        userVisible: seedUserVisible(model.provider),
        builtin: true,
        deleted: false,
        sortOrder: index,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing();
  await refreshModelCatalog();
}

function staticProviders(): CatalogProvider[] {
  return BUILTIN_PROVIDER_IDS.map((id) => ({
    id,
    label: PROVIDER_LABELS[id],
    kind: "builtin" as const,
    baseUrl: null,
    enabled: true,
    hasKey: false,
    keyHint: null,
    useEnvKey: true,
    deleted: false,
    apiKey: null,
    updatedAt: new Date(0),
  }));
}

function staticModels(): CatalogModel[] {
  return AVAILABLE_MODELS.map((model, index) => ({
    id: model.id,
    providerId: model.provider,
    label: model.label,
    description: model.description,
    supportsVision: model.supportsVision,
    supportsReasoning: model.supportsReasoning,
    enabled: true,
    userVisible: seedUserVisible(model.provider),
    builtin: true,
    deleted: false,
    sortOrder: index,
  }));
}

/**
 * Providers visible in normal lists, built-ins first then custom ones by id.
 * Soft-deleted (hidden) built-ins are excluded; admins see them through
 * `getCatalogDeletedProviders` for the restore section.
 */
export function getCatalogProviders(): CatalogProvider[] {
  const snap = getCatalogSnapshot();
  if (!snap) return staticProviders();
  const list = [...snap.providers.values()].filter(
    (p) => !(p.kind === "builtin" && p.deleted),
  );
  const rank = (p: CatalogProvider) =>
    isBuiltinProviderId(p.id) ? BUILTIN_PROVIDER_IDS.indexOf(p.id) : 100;
  return list.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

/**
 * Soft-deleted built-in providers, in id order. The admin UI shows these
 * in a separate "deleted" section with a restore button.
 */
export function getCatalogDeletedProviders(): CatalogProvider[] {
  const snap = getCatalogSnapshot();
  if (!snap) return [];
  return [...snap.providers.values()]
    .filter((p) => p.kind === "builtin" && p.deleted)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Non-deleted catalog models in display order. */
export function getCatalogModels(): CatalogModel[] {
  const snap = getCatalogSnapshot();
  if (!snap) return staticModels();
  return [...snap.models.values()]
    .filter((model) => !model.deleted)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

/** Every id the catalog reserves, including tombstoned built-ins. */
export function getReservedModelIds(): Set<string> {
  const ids = new Set<string>(AVAILABLE_MODELS.map((model) => model.id));
  const snap = getCatalogSnapshot();
  if (snap) for (const id of snap.models.keys()) ids.add(id);
  return ids;
}

/**
 * Curated chat models for the built-in providers: the static catalog until
 * the registry is loaded, afterwards the enabled, non-deleted rows of
 * enabled built-in providers (including admin-added model ids).
 */
export function getCuratedBuiltinChatModels(): ChatModel[] {
  const snap = getCatalogSnapshot();
  if (!snap) return [...AVAILABLE_MODELS];
  const result: ChatModel[] = [];
  for (const model of getCatalogModels()) {
    if (!model.enabled || !isBuiltinProviderId(model.providerId)) continue;
    const provider = snap.providers.get(model.providerId);
    if (provider && (!provider.enabled || provider.deleted)) continue;
    const seed = AVAILABLE_MODELS.find(
      (candidate) =>
        candidate.id === model.id && candidate.provider === model.providerId,
    );
    const reasoning: ReasoningKind = seed
      ? seed.reasoning
      : model.supportsReasoning
        ? model.providerId
        : "none";
    result.push({
      id: model.id,
      label: model.label,
      provider: model.providerId,
      description: model.description,
      supportsVision: model.supportsVision,
      supportsReasoning: model.supportsReasoning,
      reasoning,
    });
  }
  return result;
}

/** Chat models served by enabled custom providers that have a client. */
export function getCustomChatModels(): ChatModel[] {
  const snap = getCatalogSnapshot();
  if (!snap) return [];
  const result: ChatModel[] = [];
  for (const model of getCatalogModels()) {
    if (!model.enabled) continue;
    const provider = snap.providers.get(model.providerId);
    if (provider?.kind !== "custom" || !provider.enabled) continue;
    if (!snap.customClients.has(provider.id)) continue;
    result.push({
      id: model.id,
      label: model.label,
      provider: "custom",
      description: model.description,
      supportsVision: model.supportsVision,
      supportsReasoning: false,
      reasoning: "none",
      providerId: provider.id,
    });
  }
  return result;
}

/** Test helper: forget the loaded snapshot (back to the static catalog). */
export function resetModelCatalogForTests(): void {
  setCatalogSnapshot(null);
}

export { isBuiltinProviderActive } from "./model-registry";

/**
 * Japanese explanation for a chat model that is unavailable because of an
 * admin action on its provider (disabled, deleted, or key removed), or null
 * when the provider is fine (unknown id, disabled model, ...).
 */
export function describeProviderUnavailability(modelId: string): string | null {
  const snap = getCatalogSnapshot();
  if (!snap) return null;
  const providerId =
    snap.models.get(modelId)?.providerId ??
    AVAILABLE_MODELS.find((model) => model.id === modelId)?.provider;
  const provider = providerId ? snap.providers.get(providerId) : undefined;
  if (!provider) return null;
  if (!provider.enabled || provider.deleted) {
    return `${provider.label} は管理者により無効化されています。別のモデルを選択してください。`;
  }
  if (provider.kind === "custom") {
    return snap.customClients.has(provider.id)
      ? null
      : `${provider.label} のAPIキーが設定されていないため利用できません。別のモデルを選択してください。`;
  }
  if (!provider.useEnvKey && !provider.apiKey) {
    return `${provider.label} のAPIキーは管理者により解除されています。別のモデルを選択してください。`;
  }
  return null;
}
