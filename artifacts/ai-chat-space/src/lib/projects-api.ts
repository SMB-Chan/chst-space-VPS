/**
 * Typed client for the `/api/projects/*` endpoints.
 *
 * Wire shapes live here so the UI never depends on server field names
 * directly (see normalizeProjectsLimits).
 */

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const FETCH_INIT: RequestInit = { credentials: "include" };

/** Thrown by every helper. Carries the server-provided Japanese message. */
export class ProjectsApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "ProjectsApiError";
    this.status = status;
    this.code = code;
  }
}

async function readError(
  res: Response,
  fallback: string,
): Promise<ProjectsApiError> {
  let body: { error?: string; code?: string } | null = null;
  try {
    body = (await res.json()) as { error?: string; code?: string };
  } catch {
    /* non-JSON error body */
  }
  return new ProjectsApiError(
    body?.error || fallback,
    res.status,
    body?.code ?? null,
  );
}

async function readJson<T>(res: Response): Promise<T> {
  // The backend can return `{}` for empty 204; the JSON body parser ignores
  // them. We still call .json() defensively to support {project} wrappers.
  try {
    return (await res.json()) as T;
  } catch {
    return {} as T;
  }
}

export interface ProjectRecord {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  /** Custom instructions shown to the model in every chat of the project. */
  instructions?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface ProjectFile {
  id: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Number of text characters extracted server-side. */
  textChars: number;
  includeInContext: boolean;
  createdAt: string;
}

export interface ProjectConversation {
  id: number;
  title: string;
  createdAt: string;
  updatedAt?: string;
}

export interface ProjectsLimits {
  fileMaxBytes: number;
  maxFiles: number;
  userMaxTotalBytes: number;
  /** Maximum allowed characters for the instructions textarea. */
  instructionsMaxChars: number;
  /** Approximate chars of file text passed per message (token economy). */
  filesContextMaxChars: number;
  /** Per-file cap inside the context window. */
  perFileContextMaxChars: number;
  /** Maximum characters extracted from any single file. */
  fileTextMaxChars: number;
  usage: { totalBytes: number; fileCount: number };
}

/** Wire shape of GET /api/projects/limits (see api-server project-limits.ts). */
export interface ProjectsLimitsResponse {
  limits: {
    fileMaxBytes: number;
    maxFilesPerProject: number;
    userTotalMaxBytes: number;
    fileTextMaxChars: number;
    instructionsMaxChars: number;
    filesContextMaxChars: number;
    fileContextPerFileMaxChars: number;
  };
  usage: { totalBytes: number; fileCount: number };
}

/** Map the server response onto the UI's flat limits object. */
export function normalizeProjectsLimits(
  data: ProjectsLimitsResponse,
): ProjectsLimits {
  const l = data.limits;
  return {
    fileMaxBytes: l.fileMaxBytes,
    maxFiles: l.maxFilesPerProject,
    userMaxTotalBytes: l.userTotalMaxBytes,
    instructionsMaxChars: l.instructionsMaxChars,
    filesContextMaxChars: l.filesContextMaxChars,
    perFileContextMaxChars: l.fileContextPerFileMaxChars,
    fileTextMaxChars: l.fileTextMaxChars,
    usage: {
      totalBytes: data.usage?.totalBytes ?? 0,
      fileCount: data.usage?.fileCount ?? 0,
    },
  };
}

interface ProjectsListResponse {
  projects: ProjectRecord[];
}
interface ProjectResponse {
  project: ProjectRecord;
}
interface ProjectFilesResponse {
  files: ProjectFile[];
}
interface ProjectConversationsResponse {
  conversations: ProjectConversation[];
}
interface ProjectFileResponse {
  file: ProjectFile;
}
interface CreateProjectInput {
  name: string;
  description?: string | null;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  fallbackMessage = "リクエストに失敗しました。",
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...FETCH_INIT, ...init });
  if (!res.ok) {
    throw await readError(res, fallbackMessage);
  }
  if (res.status === 204) return {} as T;
  return readJson<T>(res);
}

