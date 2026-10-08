import { describe, expect, it } from "vitest";
import { clearUserBrowserState } from "./session-cleanup";

describe("clearUserBrowserState", () => {
  it("drops the previous user's pending mobile message but keeps UI preferences", () => {
    window.sessionStorage.setItem(
      "chat-space.mobile.pending-send",
      "secret draft",
    );
    window.localStorage.setItem("chat-space.settings.v1", "{}");

    clearUserBrowserState();

    expect(
      window.sessionStorage.getItem("chat-space.mobile.pending-send"),
    ).toBeNull();
    expect(window.localStorage.getItem("chat-space.settings.v1")).toBe("{}");
  });
});
