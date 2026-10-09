import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DriveReferences } from "./drive-references";
import { projectsApi, type ProjectDriveFile } from "@/lib/projects-api";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
afterEach(() => {
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

function makeRef(overrides: Partial<ProjectDriveFile> = {}): ProjectDriveFile {
  return {
    id: 42,
    projectId: 1,
    driveFileId: "drive-1",
    name: "設計書.pdf",
    mimeType: "application/pdf",
    sizeBytes: 12_345,
    driveModifiedTime: "2026-10-01T00:00:00Z",
    webViewLink: "https://drive.google.com/file/d/drive-1/view",
    textChars: 1234,
    includeInContext: true,
    fetchError: null,
    fetchedAt: "2026-10-02T00:00:00Z",
    createdAt: "2026-10-02T00:00:00Z",
    ...overrides,
  };
}

async function flush() {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

describe("DriveReferences", () => {
  it("configured + connected with one reference renders the add button and the row", async () => {
    vi.spyOn(projectsApi, "driveStatus").mockResolvedValue({
      configured: true,
      connected: true,
      hasDriveScope: true,
      accountEmail: "me@example.com",
    });
    vi.spyOn(projectsApi, "listDriveFiles").mockResolvedValue([makeRef()]);
    vi.spyOn(projectsApi, "driveSearch").mockResolvedValue([]);

    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<DriveReferences projectId={1} />);
    });
    await flush();

    expect(
      container.querySelector('[data-testid="drive-add-open"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="drive-ref-42"]'),
    ).not.toBeNull();
    expect(container.textContent ?? "").toContain("設計書.pdf");
    expect(container.querySelector('[data-testid="drive-connect"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("configured but not connected renders the connect button", async () => {
    vi.spyOn(projectsApi, "driveStatus").mockResolvedValue({
      configured: true,
      connected: false,
      hasDriveScope: false,
    });
    vi.spyOn(projectsApi, "listDriveFiles").mockResolvedValue([]);
    vi.spyOn(projectsApi, "driveSearch").mockResolvedValue([]);

    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<DriveReferences projectId={1} />);
    });
    await flush();

    expect(
      container.querySelector('[data-testid="drive-connect"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="drive-add-open"]'),
    ).toBeNull();
    expect(container.textContent ?? "").toContain("Googleアカウントと連携");

    await act(async () => root.unmount());
  });

  it("not configured and no references renders nothing", async () => {
    vi.spyOn(projectsApi, "driveStatus").mockResolvedValue({
      configured: false,
      connected: false,
      hasDriveScope: false,
    });
    vi.spyOn(projectsApi, "listDriveFiles").mockResolvedValue([]);

    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<DriveReferences projectId={1} />);
    });
    await flush();

    expect(
      container.querySelector('[data-testid="drive-references-block"]'),
    ).toBeNull();
    expect(container.querySelector('[data-testid="drive-connect"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="drive-add-open"]'),
    ).toBeNull();

    await act(async () => root.unmount());
  });

  it("stays invisible when the status call fails and there are no references", async () => {
    vi.spyOn(projectsApi, "driveStatus").mockRejectedValue(
      new Error("network"),
    );
    vi.spyOn(projectsApi, "listDriveFiles").mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<DriveReferences projectId={1} />);
    });
    await flush();
    expect(container.innerHTML).toBe("");
    await act(async () => root.unmount());
  });
});
