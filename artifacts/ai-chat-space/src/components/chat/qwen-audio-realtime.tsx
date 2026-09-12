import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, Mic, RotateCcw, Square } from "lucide-react";
import { cn } from "@/lib/utils";

export type QwenRealtimeState =
  | "idle"
  | "connecting"
  | "listening"
  | "generating"
  | "playing"
  | "stopping"
  | "reconnecting"
  | "error";

export interface QwenAudioRealtimeProps {
  conversationId: number | null;
  selectedModel: string;
  disabled?: boolean;
  onTranscript: (transcript: string) => void;
}

const INPUT_AUDIO_RATE = 16_000;
const OUTPUT_AUDIO_RATE = 24_000;
const MAX_RECONNECT_ATTEMPTS = 3;
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type RealtimeMessage = {
  type?: string;
  delta?: unknown;
  audio?: unknown;
  text?: unknown;
  transcript?: unknown;
  message?: unknown;
  error?: unknown;
};

type WebkitWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

function websocketUrl(ticket: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${BASE}/api/openai/realtime?ticket=${encodeURIComponent(ticket)}`;
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function downsampleToPcm16(
  input: Float32Array,
  sampleRate: number,
): Uint8Array {
  const outputLength = Math.max(
    1,
    Math.round((input.length * INPUT_AUDIO_RATE) / sampleRate),
  );
  const output = new Uint8Array(outputLength * 2);
  const ratio = sampleRate / INPUT_AUDIO_RATE;

  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(
      input.length,
      Math.max(start + 1, Math.floor((index + 1) * ratio)),
    );
    let sum = 0;
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) {
      sum += input[sourceIndex];
    }
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    const pcm = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    const value = Math.round(pcm);
    output[index * 2] = value & 0xff;
    output[index * 2 + 1] = (value >> 8) & 0xff;
  }

  return output;
}

function decodePcm16(
  encoded: string,
  context: AudioContext,
): AudioBuffer | null {
  try {
    const binary = atob(encoded);
    const buffer = context.createBuffer(
      1,
      Math.floor(binary.length / 2),
      OUTPUT_AUDIO_RATE,
    );
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < channel.length; index += 1) {
      const offset = index * 2;
      let value =
        binary.charCodeAt(offset) | (binary.charCodeAt(offset + 1) << 8);
      if (value & 0x8000) value -= 0x10000;
      channel[index] = value / 0x8000;
    }
    return buffer;
  } catch {
    return null;
  }
}

function stateLabel(state: QwenRealtimeState, hasSession: boolean): string {
  if (state === "connecting") return "音声に接続中";
  if (state === "reconnecting") return "音声を再接続中";
  if (state === "listening") return "聞き取り中";
  if (state === "generating") return "音声の回答を準備中";
  if (state === "playing") return "回答を再生中";
  if (state === "stopping") return "停止中";
  if (state === "error") return "音声に接続できません";
  return hasSession ? "押している間だけ話せます" : "音声入力";
}

/**
 * Small presentational client for the Qwen Audio Realtime session.
 * Audio capture is deliberately gated by the hold gesture; no microphone
 * samples are sent while the talk control is not pressed.
 */
export function QwenAudioRealtime({
  conversationId,
  selectedModel,
  disabled = false,
  onTranscript,
}: QwenAudioRealtimeProps) {
  const [state, setState] = useState<QwenRealtimeState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hasSession, setHasSession] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const connectSocketRef = useRef<((ticket: string) => void) | null>(null);
  const scheduleReconnectRef = useRef<(() => void) | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const inputSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const processorSinkRef = useRef<GainNode | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const stopTimerRef = useRef<number | null>(null);
  const playbackEndRef = useRef(0);
  const responseDoneRef = useRef(false);
  const transcriptRef = useRef("");
  const inputTranscriptRef = useRef("");
  const transcriptSentRef = useRef(false);
  const capturingRef = useRef(false);
  const activeRef = useRef(false);
  const intentionalCloseRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const sessionTicketRef = useRef<string | null>(null);
  const playbackSourcesRef = useRef(new Set<AudioBufferSourceNode>());
  const pointerIdRef = useRef<number | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const stopCapture = useCallback(() => {
    capturingRef.current = false;
    processorRef.current?.disconnect();
    processorSinkRef.current?.disconnect();
    inputSourceRef.current?.disconnect();
    processorRef.current = null;
    processorSinkRef.current = null;
    inputSourceRef.current = null;
  }, []);

  const stopMicrophone = useCallback(() => {
    stopCapture();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, [stopCapture]);

  const clearTimers = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
  }, []);

  const finishTranscript = useCallback((fallback?: string) => {
    const transcript = (transcriptRef.current || fallback || "").trim();
    if (transcript && !transcriptSentRef.current) {
      transcriptSentRef.current = true;
      onTranscriptRef.current(transcript);
    }
    transcriptRef.current = "";
  }, []);

  const playAudio = useCallback((encoded: string) => {
    const context = contextRef.current;
    if (!context) return;
    const audioBuffer = decodePcm16(encoded, context);
    if (!audioBuffer) return;

    void context.resume();
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    playbackSourcesRef.current.add(source);
    const startAt = Math.max(context.currentTime, playbackEndRef.current);
    playbackEndRef.current = startAt + audioBuffer.duration;
    setState("playing");
    source.onended = () => {
      playbackSourcesRef.current.delete(source);
      if (
        responseDoneRef.current &&
        !capturingRef.current &&
        context.currentTime >= playbackEndRef.current - 0.03
      ) {
        setState("idle");
      }
    };
    source.start(startAt);
  }, []);

  const stopPlayback = useCallback(() => {
    for (const source of playbackSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // A source may have ended between iteration and stop.
      }
    }
    playbackSourcesRef.current.clear();
    playbackEndRef.current = 0;
  }, []);

  const prepareMicrophone = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("このブラウザではマイク入力を利用できません。");
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    const AudioContextConstructor =
      window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
    if (!AudioContextConstructor) {
      stopMicrophone();
      throw new Error("このブラウザでは音声処理を利用できません。");
    }
    const context = contextRef.current ?? new AudioContextConstructor();
    contextRef.current = context;
    await context.resume();
  }, [stopMicrophone]);

  const requestSessionTicket = useCallback(async (): Promise<string> => {
    const response = await fetch(`${BASE}/api/openai/realtime/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        ...(conversationId && conversationId > 0 ? { conversationId } : {}),
        modelId: selectedModel,
      }),
    });
    if (!response.ok) {
      let message = "音声セッションを開始できませんでした。";
      try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body.error === "string") message = body.error;
      } catch {
        // Keep the safe generic message for non-JSON proxy errors.
      }
      throw new Error(message);
    }
    const body = (await response.json()) as { token?: unknown };
    if (typeof body.token !== "string" || body.token.length < 20) {
      throw new Error("音声セッションの認証情報を取得できませんでした。");
    }
    return body.token;
  }, [conversationId, selectedModel]);

  const scheduleReconnect = useCallback(() => {
    if (!activeRef.current) return;
    reconnectTimerRef.current = window.setTimeout(
      () => {
        reconnectTimerRef.current = null;
        void requestSessionTicket()
          .then((nextTicket) => {
            sessionTicketRef.current = nextTicket;
            connectSocketRef.current?.(nextTicket);
          })
          .catch((cause) => {
            if (!activeRef.current) return;
            if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
              activeRef.current = false;
              stopMicrophone();
              setHasSession(false);
              setError(
                cause instanceof Error
                  ? cause.message
                  : "音声接続を再開できませんでした。",
              );
              setState("error");
              return;
            }
            reconnectAttemptRef.current += 1;
            scheduleReconnectRef.current?.();
          });
      },
      650 * Math.max(1, reconnectAttemptRef.current),
    );
  }, [requestSessionTicket, stopMicrophone]);
  scheduleReconnectRef.current = scheduleReconnect;

  const connectSocket = useCallback(
    (ticket: string) => {
      if (!activeRef.current) return;
      const socket = new WebSocket(websocketUrl(ticket));
      socketRef.current = socket;

      socket.onopen = () => {
        reconnectAttemptRef.current = 0;
      };

      socket.onmessage = (event) => {
        let message: RealtimeMessage;
        try {
          message = JSON.parse(String(event.data)) as RealtimeMessage;
        } catch {
          return;
        }

        switch (message.type) {
          case "session.ready":
            setState("idle");
            setHasSession(true);
            break;
          case "input.started":
            setState("listening");
            break;
          case "input.stopped":
            setState("generating");
            break;
          case "response.started":
            setState("generating");
            break;
          case "response.transcript.delta": {
            break;
          }
          case "input.transcript.final": {
            const transcript = stringValue(message.transcript, message.text);
            if (transcript) {
              inputTranscriptRef.current = transcript;
              transcriptRef.current = transcript;
            }
            break;
          }
          case "response.audio.delta": {
            const audio = stringValue(message.delta, message.audio);
            if (audio) playAudio(audio);
            break;
          }
          case "response.done": {
            responseDoneRef.current = true;
            const finalText =
              stringValue(message.transcript, message.text) ||
              inputTranscriptRef.current;
            finishTranscript(finalText ?? undefined);
            if (
              !playbackEndRef.current ||
              !contextRef.current ||
              contextRef.current.currentTime >= playbackEndRef.current - 0.03
            ) {
              setState("idle");
            }
            break;
          }
          case "session.finished":
            responseDoneRef.current = true;
            finishTranscript(
              stringValue(message.transcript, message.text) ?? undefined,
            );
            activeRef.current = false;
            intentionalCloseRef.current = true;
            socket.close();
            socketRef.current = null;
            stopMicrophone();
            setHasSession(false);
            setState("idle");
            break;
          case "error": {
            const serverError =
              stringValue(message.error, message.message) ??
              "音声セッションでエラーが発生しました。";
            activeRef.current = false;
            intentionalCloseRef.current = true;
            socket.close();
            socketRef.current = null;
            stopMicrophone();
            setError(serverError);
            setState("error");
            break;
          }
          default:
            break;
        }
      };

      socket.onerror = () => {
        if (activeRef.current) setState("reconnecting");
      };

      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (intentionalCloseRef.current || !activeRef.current) return;
        if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
          activeRef.current = false;
          stopMicrophone();
          setHasSession(false);
          setError("音声接続を再開できませんでした。もう一度お試しください。");
          setState("error");
          return;
        }
        reconnectAttemptRef.current += 1;
        setState("reconnecting");
        scheduleReconnectRef.current?.();
      };
    },
    [finishTranscript, playAudio, stopMicrophone],
  );
  connectSocketRef.current = connectSocket;

  const start = useCallback(async () => {
    if (
      disabled ||
      !selectedModel ||
      activeRef.current ||
      state === "connecting" ||
      state === "reconnecting"
    )
      return;
    clearTimers();
    setError(null);
    setState("connecting");
    setHasSession(true);
    activeRef.current = true;
    intentionalCloseRef.current = false;
    reconnectAttemptRef.current = 0;
    responseDoneRef.current = false;
    transcriptRef.current = "";
    inputTranscriptRef.current = "";
    transcriptSentRef.current = false;

    try {
      await prepareMicrophone();
      if (!activeRef.current) {
        stopMicrophone();
        return;
      }
      const ticket = await requestSessionTicket();
      sessionTicketRef.current = ticket;
      connectSocket(ticket);
    } catch (cause) {
      activeRef.current = false;
      setHasSession(false);
      const message =
        cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "マイクの使用が許可されませんでした。ブラウザのサイト設定を確認してください。"
          : cause instanceof Error
            ? cause.message
            : "マイクを開始できませんでした。";
      setError(message);
      setState("error");
      stopMicrophone();
    }
  }, [
    clearTimers,
    connectSocket,
    disabled,
    prepareMicrophone,
    requestSessionTicket,
    selectedModel,
    state,
    stopMicrophone,
  ]);

  const endCapture = useCallback(() => {
    if (!capturingRef.current) return;
    stopCapture();
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "audio.commit" }));
      setState("generating");
    }
  }, [stopCapture]);

  const beginCapture = useCallback(() => {
    const socket = socketRef.current;
    const context = contextRef.current;
    const stream = streamRef.current;
    if (
      !activeRef.current ||
      state !== "idle" ||
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      !context ||
      !stream
    ) {
      return;
    }

    transcriptRef.current = "";
    transcriptSentRef.current = false;
    responseDoneRef.current = false;
    capturingRef.current = true;
    playbackEndRef.current = 0;
    setState("listening");

    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const sink = context.createGain();
    sink.gain.value = 0;
    source.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);
    processor.onaudioprocess = (event) => {
      if (!capturingRef.current || socket.readyState !== WebSocket.OPEN) return;
      const channel = event.inputBuffer.getChannelData(0);
      const pcm = downsampleToPcm16(channel, event.inputBuffer.sampleRate);
      socket.send(
        JSON.stringify({ type: "audio.append", audio: toBase64(pcm) }),
      );
    };
    inputSourceRef.current = source;
    processorRef.current = processor;
    processorSinkRef.current = sink;
  }, [state]);

  const cancel = useCallback(() => {
    if (!activeRef.current && state !== "error") return;
    setState("stopping");
    activeRef.current = false;
    intentionalCloseRef.current = true;
    clearTimers();
    stopCapture();
    stopPlayback();
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "session.cancel" }));
    }
    socket?.close();
    socketRef.current = null;
    sessionTicketRef.current = null;
    stopMicrophone();
    stopTimerRef.current = window.setTimeout(() => {
      stopTimerRef.current = null;
      setHasSession(false);
      setError(null);
      setState("idle");
    }, 180);
  }, [clearTimers, state, stopCapture, stopMicrophone, stopPlayback]);

  useEffect(() => {
    if (disabled && activeRef.current) cancel();
  }, [cancel, disabled]);

  useEffect(() => {
    return () => {
      clearTimers();
      activeRef.current = false;
      intentionalCloseRef.current = true;
      stopCapture();
      socketRef.current?.close();
      socketRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (contextRef.current) {
        stopPlayback();
        void contextRef.current.close();
        contextRef.current = null;
      }
    };
  }, [clearTimers, stopCapture, stopPlayback]);

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled || state !== "idle" || !hasSession) return;
    event.preventDefault();
    pointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    beginCapture();
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    pointerIdRef.current = null;
    endCapture();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key !== " " && event.key !== "Enter") || event.repeat) return;
    event.preventDefault();
    if (disabled || state !== "idle" || !hasSession) return;
    beginCapture();
  };

  const handleKeyUp = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    endCapture();
  };

  const isActive = hasSession && state !== "error";
  const label = stateLabel(state, hasSession);

  return (
    <div
      className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5"
      aria-label="Qwen Audio Realtime"
    >
      <span
        className={cn(
          "max-w-[9rem] truncate text-[11px] text-muted-foreground",
          state === "idle" && !hasSession && "sr-only sm:not-sr-only",
        )}
        role="status"
        aria-live="polite"
      >
        {label}
      </span>
      {error ? (
        <div
          className="flex min-w-0 max-w-full items-center gap-1.5 text-[11px] text-destructive"
          role="alert"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate" title={error}>
            {error}
          </span>
        </div>
      ) : null}

      {!isActive ? (
        <button
          type="button"
          onClick={() => void start()}
          disabled={
            disabled ||
            !selectedModel ||
            state === "connecting" ||
            state === "reconnecting"
          }
          className={cn(
            "m3-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-[var(--m3-shape-full)] border px-3 text-xs font-medium transition-colors",
            "[border-color:color-mix(in_oklab,var(--app-status-info)_30%,transparent)] [background:color-mix(in_oklab,var(--app-status-info)_8%,transparent)] [color:var(--app-status-info)] hover:[background:color-mix(in_oklab,var(--app-status-info)_14%,transparent)]",
            "disabled:pointer-events-none disabled:opacity-50",
          )}
          aria-label={state === "error" ? "音声接続を再試行" : "音声入力を開始"}
        >
          {state === "connecting" || state === "reconnecting" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : state === "error" ? (
            <RotateCcw className="h-3.5 w-3.5" />
          ) : (
            <Mic className="h-3.5 w-3.5" />
          )}
          {state === "error" ? "再試行" : "音声"}
        </button>
      ) : (
        <>
          <button
            type="button"
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onBlur={() => {
              pointerIdRef.current = null;
              endCapture();
            }}
            disabled={disabled || state !== "idle"}
            className={cn(
              "m3-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-[var(--m3-shape-full)] border px-3 text-xs font-medium transition-colors select-none touch-none",
              state === "listening"
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "[border-color:color-mix(in_oklab,var(--app-status-info)_30%,transparent)] [background:color-mix(in_oklab,var(--app-status-info)_8%,transparent)] [color:var(--app-status-info)] hover:[background:color-mix(in_oklab,var(--app-status-info)_14%,transparent)]",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
            aria-label="押している間だけ話す"
            aria-pressed={state === "listening"}
          >
            <Mic
              className={cn(
                "h-3.5 w-3.5",
                state === "listening" && "animate-pulse",
              )}
            />
            {state === "listening" ? "話しています" : "押して話す"}
          </button>
          <button
            type="button"
            onClick={cancel}
            disabled={state === "stopping"}
            className="m3-focus-ring inline-flex h-11 w-11 items-center justify-center rounded-[var(--m3-shape-full)] border border-border text-muted-foreground transition-colors hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
            aria-label="音声入力を停止"
            title={label}
          >
            {state === "stopping" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Square className="h-3 w-3 fill-current" />
            )}
          </button>
        </>
      )}
    </div>
  );
}
