import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "./message-input";
import { compressImageFile } from "@/lib/compress-image";

vi.mock("./model-selector", () => ({
  useAvailableModels: () => [],
  ModelSelector: () => null,
}));
vi.mock("./qwen-audio-realtime", () => ({ QwenAudioRealtime: () => null }));
vi.mock("@/lib/compress-image", () => ({
  compressImageFile: vi.fn(async (file: File) => ({ file, reduced: false })),
  formatBytes: (bytes: number) => `${bytes} B`,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("composer interactions", () => {
  let host: HTMLDivElement;
  let root: Root;
  const send = vi.fn();
  const textarea = () => host.querySelector("textarea")!;
  const button = () =>
    host.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')!;

  async function render(
    props: Partial<ComponentProps<typeof MessageInput>> = {},
  ) {
    await act(async () =>
      root.render(
        <MessageInput onSend={send} fileGenerationEnabled={false} {...props} />,
      ),
    );
  }
  async function type(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(textarea(), value);
      textarea().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function attach(file: File) {
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [file],
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    send.mockReset();
    vi.mocked(compressImageFile).mockImplementation(async (file) => ({
      file,
      reduced: false,
    }));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("does not send IME confirmation Enter, including WebKit keyCode 229", async () => {
    await render();
    await type("日本語の入力");
    await act(async () => {
      textarea().dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      textarea().dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      );
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          keyCode: 229,
          bubbles: true,
        }),
      );
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
        }),
      );
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    expect(send).not.toHaveBeenCalled();
    await act(async () =>
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toBe("日本語の入力");
  });

  it("locks preparation immediately, prevents duplicate sends, and retains a rejected draft", async () => {
    const pending = deferred<boolean>();
    send.mockReturnValue(pending.promise);
    await render();
    await type("消さない下書き");
    await act(async () => {
      button().click();
      button().click();
    });
    expect(send).toHaveBeenCalledOnce();
    expect(textarea().disabled).toBe(true);
    expect(button().getAttribute("aria-busy")).toBe("true");
    await act(async () => pending.resolve(false));
    expect(textarea().value).toBe("消さない下書き");
    expect(textarea().disabled).toBe(false);
    send.mockResolvedValue(true);
    await act(async () => button().click());
    expect(send).toHaveBeenCalledTimes(2);
    expect(textarea().value).toBe("");
  });

  it("keeps text and attachments after the send callback throws", async () => {
    await render();
    await type("添付について教えて");
    await attach(new File(["memo"], "memo.txt", { type: "text/plain" }));
    send.mockRejectedValue(new Error("接続できません"));
    await act(async () => {
      button().click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(textarea().value).toBe("添付について教えて");
    expect(host.textContent).toContain("memo.txt");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "接続できません",
    );
    expect(button().disabled).toBe(false);
  });

  it("identifies a failed attachment without submitting or discarding the other files", async () => {
    await render();
    await type("この資料");
    await attach(new File(["ok"], "ok.txt", { type: "text/plain" }));
    await attach(new File(["bad"], "broken.txt", { type: "text/plain" }));
    const original = FileReader.prototype.readAsText;
    vi.spyOn(FileReader.prototype, "readAsText").mockImplementation(function (
      this: FileReader,
      file: Blob,
    ) {
      if ((file as File).name === "broken.txt")
        this.dispatchEvent(new ProgressEvent("error"));
      else original.call(this, file);
    });
    await act(async () => {
      button().click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(send).not.toHaveBeenCalled();
    expect(host.textContent).toContain("読込失敗");
    expect(textarea().value).toBe("この資料");
    expect(host.textContent).toContain("ok.txt");
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="broken.txt を外す"]')!
        .click(),
    );
    await act(async () => {
      button().click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1]).toEqual([
      { name: "ok.txt", content: "ok", isBase64: false, kind: "file" },
    ]);
  });

  it("discards unfinished attachment preparation when navigating to another conversation", async () => {
    const pending = deferred<{ file: File; reduced: boolean }>();
    vi.mocked(compressImageFile).mockReturnValue(pending.promise);
    await render({ conversationId: 1 });
    await type("会話1の入力");
    const file = new File(["memo"], "private.txt", { type: "text/plain" });
    await attach(file);
    await render({ conversationId: 2 });
    await type("会話2の入力");
    await act(async () => pending.resolve({ file, reduced: false }));
    expect(textarea().value).toBe("会話2の入力");
    expect(host.textContent).not.toContain("private.txt");
    expect(send).not.toHaveBeenCalled();
  });

  it("does not send stale attachments after a conversation switch during FileReader work", async () => {
    let reader!: FileReader;
    vi.spyOn(FileReader.prototype, "readAsText").mockImplementation(function (
      this: FileReader,
    ) {
      reader = this;
    });
    await render({ conversationId: 1 });
    await attach(new File(["secret"], "secret.txt", { type: "text/plain" }));
    await act(async () => button().click());
    await render({ conversationId: 2 });
    await type("新しい入力");
    await act(async () => {
      Object.defineProperty(reader, "result", { value: "secret" });
      reader.dispatchEvent(new ProgressEvent("load"));
    });
    expect(send).not.toHaveBeenCalled();
    expect(textarea().value).toBe("新しい入力");
  });

  it("separates private and new-chat drafts without persistent storage", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem");
    await render({ draftScope: "private" });
    await type("非公開の入力");
    await render({ draftScope: "new" });
    expect(textarea().value).toBe("");
    await render({ draftScope: "private" });
    expect(textarea().value).toBe("");
    expect(storage).not.toHaveBeenCalled();
  });

  it("keeps stop available while the composer is disabled during streaming", async () => {
    const stop = vi.fn();
    await render({ disabled: true, isStreaming: true, onStop: stop });
    const control = host.querySelector<HTMLButtonElement>(
      '[data-testid="composer-stop"]',
    )!;
    expect(control.disabled).toBe(false);
    expect(host.querySelector('[data-testid="composer-send"]')).toBeNull();
    await act(async () => control.click());
    expect(stop).toHaveBeenCalledOnce();
  });
});
