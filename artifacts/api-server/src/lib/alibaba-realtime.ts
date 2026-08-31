import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { AVAILABLE_MODELS } from "./ai-clients";
import {
  ALIBABA_REALTIME_MODEL_ID,
  getAlibabaSpecialistConfig,
  resolveAlibabaRealtimeWebSocketUrl,
} from "./alibaba-specialist-config";
import { logger, safeFailureFields } from "./logger";

const SESSION_TTL_MS = 60_000;
const MAX_SESSION_MS = 5 * 60_000;
const MAX_AUDIO_CHUNK_BYTES = 96 * 1024;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const MAX_CLIENT_MESSAGE_BYTES = 140 * 1024;
const MAX_SESSIONS_PER_USER = 1;
const PROVIDER_CONNECT_TIMEOUT_MS = 15_000;
const SESSION_IDLE_TIMEOUT_MS = 45_000;
const MAX_ACTIVE_SESSIONS = 8;

export type RealtimeClientMessage =
  | { type: "session.start"; conversationId?: number; modelId: string }
  | { type: "audio.append"; audio: string }
  | { type: "audio.commit" }
  | { type: "session.cancel" };

export interface RealtimeSessionRequest {
  userId: string;
  conversationId?: number;
  modelId: string;
}

interface SessionTicket {
  token: string;
  userId: string;
  conversationId?: number;
  modelId: string;
  expiresAt: number;
  claimed: boolean;
}

export interface RealtimeSessionResponse {
  token: string;
  expiresAt: number;
  modelId: typeof ALIBABA_REALTIME_MODEL_ID;
  websocketPath: string;
  maxSessionSeconds: number;
}

export class AlibabaRealtimeError extends Error {
  readonly publicMessage: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    publicMessage = "リアルタイム音声を開始できませんでした。",
    retryable = true,
  ) {
    super(message);
    this.name = "AlibabaRealtimeError";
    this.publicMessage = publicMessage;
    this.retryable = retryable;
  }
}

const tickets = new Map<string, SessionTicket>();
const activeUsers = new Set<string>();

function pruneTickets(now = Date.now()): void {
  for (const [token, ticket] of tickets) {
    if (ticket.expiresAt <= now && !ticket.claimed) tickets.delete(token);
  }
}

function pendingTicketCount(userId?: string): number {
  let count = 0;
  for (const ticket of tickets.values()) {
    if (!ticket.claimed && (userId === undefined || ticket.userId === userId))
      count += 1;
  }
  return count;
}

function normalizeConversationId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function createAlibabaRealtimeSession(
  request: RealtimeSessionRequest,
  env: NodeJS.ProcessEnv = process.env,
): RealtimeSessionResponse {
  const specialist = getAlibabaSpecialistConfig(env);
  if (!specialist) {
    throw new AlibabaRealtimeError(
      "Regular Model Studio specialist credentials are not configured",
      "サーバー用の通常のAlibaba Model Studio資格情報が設定されていません。",
      false,
    );
  }
  if (!request.userId || request.userId.length > 255) {
    throw new AlibabaRealtimeError(
      "Invalid realtime user",
      "認証情報を確認してください。",
      false,
    );
  }
  if (!AVAILABLE_MODELS.some((model) => model.id === request.modelId)) {
    throw new AlibabaRealtimeError(
      "Invalid route model",
      "選択中のチャットモデルには対応していません。",
      false,
    );
  }
  const conversationId = normalizeConversationId(request.conversationId);
  if (request.conversationId !== undefined && conversationId === undefined) {
    throw new AlibabaRealtimeError(
      "Invalid conversation id",
      "会話IDが不正です。",
      false,
    );
  }
  pruneTickets();
  if (
    (activeUsers.has(request.userId) ? 1 : 0) +
      pendingTicketCount(request.userId) >=
    MAX_SESSIONS_PER_USER
  ) {
    throw new AlibabaRealtimeError(
      "Realtime session already active or reserved for user",
      "リアルタイム音声はすでに別のタブで使用中です。",
      false,
    );
  }
  if (activeUsers.size + pendingTicketCount() >= MAX_ACTIVE_SESSIONS) {
    throw new AlibabaRealtimeError(
      "Realtime session capacity exhausted",
      "リアルタイム音声が混み合っています。少し待ってから再試行してください。",
    );
  }
  // Resolve now so a malformed or untrusted configured endpoint fails before
  // the browser receives a session ticket.
  resolveAlibabaRealtimeWebSocketUrl(env);
  const token = randomUUID();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  tickets.set(token, {
    token,
    userId: request.userId,
    ...(conversationId ? { conversationId } : {}),
    modelId: request.modelId,
    expiresAt,
    claimed: false,
  });
  return {
    token,
    expiresAt,
    modelId: ALIBABA_REALTIME_MODEL_ID,
    websocketPath: "/api/openai/realtime",
    maxSessionSeconds: MAX_SESSION_MS / 1000,
  };
}

