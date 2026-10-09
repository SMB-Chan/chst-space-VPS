// Tiny fetch helper shared by every admin tab. Each call:
//   - prefixes the request with the Vite base URL so sub-paths work,
//   - parses JSON for non-2xx responses into a `{error}` shape and surfaces
//     a discriminated result so the tabs can render the server's Japanese
//     message without re-implementing the parsing.
//   - returns 204 No Content as success with `null`.
//
// Mutations return either `{ id }` (create) or 204 (update/delete); the tabs
// re-fetch their list afterwards instead of relying on the response body.

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export type ApiFailure = { ok: false; error: string; status: number };
export type ApiSuccess<T> = { ok: true; value: T };
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

async function parseErrorBody(response: Response): Promise<string> {
  const fallback = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown } | null;
    if (body && typeof body.error === "string" && body.error.trim()) {
      return body.error;
    }
  } catch {
    /* fall through */
  }
  return fallback;
}

export async function adminRequest<T>(
  url: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${url}`, {
      credentials: "include",
      ...init,
    });
  } catch {
    return {
      ok: false,
      error: "サーバーに接続できませんでした。",
      status: 0,
    };
  }
  if (response.status === 204) {
    return { ok: true, value: null as T };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: await parseErrorBody(response),
      status: response.status,
    };
  }
  try {
    const data = (await response.json()) as T;
    return { ok: true, value: data };
  } catch {
    return {
      ok: false,
      error: "応答の解析に失敗しました。",
      status: response.status,
    };
  }
}

function jsonInit(method: string, payload?: unknown): RequestInit {
  const headers = { "Content-Type": "application/json" };
  if (payload === undefined) {
    return { method, headers };
  }
  return { method, headers, body: JSON.stringify(payload) };
}

export interface AdminProvider {
  id: string;
  label: string;
  kind: "builtin" | "custom";
  baseUrl: string | null;
  enabled: boolean;
  hasKey: boolean;
  keyHint: string | null;
  configured: boolean;
  /** Built-in only: whether the env key is currently used. */
  useEnvKey: boolean;
  /** Built-in only: whether the env key is present. */
  envKeyPresent: boolean;
  /** Where the live key comes from for this provider. */
  keySource: "db" | "env" | "none";
  /** Soft delete (built-in only). */
  deleted: boolean;
  modelCount: number;
}

export interface AdminModel {
  id: string;
  providerId: string;
  providerLabel: string;
  label: string;
  description: string;
  supportsVision: boolean;
  supportsReasoning: boolean;
  enabled: boolean;
  userVisible: boolean;
  builtin: boolean;
  sortOrder: number;
}

export interface AdminAccount {
  id: string;
  username: string;
  displayName: string | null;
  role: "admin" | "user";
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AdminAccountsPayload {
  authMode: "local" | "clerk" | "password";
  accounts: AdminAccount[];
}

export interface AdminCreated {
  id: string;
}

export interface AdminAuthMode {
  authMode: "local" | "clerk" | "password";
  user: AdminAccount | null;
}

export const adminApi = {
  fetchMe: () => adminRequest<AdminAuthMode>(`/api/auth/me`),
  fetchAccounts: () =>
    adminRequest<AdminAccountsPayload>(`/api/admin/accounts`),
  createAccount: (payload: {
    username: string;
    displayName?: string;
    password: string;
    role: "admin" | "user";
  }) =>
    adminRequest<AdminCreated>(
      `/api/admin/accounts`,
      jsonInit("POST", payload),
    ),
  updateAccount: (
    id: string,
    payload: {
      displayName?: string | null;
      role?: "admin" | "user";
      password?: string;
    },
  ) =>
    adminRequest<null>(
      `/api/admin/accounts/${encodeURIComponent(id)}`,
      jsonInit("PATCH", payload),
    ),
  deleteAccount: (id: string, purgeData: boolean) =>
    adminRequest<null>(
      `/api/admin/accounts/${encodeURIComponent(id)}${
        purgeData ? "?purgeData=true" : ""
      }`,
      jsonInit("DELETE"),
    ),

  fetchProviders: () => adminRequest<AdminProvider[]>(`/api/admin/providers`),
  createProvider: (payload: {
    id: string;
    label: string;
    baseUrl: string;
    apiKey: string;
  }) =>
    adminRequest<AdminCreated>(
      `/api/admin/providers`,
      jsonInit("POST", payload),
    ),
  updateProvider: (
    id: string,
    payload: {
      label?: string;
      baseUrl?: string;
      apiKey?: string;
      enabled?: boolean;
      useEnvKey?: boolean;
    },
  ) =>
    adminRequest<null>(
      `/api/admin/providers/${encodeURIComponent(id)}`,
      jsonInit("PATCH", payload),
    ),
  deleteProvider: (id: string) =>
    adminRequest<null>(
      `/api/admin/providers/${encodeURIComponent(id)}`,
      jsonInit("DELETE"),
    ),
  deleteProviderKey: (id: string) =>
    adminRequest<null>(
      `/api/admin/providers/${encodeURIComponent(id)}/key`,
      jsonInit("DELETE"),
    ),
  restoreProvider: (id: string) =>
    adminRequest<null>(
      `/api/admin/providers/${encodeURIComponent(id)}/restore`,
      jsonInit("POST"),
    ),

  fetchModels: () => adminRequest<AdminModel[]>(`/api/admin/models`),
  createModel: (payload: {
    id: string;
    providerId: string;
    label: string;
    description?: string;
    supportsVision?: boolean;
    supportsReasoning?: boolean;
    userVisible?: boolean;
    enabled?: boolean;
  }) =>
    adminRequest<AdminCreated & { restored: boolean }>(
      `/api/admin/models`,
      jsonInit("POST", payload),
    ),
  updateModel: (
    id: string,
    payload: {
      label?: string;
      description?: string | null;
      enabled?: boolean;
      userVisible?: boolean;
      supportsVision?: boolean;
      supportsReasoning?: boolean;
    },
  ) =>
    adminRequest<null>(
      `/api/admin/models/${encodeURIComponent(id)}`,
      jsonInit("PATCH", payload),
    ),
  deleteModel: (id: string) =>
    adminRequest<null>(
      `/api/admin/models/${encodeURIComponent(id)}`,
      jsonInit("DELETE"),
    ),
};
