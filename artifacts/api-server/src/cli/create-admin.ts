import { createInterface } from "node:readline/promises";
import { pool } from "@workspace/db";
import { createOrPromoteAdmin } from "../lib/bootstrap-admin";
import { ensureChatSchema } from "../lib/ensure-schema";

/**
 * Create (or promote + reset) an admin account for AUTH_MODE=password.
 *
 *   node artifacts/api-server/dist/create-admin.mjs --username <name>
 *     [--user-id <id>] [--display-name <name>]
 *
 * The password is read from CHAT_SPACE_ADMIN_PASSWORD, or prompted on an
 * interactive terminal. It is never accepted as a command-line argument so
 * it does not end up in shell history or the process list.
 */

interface CliArgs {
  username?: string;
  userId?: string;
  displayName?: string;
  help: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      return next;
    };
    if (flag === "--username") args.username = value();
    else if (flag === "--user-id") args.userId = value();
    else if (flag === "--display-name") args.displayName = value();
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

const USAGE = `Usage: create-admin --username <name> [--user-id <id>] [--display-name <name>]

Creates an admin account (or promotes an existing account and resets its
password). Password: $CHAT_SPACE_ADMIN_PASSWORD, or an interactive prompt.
Without --user-id the first admin reuses LOCAL_USER_ID ("local-user") so the
existing single-user data stays with that account.`;

async function readPassword(): Promise<string> {
  const fromEnv = process.env.CHAT_SPACE_ADMIN_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    throw new Error(
      "Set CHAT_SPACE_ADMIN_PASSWORD when running without a terminal.",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question("Password (8-200 chars, input is visible): ");
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.username) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const password = await readPassword();
  await ensureChatSchema((sql) => pool.query(sql));
  const result = await createOrPromoteAdmin({
    username: args.username,
    password,
    userId: args.userId,
    displayName: args.displayName,
  });
  console.log(
    `${result.created ? "Created" : "Promoted/reset"} admin "${result.username}" (id: ${result.userId})`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
