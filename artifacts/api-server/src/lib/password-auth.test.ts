import { describe, expect, it } from "vitest";
import {
  USERNAME_RE,
  dummyPasswordVerify,
  hashPassword,
  isValidPassword,
  isValidUsername,
  normalizeUsername,
  verifyPassword,
} from "./password-auth";

describe("password hashing", () => {
  it("hashes and verifies a valid password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct-horse-battery-staple", hash)).toBe(
      true,
    );
  });

  it("rejects the wrong password without throwing", async () => {
    const hash = await hashPassword("password-1234");
    expect(await verifyPassword("not-the-password", hash)).toBe(false);
  });

  it("returns false for a malformed hash", async () => {
    expect(await verifyPassword("anything", "not-a-scrypt-string")).toBe(false);
  });

  it("produces unique hashes for the same input (random salt)", async () => {
    const a = await hashPassword("password-1234");
    const b = await hashPassword("password-1234");
    expect(a).not.toBe(b);
    expect(await verifyPassword("password-1234", a)).toBe(true);
    expect(await verifyPassword("password-1234", b)).toBe(true);
  });

  it("rejects passwords outside the length bounds", async () => {
    await expect(hashPassword("short")).rejects.toThrow();
    expect(isValidPassword("x".repeat(201))).toBe(false);
    expect(isValidPassword("x".repeat(8))).toBe(true);
    expect(isValidPassword("x".repeat(200))).toBe(true);
  });
});

describe("username validation", () => {
  it("normalises case and trims whitespace", () => {
    expect(normalizeUsername("  Admin  ")).toBe("admin");
  });

  it("accepts valid usernames", () => {
    expect(isValidUsername("admin")).toBe(true);
    expect(isValidUsername("a1.b")).toBe(true);
    expect(isValidUsername("user_42")).toBe(true);
  });

  it("rejects usernames that violate the pattern", () => {
    expect(isValidUsername("a")).toBe(false);
    expect(isValidUsername("ab")).toBe(false);
    expect(isValidUsername("UPPER")).toBe(true); // lower-cased before validation
    expect(isValidUsername("-bad")).toBe(false);
    expect(isValidUsername("has space")).toBe(false);
    expect(isValidUsername("日本語")).toBe(false);
  });

  it("exposes a stable regex source for error messages", () => {
    expect(USERNAME_RE.source).toContain("[a-z0-9]");
  });
});

describe("dummyPasswordVerify", () => {
  it("is safe to call repeatedly", async () => {
    await dummyPasswordVerify("attacker-supplied-password");
    await dummyPasswordVerify("short");
  });
});
