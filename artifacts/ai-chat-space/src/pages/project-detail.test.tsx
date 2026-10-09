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

import { projectsApi, type ProjectFile } from "@/lib/projects-api";

const baseProject = {
  id: 1,
  name: "テスト",
  description: "",
  instructions: "",
  createdAt: "2026-10-09T00:00:00Z",
  updatedAt: "2026-10-09T00:00:00Z",
};

const baseLimits = {
  fileMaxBytes: 20 * 1024 * 1024,
  maxFiles: 50,
  userMaxTotalBytes: 500 * 1024 * 1024,
  instructionsMaxChars: 4000,
  filesContextMaxChars: 8000,
  usage: { totalBytes: 0 },
};

function makeImageFile(overrides: Partial<ProjectFile> = {}): ProjectFile {
  return {
    id: 7,
    filename: "photo.png",
    mimeType: "image/png",
    sizeBytes: 12_345,
    textChars: 42,
    includeInContext: true,
    createdAt: "2026-10-09T00:00:00Z",
    kind: "image",
    imageWidth: 800,
    imageHeight: 600,
    hasThumbnail: true,
    sendImage: false,
    descriptionStatus: "ready",
    descriptionModel: "gpt-4o-mini",
    updatedAt: "2026-10-09T00:00:00Z",
    ...overrides,
  };
}

vi.mock("@/lib/projects-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/projects-api")>();
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      get: vi.fn(async () => baseProject),
      limits: vi.fn(async () => baseLimits),
      listFiles: vi.fn(async () => []),
      listFilesWithMeta: vi.fn(async () => ({
        files: [] as ProjectFile[],
        imageDescriptionAvailable: true,
      })),
      listConversations: vi.fn(async () => []),
      driveStatus: vi.fn(async () => ({
        configured: false,
        connected: false,
        hasDriveScope: false,
      })),
      listDriveFiles: vi.fn(async () => []),
      setFileSendImage: vi.fn(async (projectId: number, fileId: number) =>
        makeImageFile({ id: fileId, sendImage: true }),
      ),
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
  vi.restoreAllMocks();
});

async function renderProject(
  projectId = "1",
): Promise<{ root: ReturnType<typeof createRoot> }> {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const { hook } = memoryLocation({ path: `/projects/${projectId}` });
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
  return { root };
}

describe("ProjectDetailPage", () => {
  it("renders the loaded project with the upload dropzone (no hook-order crash)", async () => {
    const errors: unknown[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => errors.push(args));
    const { root } = await renderProject();
    spy.mockRestore();
    expect(
      container!.querySelector('[data-testid="project-dropzone"]'),
    ).not.toBeNull();
    expect(
      container!.querySelector('[data-testid="project-file-input"]'),
    ).not.toBeNull();
    // The new image picker input is present alongside the generic one.
    expect(
      container!.querySelector('[data-testid="project-image-input"]'),
    ).not.toBeNull();
    expect(
      container!.querySelector('[data-testid="project-upload-image"]'),
    ).not.toBeNull();
    expect(
      container!.querySelector('[data-testid="drive-add-open"]'),
    ).toBeNull();
    expect(
      container!.querySelector('[data-testid="drive-connect"]'),
    ).toBeNull();
    expect(String(errors)).not.toMatch(/Rendered more hooks|#310/);
    await act(async () => root.unmount());
  });

  it("renders an image file entry with a thumbnail and the send-image switch", async () => {
    const image = makeImageFile();
    vi.mocked(projectsApi.listFilesWithMeta).mockResolvedValueOnce({
      files: [image],
      imageDescriptionAvailable: true,
    });
    vi.mocked(projectsApi.get).mockResolvedValueOnce(baseProject);
    const { root } = await renderProject();

    const thumb = container!.querySelector(
      '[data-testid="project-file-thumb-7"]',
    );
    expect(thumb).not.toBeNull();
    expect(thumb?.getAttribute("src")).toContain(
      "/api/projects/1/files/7/thumbnail",
    );
    expect(thumb?.getAttribute("loading")).toBe("lazy");

    const sendSwitch = container!.querySelector(
      '[data-testid="project-file-send-image-7"]',
    );
    expect(sendSwitch).not.toBeNull();
    expect(sendSwitch?.getAttribute("aria-label")).toBe("画像そのものを送る");
    expect(sendSwitch?.getAttribute("data-state")).toBe("unchecked");

    // Status line should be present for ready images.
    const status = container!.querySelector(
      '[data-testid="project-file-status-7"]',
    );
    expect(status?.textContent ?? "").toContain("gpt-4o-mini");

    await act(async () => root.unmount());
  });

  it("toggling the send-image switch calls setFileSendImage with {sendImage:true}", async () => {
    const image = makeImageFile({ sendImage: false });
    vi.mocked(projectsApi.listFilesWithMeta).mockResolvedValueOnce({
      files: [image],
      imageDescriptionAvailable: true,
    });
    const setSpy = vi.mocked(projectsApi.setFileSendImage);
    const { root } = await renderProject();

    // Wait for the image row to render.
    for (let i = 0; i < 20; i += 1) {
      if (container!.querySelector('[data-testid="project-file-send-image-7"]'))
        break;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }

    const sendSwitch = container!.querySelector<HTMLElement>(
      '[data-testid="project-file-send-image-7"]',
    );
    expect(sendSwitch).not.toBeNull();
    // Radix Switch is a button — clicking it toggles.
    await act(async () => {
      sendSwitch?.click();
    });

    expect(setSpy).toHaveBeenCalledWith(1, 7, true);

    await act(async () => root.unmount());
  });
});
