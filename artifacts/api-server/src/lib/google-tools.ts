import { z } from "zod";
import type {
  SpecialistToolCall,
  SpecialistToolDefinition,
  SpecialistToolResult,
} from "./specialist-capabilities";
import { getValidAccessToken } from "./google-auth";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const dateTimeDescription =
  "RFC3339形式の日時（例: 2026-09-14T10:00:00+09:00 または 2026-09-14T10:00:00Z）";

export function getGoogleToolDefinitions(): SpecialistToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "google_calendar_list_calendars",
        description:
          "ユーザーのGoogleカレンダー一覧を取得します。イベント操作の前にcalendarIdを確認したい場合に使います。",
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "google_calendar_list_events",
        description:
          "Googleカレンダーの予定を期間指定で取得します。「今週の予定を教えて」「明日は何がある？」といった質問に使ってください。",
        parameters: {
          type: "object",
          properties: {
            timeMin: {
              type: "string",
              description: `取得開始日時。${dateTimeDescription}`,
            },
            timeMax: {
              type: "string",
              description: `取得終了日時。${dateTimeDescription}`,
            },
            calendarId: {
              type: "string",
              description: "カレンダーID。省略時はメインカレンダー。",
            },
            query: {
              type: "string",
              description: "絞り込み用の自由文キーワード（任意）。",
            },
            maxResults: {
              type: "number",
              description: "最大取得件数（1-50、既定25）。",
            },
          },
          required: ["timeMin", "timeMax"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "google_calendar_create_event",
        description:
          "Googleカレンダーに予定を新規登録します。タイトル・開始・終了は必須です。",
        parameters: {
          type: "object",
          properties: {
            summary: { type: "string", description: "予定のタイトル" },
            start: {
              type: "string",
              description: `開始日時。${dateTimeDescription}`,
            },
            end: {
              type: "string",
              description: `終了日時。${dateTimeDescription}`,
            },
            description: { type: "string", description: "説明（任意）" },
            location: { type: "string", description: "場所（任意）" },
            attendees: {
              type: "array",
              items: { type: "string" },
              description: "参加者のメールアドレス一覧（任意）",
            },
            calendarId: {
              type: "string",
              description: "カレンダーID。省略時はメインカレンダー。",
            },
          },
          required: ["summary", "start", "end"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "google_calendar_update_event",
        description:
          "既存のGoogleカレンダー予定を部分的に更新します。eventIdにはgoogle_calendar_list_eventsで取得したIDを指定してください。",
        parameters: {
          type: "object",
          properties: {
            eventId: { type: "string", description: "更新する予定のID" },
            summary: {
              type: "string",
              description: "新しいタイトル（変更する場合のみ）",
            },
            start: {
              type: "string",
              description: `新しい開始日時。${dateTimeDescription}`,
            },
            end: {
              type: "string",
              description: `新しい終了日時。${dateTimeDescription}`,
            },
            description: {
              type: "string",
              description: "新しい説明（変更する場合のみ）",
            },
            location: {
              type: "string",
              description: "新しい場所（変更する場合のみ）",
            },
            calendarId: {
              type: "string",
              description: "カレンダーID。省略時はメインカレンダー。",
            },
          },
          required: ["eventId"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "google_calendar_delete_event",
        description:
          "Googleカレンダーから予定を削除します。ユーザーが明示的に削除を求めた場合だけ使ってください。",
        parameters: {
          type: "object",
          properties: {
            eventId: { type: "string", description: "削除する予定のID" },
            calendarId: {
              type: "string",
              description: "カレンダーID。省略時はメインカレンダー。",
            },
          },
          required: ["eventId"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "gmail_search_messages",
        description:
          "GmailのメッセージをGmail検索構文で検索します（例: from:example.com is:unread newer_than:7d）。本文は返さず、件名・差出人・日付・スニペットの一覧を返します。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Gmail検索クエリ" },
            maxResults: {
              type: "number",
              description: "最大取得件数（1-20、既定10）。",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "gmail_read_message",
        description:
          "Gmailのメッセージ1件の本文（テキスト部分）を取得します。gmail_search_messagesで取得したメッセージIDを指定してください。",
        parameters: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "メッセージID" },
          },
          required: ["messageId"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "google_drive_search_files",
        description:
          "Googleドライブのファイルを名前・内容で検索し、一覧（名前・種類・更新日・リンク）を返します。",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "検索キーワード。Drive検索構文（例: name contains '報告書'）でも可。",
            },
            maxResults: {
              type: "number",
              description: "最大取得件数（1-25、既定10）。",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Google REST helpers (plain fetch, no googleapis dependency)
// ---------------------------------------------------------------------------

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const DRIVE_API = "https://www.googleapis.com/drive/v3";

async function googleApi<T>(
  userId: string,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const token = await getValidAccessToken(userId);
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    signal: init?.signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Google API呼び出しに失敗しました (${res.status}): ${detail.slice(0, 300)}`,
    );
  }
  return (await res.json()) as T;
}

function parseArgs<T>(schema: z.ZodType<T>, raw: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Googleツールの引数JSONが不正です");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `Googleツールの引数が不正です: ${issue ? `${issue.path.join(".")} ${issue.message}` : "unknown"}`,
    );
  }
  return result.data;
}

function calendarIdOrDefault(id?: string): string {
  return id?.trim() || "primary";
}

function formatEvent(ev: {
  id?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  description?: string;
  htmlLink?: string;
}): string {
  const start = ev.start?.dateTime ?? ev.start?.date ?? "(未設定)";
  const end = ev.end?.dateTime ?? ev.end?.date ?? "(未設定)";
  const lines = [
    `- ${ev.summary || "(タイトルなし)"} | ID: ${ev.id} | 開始: ${start} | 終了: ${end}`,
  ];
  if (ev.location) lines.push(`  場所: ${ev.location}`);
  if (ev.description) lines.push(`  説明: ${ev.description.slice(0, 300)}`);
  if (ev.htmlLink) lines.push(`  URL: ${ev.htmlLink}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

const listCalendarsArgs = z.object({}).strict();

const listEventsArgs = z.object({
  timeMin: z.string().trim().min(1),
  timeMax: z.string().trim().min(1),
  calendarId: z.string().trim().max(200).optional(),
  query: z.string().trim().max(200).optional(),
  maxResults: z.number().int().min(1).max(50).optional(),
});

const createEventArgs = z.object({
  summary: z.string().trim().min(1).max(500),
  start: z.string().trim().min(1),
  end: z.string().trim().min(1),
  description: z.string().trim().max(4000).optional(),
  location: z.string().trim().max(500).optional(),
  attendees: z.array(z.string().trim().email()).max(20).optional(),
  calendarId: z.string().trim().max(200).optional(),
});

const updateEventArgs = z.object({
  eventId: z.string().trim().min(1).max(300),
  summary: z.string().trim().max(500).optional(),
  start: z.string().trim().min(1).optional(),
  end: z.string().trim().min(1).optional(),
  description: z.string().trim().max(4000).optional(),
  location: z.string().trim().max(500).optional(),
  calendarId: z.string().trim().max(200).optional(),
});

const deleteEventArgs = z.object({
  eventId: z.string().trim().min(1).max(300),
  calendarId: z.string().trim().max(200).optional(),
});

const gmailSearchArgs = z.object({
  query: z.string().trim().min(1).max(500),
  maxResults: z.number().int().min(1).max(20).optional(),
});

const gmailReadArgs = z.object({
  messageId: z.string().trim().min(1).max(200),
});

const driveSearchArgs = z.object({
  query: z.string().trim().min(1).max(500),
  maxResults: z.number().int().min(1).max(25).optional(),
});

export async function executeGoogleTool(
  call: SpecialistToolCall,
  options: { userId: string; signal?: AbortSignal },
): Promise<SpecialistToolResult> {
  try {
    const userId = options.userId;
    const signal = options.signal;

    if (call.name === "google_calendar_list_calendars") {
      parseArgs(listCalendarsArgs, call.arguments);
      const data = await googleApi<{
        items?: { id?: string; summary?: string; primary?: boolean }[];
      }>(userId, `${CALENDAR_API}/users/me/calendarList`, { signal });
      const items = data.items ?? [];
      const text =
        items
          .map(
            (c) =>
              `- ${c.summary || "(無題)"} | ID: ${c.id}${c.primary ? " (メイン)" : ""}`,
          )
          .join("\n") || "カレンダーが見つかりませんでした。";
      return {
        ok: true,
        capability: "web-search",
        summary: `${items.length}件のカレンダーを取得しました。`,
        text,
      };
    }

    if (call.name === "google_calendar_list_events") {
      const args = parseArgs(listEventsArgs, call.arguments);
      const cal = calendarIdOrDefault(args.calendarId);
      const params = new URLSearchParams({
        timeMin: args.timeMin,
        timeMax: args.timeMax,
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(args.maxResults ?? 25),
      });
      if (args.query) params.set("q", args.query);
      const data = await googleApi<{
        items?: Parameters<typeof formatEvent>[0][];
      }>(
        userId,
        `${CALENDAR_API}/calendars/${encodeURIComponent(cal)}/events?${params}`,
        { signal },
      );
      const events = data.items ?? [];
      const text =
        events.map(formatEvent).join("\n") ||
        "指定された期間の予定はありません。";
      return {
        ok: true,
        capability: "web-search",
        summary: `${events.length}件の予定を取得しました。`,
        text,
      };
    }

    if (call.name === "google_calendar_create_event") {
      const args = parseArgs(createEventArgs, call.arguments);
      const cal = calendarIdOrDefault(args.calendarId);
      const allDay = !args.start.includes("T") || !args.end.includes("T");
      const body = {
        summary: args.summary,
        ...(args.description ? { description: args.description } : {}),
        ...(args.location ? { location: args.location } : {}),
        ...(args.attendees?.length
          ? {
              attendees: args.attendees.map((email) => ({ email })),
            }
          : {}),
        start: allDay
          ? { date: args.start.slice(0, 10) }
          : { dateTime: args.start },
        end: allDay ? { date: args.end.slice(0, 10) } : { dateTime: args.end },
      };
      const ev = await googleApi<Parameters<typeof formatEvent>[0]>(
        userId,
        `${CALENDAR_API}/calendars/${encodeURIComponent(cal)}/events?sendUpdates=none`,
        { method: "POST", body: JSON.stringify(body), signal },
      );
      return {
        ok: true,
        capability: "web-search",
        summary: `予定「${ev.summary ?? args.summary}」を作成しました。`,
        text: formatEvent(ev),
      };
    }

    if (call.name === "google_calendar_update_event") {
      const args = parseArgs(updateEventArgs, call.arguments);
      const cal = calendarIdOrDefault(args.calendarId);
      const existing = await googleApi<{
        summary?: string;
        description?: string;
        location?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
      }>(
        userId,
        `${CALENDAR_API}/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(args.eventId)}`,
        { signal },
      );
      const body: Record<string, unknown> = {
        summary: args.summary ?? existing.summary,
        description: args.description ?? existing.description,
        location: args.location ?? existing.location,
      };
      if (args.start) {
        body.start = args.start.includes("T")
          ? { dateTime: args.start }
          : { date: args.start.slice(0, 10) };
      }
      if (args.end) {
        body.end = args.end.includes("T")
          ? { dateTime: args.end }
          : { date: args.end.slice(0, 10) };
      }
      const ev = await googleApi<Parameters<typeof formatEvent>[0]>(
        userId,
        `${CALENDAR_API}/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(args.eventId)}`,
        { method: "PATCH", body: JSON.stringify(body), signal },
      );
      return {
        ok: true,
        capability: "web-search",
        summary: `予定「${ev.summary ?? args.eventId}」を更新しました。`,
        text: formatEvent(ev),
      };
    }

    if (call.name === "google_calendar_delete_event") {
      const args = parseArgs(deleteEventArgs, call.arguments);
      const cal = calendarIdOrDefault(args.calendarId);
      const token = await getValidAccessToken(userId);
      const res = await fetch(
        `${CALENDAR_API}/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(args.eventId)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
          signal,
        },
      );
      if (!res.ok && res.status !== 410 && res.status !== 404) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `予定の削除に失敗しました (${res.status}): ${detail.slice(0, 300)}`,
        );
      }
      return {
        ok: true,
        capability: "web-search",
        summary: "予定を削除しました。",
        text: "",
      };
    }

    if (call.name === "gmail_search_messages") {
      const args = parseArgs(gmailSearchArgs, call.arguments);
      const params = new URLSearchParams({
        q: args.query,
        maxResults: String(args.maxResults ?? 10),
      });
      const data = await googleApi<{
        messages?: { id: string; threadId: string }[];
      }>(userId, `${GMAIL_API}/messages?${params}`, { signal });
      const ids = data.messages ?? [];
      const messages = await Promise.all(
        ids.map(({ id }) =>
          googleApi<{
            id: string;
            snippet?: string;
            payload?: { headers?: { name: string; value: string }[] };
          }>(
            userId,
            `${GMAIL_API}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
            { signal },
          ),
        ),
      );
      const text =
        messages
          .map((m) => {
            const header = (name: string) =>
              m.payload?.headers?.find((h) => h.name === name)?.value ?? "";
            return `- ID: ${m.id} | 件名: ${header("Subject")} | 差出人: ${header("From")} | 日付: ${header("Date")}\n  概要: ${(m.snippet ?? "").slice(0, 200)}`;
          })
          .join("\n") || "該当するメールは見つかりませんでした。";
      return {
        ok: true,
        capability: "web-search",
        summary: `Gmail検索で${messages.length}件のメッセージを取得しました。`,
        text,
      };
    }

    if (call.name === "gmail_read_message") {
      const args = parseArgs(gmailReadArgs, call.arguments);
      const message = await googleApi<GmailMessage>(
        userId,
        `${GMAIL_API}/messages/${encodeURIComponent(args.messageId)}?format=full`,
        { signal },
      );
      const header = (name: string) =>
        message.payload?.headers?.find((h) => h.name === name)?.value ?? "";
      const bodyText = extractGmailBody(message.payload);
      const text = [
        `件名: ${header("Subject")}`,
        `差出人: ${header("From")}`,
        `日付: ${header("Date")}`,
        "",
        bodyText || "(テキスト本文なし)",
      ].join("\n");
      return {
        ok: true,
        capability: "web-search",
        summary: `メール「${header("Subject")}」を取得しました。`,
        text: text.slice(0, 8000),
      };
    }

    if (call.name === "google_drive_search_files") {
      const args = parseArgs(driveSearchArgs, call.arguments);
      const escaped = args.query.replace(/'/g, "\\'");
      const params = new URLSearchParams({
        q: `fullText contains '${escaped}' or name contains '${escaped}'`,
        pageSize: String(args.maxResults ?? 10),
        fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      const data = await googleApi<{
        files?: {
          id: string;
          name: string;
          mimeType: string;
          modifiedTime?: string;
          webViewLink?: string;
        }[];
      }>(userId, `${DRIVE_API}/files?${params}`, { signal });
      const files = data.files ?? [];
      const text =
        files
          .map(
            (f) =>
              `- ${f.name} | 種類: ${f.mimeType} | 更新: ${f.modifiedTime ?? "?"} | URL: ${f.webViewLink ?? "-"}`,
          )
          .join("\n") || "該当するファイルは見つかりませんでした。";
      return {
        ok: true,
        capability: "web-search",
        summary: `Googleドライブで${files.length}件のファイルを取得しました。`,
        text,
      };
    }

    throw new Error("不明なGoogleツールです");
  } catch (error) {
    return {
      ok: false,
      capability: "web-search",
      summary:
        error instanceof Error
          ? error.message
          : "Googleツールの実行に失敗しました",
      text: "",
    };
  }
}

const GOOGLE_TOOL_NAMES = new Set(
  getGoogleToolDefinitions().map((tool) => tool.function.name),
);

export function isGoogleTool(name: string): boolean {
  return GOOGLE_TOOL_NAMES.has(name);
}

// ---------------------------------------------------------------------------
// Gmail body extraction
// ---------------------------------------------------------------------------

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  snippet?: string;
  payload?: GmailPart & { headers?: { name: string; value: string }[] };
}

function decodeBase64Url(data: string): string {
  return Buffer.from(
    data.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("utf8");
}

function extractGmailBody(part?: GmailPart): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  if (part.parts?.length) {
    const plain = part.parts.find((p) => p.mimeType === "text/plain");
    if (plain) return extractGmailBody(plain);
    const html = part.parts.find((p) => p.mimeType === "text/html");
    if (html) {
      return extractGmailBody(html)
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
    }
    for (const child of part.parts) {
      const nested = extractGmailBody(child);
      if (nested) return nested;
    }
  }
  return "";
}
