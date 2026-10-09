import type OpenAI from "openai";

/**
 * In-memory snapshot of the admin-managed model catalog (llm_providers /
 * llm_models). This module deliberately has no runtime imports so that
 * ai-clients.ts can read it synchronously on the chat hot path without an
 * import cycle; model-catalog.ts owns loading it from the database.
 *
 * `null` snapshot = catalog not loaded yet (boot in progress, unit tests
 * without a database). Every accessor then answers "no override", which
 * keeps the static in-code catalog behavior unchanged.
 */

export interface CatalogProvider {
  id: string;
  label: string;
  kind: "builtin" | "custom";
  baseUrl: string | null;
  enabled: boolean;
  hasKey: boolean;
  keyHint: string | null;
  /** Built-in providers only: whether the env key is currently used. */
  useEnvKey: boolean;
  /** Built-in providers only: soft delete (hidden from lists but recoverable). */
  deleted: boolean;
  /** Built-in providers only: decrypted admin DB key, if any. */
  apiKey: string | null;
  updatedAt: Date;
}

export interface CatalogModel {
  id: string;
  providerId: string;
  label: string;
  description: string;
  supportsVision: boolean;
  supportsReasoning: boolean;
  enabled: boolean;
  userVisible: boolean;
  builtin: boolean;
  /** Tombstone for a removed built-in model (kept so re-seeding skips it). */
  deleted: boolean;
  sortOrder: number;
}

export interface CatalogSnapshot {
  providers: ReadonlyMap<string, CatalogProvider>;
  models: ReadonlyMap<string, CatalogModel>;
  /** Ready-to-use clients for enabled custom providers that have a key. */
  customClients: ReadonlyMap<string, OpenAI>;
}

let snapshot: CatalogSnapshot | null = null;

export function setCatalogSnapshot(next: CatalogSnapshot | null): void {
  snapshot = next;
}

export function getCatalogSnapshot(): CatalogSnapshot | null {
  return snapshot;
}

export function findCatalogModel(id: string): CatalogModel | null {
  return snapshot?.models.get(id) ?? null;
}

export function findCatalogProvider(id: string): CatalogProvider | null {
  return snapshot?.providers.get(id) ?? null;
}

/** A provider is usable unless the loaded catalog explicitly disables it. */
export function isCatalogProviderEnabled(providerId: string): boolean {
  const provider = snapshot?.providers.get(providerId);
  if (!provider) return true;
  return provider.enabled && !provider.deleted;
}

/**
 * Whether a model may be served. Models the catalog does not know (static
 * catalog before load, dynamically discovered ids) are allowed; known rows
 * must be enabled, not tombstoned, and under an enabled provider.
 */
export function isCatalogModelUsable(modelId: string): boolean {
  const model = snapshot?.models.get(modelId);
  if (!model) return true;
  return (
    model.enabled &&
    !model.deleted &&
    isCatalogProviderEnabled(model.providerId)
  );
}

export function getCustomProviderClient(providerId: string): OpenAI | null {
  return snapshot?.customClients.get(providerId) ?? null;
}

/**
 * Whether a built-in provider is active: enabled and not soft-deleted.
 * Unknown rows and the not-yet-loaded catalog count as active so a fresh
 * install keeps its env-configured behavior.
 */
export function isBuiltinProviderActive(providerId: string): boolean {
  const provider = snapshot?.providers.get(providerId);
  if (!provider || provider.kind !== "builtin") return true;
  return provider.enabled && !provider.deleted;
}

/**
 * Whether the server env key may serve a built-in provider. An admin
 * "disconnect" (キーを解除) sets use_env_key=false; the env key is then
 * ignored everywhere until restored.
 */
export function isBuiltinEnvKeyAllowed(providerId: string): boolean {
  const provider = snapshot?.providers.get(providerId);
  if (!provider || provider.kind !== "builtin") return true;
  return provider.useEnvKey;
}

/**
 * Env-backed direct uses (audio transcription, TTS, speech capability
 * checks) may run only when the provider is active and its env key is
 * still allowed. Admin DB keys apply to chat completions only.
 */
export function isBuiltinEnvUsable(providerId: string): boolean {
  return (
    isBuiltinProviderActive(providerId) && isBuiltinEnvKeyAllowed(providerId)
  );
}

/** Decrypted admin DB key for a built-in provider, if one is stored. */
export function getBuiltinProviderDbKey(providerId: string): string | null {
  const provider = snapshot?.providers.get(providerId);
  if (!provider || provider.kind !== "builtin") return null;
  return provider.apiKey;
}
