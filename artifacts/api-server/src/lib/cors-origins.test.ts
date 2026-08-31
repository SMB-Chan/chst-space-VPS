import { describe, expect, it } from "vitest";
import { isAllowedCorsOrigin, parseAllowedOrigins } from "./cors-origins";

describe("CORS origin helpers", () => {
  it("normalizes a comma-separated allowlist", () => {
    expect([
      ...parseAllowedOrigins(
        "https://app.example.com/path, http://localhost:5173/, bad",
      ),
    ]).toEqual(["https://app.example.com", "http://localhost:5173"]);
  });

  it("fails closed for unlisted production origins", () => {
    const allowed = parseAllowedOrigins("https://app.example.com");
    expect(isAllowedCorsOrigin("https://app.example.com", allowed, false)).toBe(
      true,
    );
    expect(isAllowedCorsOrigin("https://evil.example", allowed, false)).toBe(
      false,
    );
  });

  it("allows an explicit development wildcard and requests without Origin", () => {
    const allowed = parseAllowedOrigins(undefined);
    expect(isAllowedCorsOrigin("http://localhost:3000", allowed, true)).toBe(
      true,
    );
    expect(isAllowedCorsOrigin(undefined, allowed, false)).toBe(true);
  });
});
