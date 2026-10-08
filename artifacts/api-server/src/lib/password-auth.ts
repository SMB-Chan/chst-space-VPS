import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { db, appSessions, appUsers } from "@workspace/db";

/**
 * Local username/password accounts for AUTH_MODE=password.
 *
 * Accounts live in app_users; each login creates an app_sessions row whose
 * id is the sha256 of a random token. The raw token only exists in the
 * HttpOnly `cs_session` cookie, so a database dump cannot be replayed.
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;
/** Upper bound for parameters read back from a stored hash. */
const SCRYPT_MAX_N = 1 << 20;

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = "cs_session";
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

export type AppUserRole = "admin" | "user";

export interface AppUserRecord {
  id: string;
  username: string;
  displayName: string | null;
  role: AppUserRole;
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidUsername(raw: string): boolean {
  return USERNAME_RE.test(normalizeUsername(raw));
}

export function isValidPassword(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    raw.length >= PASSWORD_MIN &&
    raw.length <= PASSWORD_MAX
  );
}

export function toAppUserRole(raw: string): AppUserRole {
  return raw === "admin" ? "admin" : "user";
}

/** Hash as `scrypt$N$r$p$saltB64$hashB64` (parameters kept for upgrades). */
export async function hashPassword(plain: string): Promise<string> {
  if (!isValidPassword(plain)) {
    throw new Error(
      `パスワードは${PASSWORD_MIN}〜${PASSWORD_MAX}文字で指定してください。`,
    );
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptAsync(plain, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

/**
 * Constant-time verification. Any malformed input yields false; callers
 * must answer with a generic error so accounts cannot be enumerated.
 */
export async function verifyPassword(
  plain: string,
  packed: string,
): Promise<boolean> {
  if (!isValidPassword(plain) || typeof packed !== "string") return false;
  const parts = packed.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N < 2 ||
    N > SCRYPT_MAX_N ||
    r < 1 ||
    r > 32 ||
    p < 1 ||
    p > 16
  ) {
    return false;
  }
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = await scryptAsync(plain, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 256 * N * r,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * Spend the same scrypt work as a real verification when the username does
 * not exist, so response timing does not reveal which accounts exist.
 */
export async function dummyPasswordVerify(plain: string): Promise<void> {
  dummyHash ??= hashPassword("dummy-password-for-timing");
  await verifyPassword(
    isValidPassword(plain) ? plain : "invalid-password",
    await dummyHash,
  );
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface SessionHandle {
  token: string;
  expiresAt: Date;
}

/** Persist a new session and return the raw token for the cookie. */
export async function createSession(
  userId: string,
  ttlMs: number = SESSION_TTL_MS,
): Promise<SessionHandle> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs);
  await db
    .insert(appSessions)
    .values({ id: sha256Hex(token), userId, expiresAt });
  return { token, expiresAt };
}

export interface ResolvedSession {
  userId: string;
  role: AppUserRole;
  username: string;
  displayName: string | null;
  expiresAt: Date;
}

export async function resolveSession(
  token: string | null | undefined,
): Promise<ResolvedSession | null> {
  if (!token) return null;
  const [row] = await db
    .select({
      userId: appSessions.userId,
      expiresAt: appSessions.expiresAt,
      role: appUsers.role,
      username: appUsers.username,
      displayName: appUsers.displayName,
    })
    .from(appSessions)
    .innerJoin(appUsers, eq(appSessions.userId, appUsers.id))
    .where(
      and(
        eq(appSessions.id, sha256Hex(token)),
        gt(appSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    userId: row.userId,
    role: toAppUserRole(row.role),
    username: row.username,
    displayName: row.displayName ?? null,
    expiresAt: row.expiresAt,
  };
}

export async function deleteSession(token: string): Promise<void> {
  if (!token) return;
  await db.delete(appSessions).where(eq(appSessions.id, sha256Hex(token)));
}

export async function deleteSessionsForUser(userId: string): Promise<void> {
  await db.delete(appSessions).where(eq(appSessions.userId, userId));
}

export async function deleteExpiredSessions(): Promise<void> {
  await db.delete(appSessions).where(lt(appSessions.expiresAt, new Date()));
}

export async function findUserByUsername(
  username: string,
): Promise<(AppUserRecord & { passwordHash: string }) | null> {
  const normalized = normalizeUsername(username);
  if (!USERNAME_RE.test(normalized)) return null;
  const [row] = await db
    .select()
    .from(appUsers)
    .where(eq(appUsers.username, normalized))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName ?? null,
    role: toAppUserRole(row.role),
    passwordHash: row.passwordHash,
  };
}

export async function findUserById(
  userId: string,
): Promise<(AppUserRecord & { passwordHash: string }) | null> {
  const [row] = await db
    .select()
    .from(appUsers)
    .where(eq(appUsers.id, userId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName ?? null,
    role: toAppUserRole(row.role),
    passwordHash: row.passwordHash,
  };
}

export async function touchLastLogin(userId: string): Promise<void> {
  await db
    .update(appUsers)
    .set({ lastLoginAt: new Date() })
    .where(eq(appUsers.id, userId));
}

export async function countAdmins(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(appUsers)
    .where(eq(appUsers.role, "admin"));
  return row?.count ?? 0;
}

/** Source of truth for the admin role in password mode. */
export async function isAdminUserId(userId: string): Promise<boolean> {
  if (!userId) return false;
  const user = await findUserById(userId);
  return user?.role === "admin";
}

export function newAccountId(): string {
  return `u_${randomBytes(8).toString("hex")}`;
}
