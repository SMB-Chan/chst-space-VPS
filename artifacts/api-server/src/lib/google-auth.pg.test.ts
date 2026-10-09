import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

const describePostgres = process.env.DATABASE_URL ? describe : describe.skip;
const userId = `google-auth-enc:${randomUUID()}`;
const legacyUser = `google-auth-legacy:${randomUUID()}`;

describePostgres("google auth token storage (PostgreSQL)", () => {
  afterAll(async () => {
    const { pool } = await import("@workspace/db");
    await pool.query("DELETE FROM google_auth WHERE user_id = ANY($1)", [
      [userId, legacyUser],
    ]);
  });

  it("encrypts tokens at rest and decrypts them on read", async () => {
    const { saveGoogleAuth, getGoogleAuthRow } = await import("./google-auth");
    const { pool } = await import("@workspace/db");
    await saveGoogleAuth({
      userId,
      accessToken: "ya29.test-access",
      refreshToken: "1//test-refresh",
      expiresIn: 3600,
      scope: "https://www.googleapis.com/auth/drive.readonly",
    });
    const raw = await pool.query(
      "SELECT access_token, refresh_token FROM google_auth WHERE user_id = $1",
      [userId],
    );
    expect(raw.rows[0].access_token).toMatch(/^enc1:/);
    expect(raw.rows[0].refresh_token).toMatch(/^enc1:/);
    expect(raw.rows[0].access_token).not.toContain("ya29.test-access");
    const row = await getGoogleAuthRow(userId);
    expect(row?.accessToken).toBe("ya29.test-access");
    expect(row?.refreshToken).toBe("1//test-refresh");

    // Re-consent without a refresh token keeps the previous one.
    await saveGoogleAuth({ userId, accessToken: "ya29.next", expiresIn: 3600 });
    const again = await getGoogleAuthRow(userId);
    expect(again?.accessToken).toBe("ya29.next");
    expect(again?.refreshToken).toBe("1//test-refresh");
  });

  it("still reads legacy plaintext rows", async () => {
    const { getGoogleAuthRow } = await import("./google-auth");
    const { pool } = await import("@workspace/db");
    await pool.query(
      "INSERT INTO google_auth (user_id, access_token, refresh_token) VALUES ($1, $2, $3)",
      [legacyUser, "plain-access", "plain-refresh"],
    );
    const row = await getGoogleAuthRow(legacyUser);
    expect(row?.refreshToken).toBe("plain-refresh");
  });
});