export const projectsApi = {
  /** List the caller's projects. */
  list(): Promise<ProjectRecord[]> {
    return request<ProjectsListResponse>(
      "/api/projects",
      {},
      "プロジェクト一覧を取得できませんでした。",
    ).then((data) => data.projects ?? []);
  },

  get(id: number): Promise<ProjectRecord> {
    return request<ProjectResponse>(
      `/api/projects/${id}`,
      {},
      "プロジェクトを取得できませんでした。",
    ).then((data) => data.project);
  },

  create(input: CreateProjectInput): Promise<ProjectRecord> {
    return request<ProjectResponse>(
      "/api/projects",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: input.name.trim(),
          ...(input.description != null && input.description !== ""
            ? { description: input.description }
            : {}),
        }),
      },
      "プロジェクトを作成できませんでした。",
    ).then((data) => data.project);
  },

  update(
    id: number,
    patch: {
      name?: string;
      description?: string | null;
      instructions?: string | null;
    },
  ): Promise<ProjectRecord> {
    return request<ProjectResponse>(
      `/api/projects/${id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
      "プロジェクトを更新できませんでした。",
    ).then((data) => data.project);
  },

  remove(id: number): Promise<void> {
    return request<{ deleted?: boolean }>(
      `/api/projects/${id}`,
      { method: "DELETE" },
      "プロジェクトを削除できませんでした。",
    ).then(() => undefined);
  },

  limits(): Promise<ProjectsLimits> {
    return request<ProjectsLimitsResponse>(
      "/api/projects/limits",
      {},
      "プロジェクトの上限を取得できませんでした。",
    ).then(normalizeProjectsLimits);
  },

  listFiles(projectId: number): Promise<ProjectFile[]> {
    return request<ProjectFilesResponse>(
      `/api/projects/${projectId}/files`,
      {},
      "参考ファイル一覧を取得できませんでした。",
    ).then((data) => data.files ?? []);
  },

  uploadFile(
    projectId: number,
    file: { filename: string; dataBase64: string },
  ): Promise<ProjectFile> {
    return request<ProjectFileResponse>(
      `/api/projects/${projectId}/files`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(file),
      },
      "参考ファイルをアップロードできませんでした。",
    ).then((data) => data.file);
  },

  setFileInclusion(
    projectId: number,
    fileId: number,
    includeInContext: boolean,
  ): Promise<ProjectFile> {
    return request<ProjectFileResponse>(
      `/api/projects/${projectId}/files/${fileId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeInContext }),
      },
      "ファイル設定を更新できませんでした。",
    ).then((data) => data.file);
  },

  removeFile(projectId: number, fileId: number): Promise<void> {
    return request<{ deleted?: boolean }>(
      `/api/projects/${projectId}/files/${fileId}`,
      { method: "DELETE" },
      "ファイルを削除できませんでした。",
    ).then(() => undefined);
  },

  fileDownloadUrl(projectId: number, fileId: number): string {
    return `${BASE}/api/projects/${projectId}/files/${fileId}/download`;
  },

  listConversations(projectId: number): Promise<ProjectConversation[]> {
    return request<ProjectConversationsResponse>(
      `/api/projects/${projectId}/conversations`,
      {},
      "プロジェクトの会話一覧を取得できませんでした。",
    ).then((data) => data.conversations ?? []);
  },

  assignConversation(projectId: number, conversationId: number): Promise<void> {
    return request<{ ok?: boolean }>(
      `/api/projects/${projectId}/conversations/${conversationId}`,
      { method: "PUT" },
      "会話をプロジェクトに追加できませんでした。",
    ).then(() => undefined);
  },

  unassignConversation(
    projectId: number,
    conversationId: number,
  ): Promise<void> {
    return request<{ ok?: boolean }>(
      `/api/projects/${projectId}/conversations/${conversationId}`,
      { method: "DELETE" },
      "会話をプロジェクトから外せませんでした。",
    ).then(() => undefined);
  },
};

/**
 * Read a `File` as base64 without overflowing the call stack for >1 MB blobs.
 * Uses FileReader.readAsDataURL and strips the data URL prefix.
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("ファイルを読み込めませんでした。"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("ファイルの読み込み結果が不正です。"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Base64-encode a string. Encodes the input as UTF-8 (so non-ASCII survives)
 * and processes it in 32 KB chunks — `btoa` on a large string also throws on
 * inputs > ~256 KB.
 */
export function stringToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return btoa(binary);
}

/**
 * Decode a base64 string. Mirrors {@link stringToBase64} — same chunking
 * rationale and UTF-8 round-trip.
 */
export function base64ToString(b64: string): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < b64.length; i += CHUNK) {
    binary += atob(b64.slice(i, i + CHUNK));
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Parse the `project` query parameter (positive int or null) from a location
 * search string. Returns null when missing or invalid.
 */
export function parseProjectIdFromSearch(search: string): number | null {
  const params = new URLSearchParams(
    search.startsWith("?") ? search : `?${search}`,
  );
  const raw = params.get("project");
  if (!raw) return null;
  // Strictly digits only — `parseInt("1.5", 10)` would return 1.
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
