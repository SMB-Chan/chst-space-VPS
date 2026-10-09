import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClerkProvider, SignIn } from "./password-auth-shim";

// Regression: the sign-in button was type="button" with no handler, so a tap
// (and Enter) never sent POST /api/auth/login in AUTH_MODE=password.
describe("password-mode <SignIn>", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/auth/login")) {
        return new Response(JSON.stringify({ error: "認証に失敗しました" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      void init;
      return new Response(
        JSON.stringify({ authMode: "password", user: null }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderSignIn() {
    await act(async () => {
      root.render(
        <ClerkProvider>
          <SignIn />
        </ClerkProvider>,
      );
    });
  }

  function type(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function loginCalls() {
    return fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/auth/login"),
    );
  }

  it("renders a submit button inside the form", async () => {
    await renderSignIn();
    const button = container.querySelector("form button") as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.type).toBe("submit");
  });

  it("sends POST /api/auth/login when the button is clicked and shows the error", async () => {
    await renderSignIn();
    const user = container.querySelector(
      "#password-auth-username",
    ) as HTMLInputElement;
    const pass = container.querySelector(
      "#password-auth-password",
    ) as HTMLInputElement;
    await act(async () => {
      type(user, "admin");
      type(pass, "wrong-password");
    });
    const button = container.querySelector("form button") as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const calls = loginCalls();
    expect(calls).toHaveLength(1);
    const [, init] = calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      username: "admin",
      password: "wrong-password",
    });
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "認証に失敗しました",
    );
  });
});
