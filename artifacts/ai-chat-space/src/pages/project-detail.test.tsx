// Regression test: the page renders a loading state first and the project
// afterwards; every hook must run on both renders (React error #310 shipped
// once when upload hooks were declared below the early returns).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/api-client-react", () => ({
  useListOpenaiConversations: () => ({ data: [] }),
  getListOpenaiConversationsQueryKey: () => ["conversations"],
}));

vi.mock("@/lib/projects-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/projects-api")>();
  const project = {
    id: 1,
    name: "テスト",
    description: "",
    instructions: "",
    createdAt: "2026-10-09T00:00:00Z",
    updatedAt: "2026-10-09T00:00:00Z",
  };
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      get: vi.fn(async () => project),
      limits: vi.fn(async () => ({
        fileMaxBytes: 20 * 1024 * 1024,
        maxFiles: 50,
        userMaxTotalBytes: 500 * 1024 * 1024,
        instructionsMaxChars: 4000,
        filesContextMaxChars: 8000,
        usage: { totalBytes: 0 },
      })),
      listFiles: vi.fn(async () => []),
      listConversations: vi.fn(async () => []),
      driveStatus: vi.fn(async () => ({
        configured: false,
        connected: false,
        hasDriveScope: false,
      })),
      listDriveFiles: vi.fn(async () => []),
    },
  };
});

import { ProjectDetailPage } from "./project-detail";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
afterEach(() => {
  container?.remove();
  container = null;
});

describe("ProjectDetailPage", () => {
  it("renders the loaded project with the upload dropzone (no hook-order crash)", async () => {
    const errors: unknown[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => errors.push(args));
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const { hook } = memoryLocation({ path: "/projects/1" });
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <Router hook={hook}>
            <Route path="/projects/:id">
              <ProjectDetailPage />
            </Route>
          </Router>
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 20; i += 1) {
      if (container.querySelector('[data-testid="project-dropzone"]')) break;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    spy.mockRestore();
    expect(
      container.querySelector('[data-testid="project-dropzone"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="project-file-input"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="drive-add-open"]'),
    ).toBeNull();
    expect(container.querySelector('[data-testid="drive-connect"]')).toBeNull();
    expect(String(errors)).not.toMatch(/Rendered more hooks|#310/);
    await act(async () => root.unmount());
  });
});
