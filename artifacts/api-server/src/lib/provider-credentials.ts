import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, providerCredentials } from "@workspace/db";
import type { ModelProvider } from "./ai-clients";

export type ProviderId = ModelProvider;

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: "OpenAI / Command Code",
  dashscope: "DashScope (Qwen)",
  openrouter: "OpenRouter",
  xiaomi: "Xiaomi MiMo",
};

export const DEFAULT_PROVIDER_BASE_URLS: Record<ProviderId, string | null> = {
  openai: null,
  dashscope: null,
  openrouter: "https://openrouter.ai/api/v1",
  xiaomi: "https://token-plan-sgp.xiaomimimo.com/v1",
};

const PROVIDER_IDS = Object.keys(PROVIDER_LABELS) as ProviderId[];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as string[]).includes(value);
}

function secretKey(): Buffer {
  const raw =
    process.env.PROVIDER_CREDENTIALS_SECRET?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    "chat-space-provider-credentials-dev";
  return createHash("sha256").update(raw).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext]
    .map((part) => part.toString("base64url"))
    .join(".");
}

export function decryptSecret(packed: string): string {
  const [ivB64, tagB64, dataB64] = packed.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("保存された認証情報の形式が不正です。");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    secretKey(),
    Buffer.from(ivB64, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function keyHint(plain: string): string {
  const trimmed = plain.trim();
  if (trimmed.length <= 8) return "••••";
  return `…${trimmed.slice(-4)}`;
}

export interface ProviderCredentialSummary {
  provider: ProviderId;
  label: string;
  configured: boolean;
  source: "user" | "env" | "none";
  keyHint: string | null;
  baseUrl: string | null;
  updatedAt: string | null;
}

function envKeyPresent(provider: ProviderId): boolean {
  switch (provider) {
    case "openai":
      return Boolean(process.env.AI_INTEGRATIONS_OPENAI_API_KEY?.trim());
    case "dashscope":
      return Boolean(process.env.DASHSCOPE_API_KEY?.trim());
    case "openrouter":
      return Boolean(
        process.env.OPEN_ROUTER?.trim() ||
          process.env.OPENROUTER_API_KEY?.trim(),
      );
    case "xiaomi":
      return Boolean(
        process.env.Xiaomi_Mimo_KEY?.trim() ||
          process.env.XIAOMI_API_KEY?.trim(),
      );
  }
}

/** In-memory override cache so chat requests can resolve without a DB hit per call. */
const runtimeOverrides = new Map<string, { apiKey: string; baseUrl?: string | null }>();

function overrideKey(userId: string, provider: ProviderId): string {
  return `${userId}::${provider}`;
}

export function getRuntimeProviderOverride(
  userId: string | undefined,
  provider: ProviderId,
): { apiKey: string; baseUrl?: string | null } | null {
  if (!userId) return null;
  return runtimeOverrides.get(overrideKey(userId, provider)) ?? null;
}

export async function warmProviderOverrides(userId: string): Promise<void> {
  const rows = await db
    .select()
    .from(providerCredentials)
    .where(eq(providerCredentials.userId, userId));
  for (const provider of PROVIDER_IDS) {
    const row = rows.find((r) => r.provider === provider);
    const key = overrideKey(userId, provider);
    if (!row) {
      runtimeOverrides.delete(key);
      continue;
    }
    try {
      runtimeOverrides.set(key, {
        apiKey: decryptSecret(row.apiKeyEncrypted),
        baseUrl: row.baseUrl,
      });
    } catch {
      runtimeOverrides.delete(key);
    }
  }
}

export async function listProviderCredentials(
  userId: string,
): Promise<ProviderCredentialSummary[]> {
  const rows = await db
    .select()
    .from(providerCredentials)
    .where(eq(providerCredentials.userId, userId));

  return PROVIDER_IDS.map((provider) => {
    const row = rows.find((r) => r.provider === provider);
    const envOk = envKeyPresent(provider);
    const source: ProviderCredentialSummary["source"] = row
      ? "user"
      : envOk
        ? "env"
        : "none";
    return {
      provider,
      label: PROVIDER_LABELS[provider],
      configured: Boolean(row) || envOk,
      source,
      keyHint: row?.keyHint ?? (envOk ? "（サーバー既定）" : null),
      baseUrl: row?.baseUrl ?? DEFAULT_PROVIDER_BASE_URLS[provider],
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    };
  });
}

export async function upsertProviderCredential(
  userId: string,
  provider: ProviderId,
  apiKey: string,
  baseUrl?: string | null,
): Promise<ProviderCredentialSummary> {
  const plain = apiKey.trim();
  if (!plain) {
    throw new Error("APIキーが空です。");
  }
  const encrypted = encryptSecret(plain);
  const hint = keyHint(plain);
  const normalizedBase =
    baseUrl == null || baseUrl.trim() === ""
      ? DEFAULT_PROVIDER_BASE_URLS[provider]
      : baseUrl.trim();

  await db
    .insert(providerCredentials)
    .values({
      userId,
      provider,
      apiKeyEncrypted: encrypted,
      baseUrl: normalizedBase,
      keyHint: hint,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [providerCredentials.userId, providerCredentials.provider],
      set: {
        apiKeyEncrypted: encrypted,
        baseUrl: normalizedBase,
        keyHint: hint,
        updatedAt: new Date(),
      },
    });

  runtimeOverrides.set(overrideKey(userId, provider), {
    apiKey: plain,
    baseUrl: normalizedBase,
  });

  const list = await listProviderCredentials(userId);
  return list.find((item) => item.provider === provider)!;
}

export async function deleteProviderCredential(
  userId: string,
  provider: ProviderId,
): Promise<void> {
  await db
    .delete(providerCredentials)
    .where(
      and(
        eq(providerCredentials.userId, userId),
        eq(providerCredentials.provider, provider),
      ),
    );
  runtimeOverrides.delete(overrideKey(userId, provider));
}

/** Resolve a user override key for a provider, falling back to env clients. */
export function resolveUserProviderApiKey(
  userId: string | undefined,
  provider: ProviderId,
): { apiKey: string; baseUrl?: string | null } | null {
  return getRuntimeProviderOverride(userId, provider);
}
