import { eq } from "drizzle-orm";

// The DB handle is loaded lazily so tool modules can be imported in test
// environments without provisioning a database.
type DbModule = typeof import("@workspace/db");
type SchemaModule = typeof import("@workspace/db/schema");
let googleAuthPromise: Promise<{
  db: DbModule["db"];
  googleAuth: SchemaModule["googleAuth"];
}> | null = null;

async function loadDb() {
  googleAuthPromise ??= Promise.all([
    import("@workspace/db"),
    import("@workspace/db/schema"),
  ]).then(([dbModule, schemaModule]) => ({
    db: dbModule.db,
    googleAuth: schemaModule.googleAuth,
  }));
  return googleAuthPromise;
}

export const GOOGLE_AUTH_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
] as const;

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
  );
}

export function getGoogleRedirectUri(originHint?: string): string {
  if (process.env.GOOGLE_REDIRECT_URI) {
    return process.env.GOOGLE_REDIRECT_URI;
  }
  const base =
    process.env.FRONTEND_URL ||
    (originHint ? new URL(originHint).origin : undefined);
  if (!base) {
    throw new Error(
      "GOOGLE_REDIRECT_URI または FRONTEND_URL を設定してください",
    );
  }
  return `${base.replace(/\/$/, "")}/api/google/callback`;
}

export interface GoogleTokenRow {
  userId: string;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  scope: string | null;
  accountEmail: string | null;
  updatedAt?: Date | null;
}

export async function getGoogleAuthRow(
  userId: string,
): Promise<GoogleTokenRow | null> {
  const { db, googleAuth } = await loadDb();
  const rows = await db
    .select()
    .from(googleAuth)
    .where(eq(googleAuth.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function isGoogleConnected(userId: string): Promise<boolean> {
  const row = await getGoogleAuthRow(userId);
  return Boolean(row?.refreshToken);
}

export async function saveGoogleAuth(row: {
  userId: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresIn: number;
  scope?: string | null;
  accountEmail?: string | null;
}): Promise<void> {
  const { db, googleAuth } = await loadDb();
  const expiresAt = new Date(Date.now() + row.expiresIn * 1000);
  const existing = await getGoogleAuthRow(row.userId);
  // Google omits refresh_token on re-consent; keep the previous one.
  const refreshToken = row.refreshToken || existing?.refreshToken || null;
  await db
    .insert(googleAuth)
    .values({
      userId: row.userId,
      accessToken: row.accessToken,
      refreshToken,
      tokenExpiresAt: expiresAt,
      scope: row.scope ?? existing?.scope ?? null,
      accountEmail: row.accountEmail ?? existing?.accountEmail ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: googleAuth.userId,
      set: {
        accessToken: row.accessToken,
        refreshToken,
        tokenExpiresAt: expiresAt,
        scope: row.scope ?? existing?.scope ?? null,
        accountEmail: row.accountEmail ?? existing?.accountEmail ?? null,
        updatedAt: new Date(),
      },
    });
}

export async function deleteGoogleAuth(userId: string): Promise<void> {
  const { db, googleAuth } = await loadDb();
  await db.delete(googleAuth).where(eq(googleAuth.userId, userId));
}

/**
 * Returns a valid access token, refreshing it via the refresh token when
 * missing or expired. Throws a user-facing Japanese error when Google is not
 * connected / configured.
 */
export async function getValidAccessToken(userId: string): Promise<string> {
  if (!isGoogleOAuthConfigured()) {
    throw new Error(
      "Google連携がサーバー側で設定されていません（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET）",
    );
  }
  const row = await getGoogleAuthRow(userId);
  if (!row?.refreshToken) {
    throw new Error(
      "Googleアカウントが未連携です。設定ページからGoogle連携を有効化してください。",
    );
  }
  const expiresAt = row.tokenExpiresAt?.getTime() ?? 0;
  if (row.accessToken && Date.now() < expiresAt - 60_000) {
    return row.accessToken;
  }
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: row.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 400 && detail.includes("invalid_grant")) {
      await deleteGoogleAuth(userId);
      throw new Error(
        "Googleの認可が失効しています。設定ページから再連携してください。",
      );
    }
    throw new Error(`Googleトークンの更新に失敗しました (${res.status})`);
  }
  const json = (await res.json()) as {
    access_token: string;
    expires_in: number;
    scope?: string;
  };
  await saveGoogleAuth({
    userId,
    accessToken: json.access_token,
    expiresIn: json.expires_in,
    scope: json.scope ?? row.scope,
    accountEmail: row.accountEmail,
  });
  return json.access_token;
}

export function buildGoogleAuthUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_AUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    include_granted_scopes: "true",
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

export interface GoogleTokenExchangeResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope?: string;
}

export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
): Promise<GoogleTokenExchangeResult> {
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Google認可コードの交換に失敗しました: ${detail.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
    scope: json.scope,
  };
}

export async function fetchGoogleAccountEmail(
  accessToken: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { email?: string };
    return json.email ?? null;
  } catch {
    return null;
  }
}
