import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import {
  denyNotAllowedUser,
  getAdminUserIds,
  getAllowedUserIds,
  getUserRole,
  isUserAllowed,
  USER_NOT_ALLOWED_CODE,
} from "./allowedUsers";

function mockResponse(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

describe("getAllowedUserIds", () => {
  it("is disabled without configuration", () => {
    expect(getAllowedUserIds({})).toBeNull();
    expect(getAllowedUserIds({ ALLOWED_CLERK_USER_IDS: "" })).toBeNull();
    expect(getAllowedUserIds({ ALLOWED_CLERK_USER_IDS: "  " })).toBeNull();
    expect(getAllowedUserIds({ ALLOWED_CLERK_USER_IDS: ",,," })).toBeNull();
  });

  it("parses a comma-separated list with whitespace trimmed", () => {
    expect(
      getAllowedUserIds({
        ALLOWED_CLERK_USER_IDS: " user_a , user_b,,user_c ",
      }),
    ).toEqual(new Set(["user_a", "user_b", "user_c"]));
  });
});

describe("isUserAllowed", () => {
  it("allows every authenticated user while the gate is disabled", () => {
    vi.stubEnv("ALLOWED_CLERK_USER_IDS", "");
    expect(isUserAllowed("anyone")).toBe(true);
    vi.unstubAllEnvs();
  });

  it("restricts usage to listed user ids when the gate is enabled", () => {
    vi.stubEnv("ALLOWED_CLERK_USER_IDS", "family_1,family_2");
    expect(isUserAllowed("family_1")).toBe(true);
    expect(isUserAllowed("family_2")).toBe(true);
    expect(isUserAllowed("stranger_9")).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("denyNotAllowedUser", () => {
  it("answers a generic 403 that does not leak account existence", () => {
    const res = mockResponse();
    denyNotAllowedUser(res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "このサービスは招待されたユーザーのみ利用できます。",
      code: USER_NOT_ALLOWED_CODE,
    });
  });
});

describe("roles", () => {
  it("treats unlisted users as general users", () => {
    vi.stubEnv("ADMIN_CLERK_USER_IDS", "admin_1");
    expect(getUserRole("admin_1")).toBe("admin");
    expect(getUserRole("family_1")).toBe("user");
    expect(getUserRole("family_1")).not.toBe("admin");
    vi.unstubAllEnvs();
  });

  it("parses the admin list with whitespace and empties", () => {
    expect(
      getAdminUserIds({ ADMIN_CLERK_USER_IDS: " admin_1 , admin_2 " }),
    ).toEqual(new Set(["admin_1", "admin_2"]));
    expect(getAdminUserIds({})).toEqual(new Set());
  });

  it("lets admins bypass the family gate so operators cannot lock themselves out", () => {
    vi.stubEnv("ALLOWED_CLERK_USER_IDS", "family_1");
    vi.stubEnv("ADMIN_CLERK_USER_IDS", "admin_1");
    expect(isUserAllowed("family_1")).toBe(true);
    expect(isUserAllowed("admin_1")).toBe(true);
    expect(isUserAllowed("stranger")).toBe(false);
    vi.unstubAllEnvs();
  });
});