function safeText(value: unknown, max = 500): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function parseClientMessage(data: RawData): RealtimeClientMessage {
  const bytes = Buffer.isBuffer(data)
    ? data.length
    : data instanceof ArrayBuffer
      ? data.byteLength
      : Array.isArray(data)
        ? data.reduce((total, item) => total + item.length, 0)
        : Buffer.byteLength(data);
  if (bytes > MAX_CLIENT_MESSAGE_BYTES) {
    throw new AlibabaRealtimeError(
      "Client message exceeds size limit",
      "音声データが大きすぎます。",
      false,
    );
  }
  const text = Buffer.isBuffer(data)
    ? data.toString("utf8")
    : data instanceof ArrayBuffer
      ? Buffer.from(data).toString("utf8")
      : Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : data;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AlibabaRealtimeError(
      "Invalid realtime client JSON",
      "音声セッションのメッセージが不正です。",
      false,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new AlibabaRealtimeError(
      "Invalid realtime client message",
      "音声セッションのメッセージが不正です。",
      false,
    );
  }
  const value = parsed as Record<string, unknown>;
  if (value.type === "audio.append") {
    if (
      typeof value.audio !== "string" ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value.audio)
    ) {
      throw new AlibabaRealtimeError(
        "Invalid audio payload",
        "音声データが不正です。",
        false,
      );
    }
    const decodedSize = Math.floor((value.audio.length * 3) / 4);
    if (decodedSize <= 0 || decodedSize > MAX_AUDIO_CHUNK_BYTES) {
      throw new AlibabaRealtimeError(
        "Audio chunk exceeds size limit",
        "音声データが大きすぎます。",
        false,
      );
    }
    return { type: "audio.append", audio: value.audio };
  }
  if (value.type === "audio.commit") return { type: "audio.commit" };
  if (value.type === "session.cancel") return { type: "session.cancel" };
  if (value.type === "session.start") {
    throw new AlibabaRealtimeError(
      "Session start must be sent during ticket creation",
      "音声セッションを開始できません。",
      false,
    );
  }
  throw new AlibabaRealtimeError(
    "Unsupported realtime client event",
    "音声セッションの操作に対応していません。",
    false,
  );
}

function providerEvent(
  type: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return { type, ...body };
}

function providerText(event: Record<string, unknown>): string {
  return (
    safeText(event.delta) || safeText(event.text) || safeText(event.transcript)
  );
}

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(payload));
}

function closeQuietly(socket: WebSocket, code = 1000, reason = "done"): void {
  try {
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close(code, reason);
    }
  } catch {
    // Best-effort close only.
  }
}

