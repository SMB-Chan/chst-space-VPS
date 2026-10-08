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
  return provider ? provider.enabled : true;
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
