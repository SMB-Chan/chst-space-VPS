import { eq } from "drizzle-orm";
import { db, appUsers } from "@workspace/db";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  countAdmins,
  deleteSessionsForUser,
  findUserById,
  hashPassword,
  isValidPassword,
  isValidUsername,
  newAccountId,
  normalizeUsername,
} from "./password-auth";
import { logger } from "./logger";

/**
 * First-admin bootstrap for AUTH_MODE=password.
 *
 * The first admin defaults to the legacy single-operator id
 * (LOCAL_USER_ID, "local-user"), so every conversation, memory and setting
 * created under AUTH_MODE=local stays with that person after the switch.
 */

export function defaultFirstAdminUserId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.BOOTSTRAP_ADMIN_USER_ID?.trim() ||
    env.LOCAL_USER_ID?.trim() ||
    "local-user"
  );
}

export interface AdminAccountResult {
  created: boolean;
  userId: string;
  username: string;
}

/**
 * Create the admin from BOOTSTRAP_ADMIN_USERNAME / BOOTSTRAP_ADMIN_PASSWORD
 * when no admin exists yet. Never touches an existing admin.
 */
export async function ensureBootstrapAdmin(
  env: NodeJS.ProcessEnv = process.env,
): Promise<"created" | "exists" | "missing-config" | "invalid-config"> {
  if ((await countAdmins()) > 0) return "exists";
  const username = env.BOOTSTRAP_ADMIN_USERNAME?.trim();
  const password = env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!username || !password) return "missing-config";
  if (!isValidUsername(username) || !isValidPassword(password)) {
    return "invalid-config";
  }
  const userId = defaultFirstAdminUserId(env);
  const now = new Date();
  const inserted = await db
    .insert(appUsers)
    .values({
      id: userId,
      username: normalizeUsername(username),
      displayName: null,
      passwordHash: await hashPassword(password),
      role: "admin",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: appUsers.id });
  if (inserted.length === 0) {
    logger.warn(
      { component: "bootstrap-admin" },
      "Bootstrap admin not created: the user id or username is already taken",
    );
    return "invalid-config";
  }
  return "created";
}

/**
 * CLI helper: create `username` as admin, or promote an existing account
 * to admin and reset its password (signing out its sessions).
 */
export async function createOrPromoteAdmin(args: {
  username: string;
  password: string;
  userId?: string;
  displayName?: string;
}): Promise<AdminAccountResult> {
  const username = normalizeUsername(args.username);
  if (!isValidUsername(username)) {
    throw new Error(
      "ユーザー名は英小文字・数字で始まる3〜32文字（a-z 0-9 . _ -）で指定してください。",
    );
  }
  if (!isValidPassword(args.password)) {
    throw new Error(
      `パスワードは${PASSWORD_MIN}〜${PASSWORD_MAX}文字で指定してください。`,
    );
  }
  const passwordHash = await hashPassword(args.password);
  const now = new Date();
  const [existing] = await db
    .select()
    .from(appUsers)
    .where(eq(appUsers.username, username))
    .limit(1);
  if (existing) {
    await db
      .update(appUsers)
      .set({
        passwordHash,
        role: "admin",
        displayName: args.displayName?.trim() || existing.displayName,
        updatedAt: now,
      })
      .where(eq(appUsers.id, existing.id));
    await deleteSessionsForUser(existing.id);
    return { created: false, userId: existing.id, username };
  }
  // The very first admin inherits the legacy single-operator data.
  let userId = args.userId?.trim();
  if (!userId) {
    const legacyId = defaultFirstAdminUserId();
    userId =
      (await countAdmins()) === 0 && !(await findUserById(legacyId))
        ? legacyId
        : newAccountId();
  }
  await db.insert(appUsers).values({
    id: userId,
    username,
    displayName: args.displayName?.trim() || null,
    passwordHash,
    role: "admin",
    createdAt: now,
    updatedAt: now,
  });
  return { created: true, userId, username };
}