function rejectUpgrade(
  socket: import("node:stream").Duplex,
  status: number,
  message: string,
): void {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

function isRealtimePath(pathname: string): boolean {
  return (
    pathname === "/api/openai/realtime" ||
    pathname.endsWith("/api/openai/realtime")
  );
}

function readTicket(request: IncomingMessage): SessionTicket | undefined {
  const url = new URL(request.url ?? "/", "http://realtime.local");
  const token = url.searchParams.get("ticket")?.trim() ?? "";
  if (!token || !isRealtimePath(url.pathname)) return undefined;
  const ticket = tickets.get(token);
  if (!ticket || ticket.claimed || ticket.expiresAt <= Date.now())
    return undefined;
  return ticket;
}

export function normalizeAlibabaRealtimeEvent(
  event: Record<string, unknown>,
  state: { inputTranscript: string; responseTranscript: string },
): Record<string, unknown> | null {
  const type = safeText(event.type);
  if (type === "session.created" || type === "session.updated") {
    return providerEvent("session.ready", {
      modelId: ALIBABA_REALTIME_MODEL_ID,
    });
  }
  if (type === "input_audio_buffer.speech_started") {
    return providerEvent("input.started", {});
  }
  if (type === "input_audio_buffer.speech_stopped") {
    return providerEvent("input.stopped", {});
  }
  if (type === "response.created") return providerEvent("response.started", {});
  if (
    type === "response.audio_transcript.delta" ||
    type === "response.text.delta" ||
    type === "response.output_text.delta"
  ) {
    const delta = providerText(event);
    if (!delta) return null;
    state.responseTranscript += delta;
    return providerEvent("response.transcript.delta", { delta });
  }
  if (
    type === "conversation.item.input_audio_transcription.completed" ||
    type === "input_audio_buffer.transcription.completed"
  ) {
    const transcript = providerText(event).trim();
    if (!transcript) return null;
    state.inputTranscript = transcript;
    return providerEvent("input.transcript.final", { transcript });
  }
  if (
    type === "conversation.item.input_audio_transcription.delta" ||
    type === "input_audio_buffer.transcription.delta"
  ) {
    const delta = providerText(event);
    if (delta) state.inputTranscript += delta;
    return null;
  }
  if (type === "response.audio.delta") {
    const delta = safeText(event.delta);
    if (!delta) return null;
    return providerEvent("response.audio.delta", { audio: delta });
  }
  if (type === "response.done") {
    return providerEvent("response.done", {
      transcript: state.inputTranscript,
      responseTranscript: state.responseTranscript,
    });
  }
  if (type === "session.finished") return providerEvent("session.finished", {});
  if (type === "error") {
    const errorValue =
      event.error && typeof event.error === "object"
        ? (event.error as Record<string, unknown>)
        : {};
    return providerEvent("error", {
      message: safeText(errorValue.message) || "Realtime provider error",
      retryable: true,
    });
  }
  return null;
}

export function attachAlibabaRealtimeWebSocket(
  server: HttpServer,
  env: NodeJS.ProcessEnv = process.env,
): { close: () => Promise<void> } {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
  });
  server.on("upgrade", (request, socket, head) => {
    const requestPath = new URL(request.url ?? "/", "http://realtime.local")
      .pathname;
    if (!isRealtimePath(requestPath)) return;
    const ticket = readTicket(request);
    if (!ticket) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    if (activeUsers.has(ticket.userId)) {
      tickets.delete(ticket.token);
      rejectUpgrade(socket, 409, "Conflict");
      return;
    }
    ticket.claimed = true;
    tickets.delete(ticket.token);
    activeUsers.add(ticket.userId);
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit("connection", client, request, ticket);
    });
  });

  wss.on(
    "connection",
    (client: WebSocket, _request: IncomingMessage, ticket: SessionTicket) => {
      let provider: WebSocket | null = null;
      let settled = false;
      let finishSent = false;
      let audioBytes = 0;
      let lastActivity = Date.now();
      const state = { inputTranscript: "", responseTranscript: "" };
      const sessionController = new AbortController();
      const providerUrl = resolveAlibabaRealtimeWebSocketUrl(env);
      const specialist = getAlibabaSpecialistConfig(env);
      const sessionTimer = setTimeout(() => {
        sendJson(client, {
          type: "error",
          message: "音声セッションは5分で終了します。",
          retryable: true,
        });
        finishSession();
      }, MAX_SESSION_MS);
      const idleTimer = setInterval(() => {
        if (Date.now() - lastActivity > SESSION_IDLE_TIMEOUT_MS) {
          sendJson(client, {
            type: "error",
            message: "音声入力がタイムアウトしました。",
            retryable: true,
          });
          finishSession();
        }
      }, 5_000);
      const connectTimer = setTimeout(() => {
        if (!provider || provider.readyState !== WebSocket.OPEN) {
          sendJson(client, {
            type: "error",
            message: "音声サービスへの接続がタイムアウトしました。",
            retryable: true,
          });
          finishSession();
        }
      }, PROVIDER_CONNECT_TIMEOUT_MS);

      function cleanup(): void {
        if (settled) return;
        settled = true;
        clearTimeout(sessionTimer);
        clearInterval(idleTimer);
        clearTimeout(connectTimer);
        sessionController.abort();
        activeUsers.delete(ticket.userId);
        closeQuietly(provider ?? client);
        closeQuietly(client);
      }

      function finishSession(): void {
        if (settled) return;
        if (provider?.readyState === WebSocket.OPEN && !finishSent) {
          finishSent = true;
          provider.send(
            JSON.stringify({
              event_id: randomUUID(),
              type: "session.finish",
            }),
          );
          setTimeout(() => cleanup(), 2_000);
          return;
        }
        cleanup();
      }

      function providerSend(payload: Record<string, unknown>): void {
        if (provider?.readyState !== WebSocket.OPEN) {
          throw new AlibabaRealtimeError("Realtime provider is not connected");
        }
        provider.send(JSON.stringify(payload));
        lastActivity = Date.now();
      }

      if (!specialist) {
        sendJson(client, {
          type: "error",
          message: "リアルタイム音声の資格情報が設定されていません。",
          retryable: false,
        });
        cleanup();
        return;
      }

      try {
        provider = new WebSocket(providerUrl, {
          headers: {
            Authorization: `Bearer ${specialist.apiKey}`,
            "user-agent": "Chat-Space/Alibaba-Realtime",
            ...(specialist.workspaceId
              ? { "X-DashScope-WorkSpace": specialist.workspaceId }
              : {}),
          },
        });
      } catch (error) {
        logger.warn(
          safeFailureFields(
            error,
            "alibaba-realtime",
            "REALTIME_WEBSOCKET_CREATE_FAILED",
          ),
          "Failed to create Alibaba realtime WebSocket",
        );
        sendJson(client, {
          type: "error",
          message: "音声サービスへ接続できませんでした。",
          retryable: true,
        });
        cleanup();
        return;
      }

      provider.on("open", () => {
        clearTimeout(connectTimer);
        try {
          providerSend({
            event_id: randomUUID(),
            type: "session.update",
            session: {
              modalities: ["text", "audio"],
              input_audio_format: "pcm",
              output_audio_format: "pcm",
              turn_detection: null,
            },
          });
          sendJson(client, {
            type: "session.ready",
            modelId: ALIBABA_REALTIME_MODEL_ID,
          });
        } catch {
          sendJson(client, {
            type: "error",
            message: "音声セッションを準備できませんでした。",
            retryable: true,
          });
          finishSession();
        }
      });

      provider.on("message", (data: RawData) => {
        if (settled) return;
        lastActivity = Date.now();
        let event: unknown;
        try {
          event = JSON.parse(data.toString());
        } catch {
          sendJson(client, {
            type: "error",
            message: "音声サービスの応答が不正です。",
            retryable: true,
          });
          finishSession();
          return;
        }
        if (!event || typeof event !== "object") return;
        const mapped = normalizeAlibabaRealtimeEvent(
          event as Record<string, unknown>,
          state,
        );
        if (mapped) sendJson(client, mapped);
        if ((event as Record<string, unknown>).type === "session.finished")
          cleanup();
      });

      provider.on("error", (error) => {
        logger.warn(
          safeFailureFields(
            error,
            "alibaba-realtime",
            "REALTIME_PROVIDER_SOCKET_ERROR",
          ),
          "Alibaba realtime provider socket error",
        );
        sendJson(client, {
          type: "error",
          message: "音声サービスとの接続に問題が発生しました。",
          retryable: true,
        });
        finishSession();
      });
      provider.on("close", () => {
        if (!settled) {
          sendJson(client, {
            type: "error",
            message: "音声サービスとの接続が切断されました。",
            retryable: true,
          });
          finishSession();
        }
      });

      client.on("message", (data) => {
        if (settled) return;
        lastActivity = Date.now();
        try {
          const message = parseClientMessage(data);
          if (message.type === "audio.append") {
            const decodedBytes = Math.floor((message.audio.length * 3) / 4);
            audioBytes += decodedBytes;
            if (audioBytes > MAX_AUDIO_BYTES) {
              throw new AlibabaRealtimeError(
                "Session audio exceeds size limit",
                "この音声セッションは長すぎます。",
                false,
              );
            }
            providerSend({
              event_id: randomUUID(),
              type: "input_audio_buffer.append",
              audio: message.audio,
            });
            sendJson(client, { type: "input.received", bytes: decodedBytes });
          } else if (message.type === "audio.commit") {
            sendJson(client, { type: "input.stopped" });
            providerSend({
              event_id: randomUUID(),
              type: "input_audio_buffer.commit",
            });
            providerSend({ event_id: randomUUID(), type: "response.create" });
          } else {
            try {
              providerSend({ event_id: randomUUID(), type: "response.cancel" });
            } catch {
              // The provider may already be closed while cancelling.
            }
            finishSession();
          }
        } catch (error) {
          const realtimeError =
            error instanceof AlibabaRealtimeError
              ? error
              : new AlibabaRealtimeError(String(error));
          sendJson(client, {
            type: "error",
            message: realtimeError.publicMessage,
            retryable: realtimeError.retryable,
          });
          if (!realtimeError.retryable) finishSession();
        }
      });
      client.on("close", cleanup);
      client.on("error", cleanup);
      sendJson(client, {
        type: "connecting",
        modelId: ALIBABA_REALTIME_MODEL_ID,
      });
    },
  );

  return {
    close: async () => {
      for (const ticket of tickets.values()) tickets.delete(ticket.token);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

export const ALIBABA_REALTIME_LIMITS = {
  maxSessionSeconds: MAX_SESSION_MS / 1000,
  maxAudioChunkBytes: MAX_AUDIO_CHUNK_BYTES,
  maxAudioBytes: MAX_AUDIO_BYTES,
  maxClientMessageBytes: MAX_CLIENT_MESSAGE_BYTES,
  sessionTtlMs: SESSION_TTL_MS,
  maxSessionsPerUser: MAX_SESSIONS_PER_USER,
} as const;
