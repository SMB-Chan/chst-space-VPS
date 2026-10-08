# Chat-Space (AI Chat Space)

> **v1.0.0 (2026-09-19)** — Apple HIG UI rollout, autonomous coding
> coverage, deploy hardening. See [CHANGELOG.md](./CHANGELOG.md).
> Git tag `v1.0.0` points to this commit.

A personal AI chat space where you can attach files and ask questions about them.

Switch between multiple models (OpenAI / Qwen and more), with web search plus document and image attachments. Conversations are stored per Clerk account.

Based on: [Replit Chat-Space](https://replit.com/@ibn5100/Chat-Space)

> The chat UI itself is Japanese-first. The assistant always replies in Japanese in normal chat (translation modes support other languages).

## Features

- Model switching across OpenAI and Alibaba Cloud (DashScope), with reasoning levels
- Streaming responses (SSE)
- Web search (DuckDuckGo, no API key required) with source cards
- Image and text file attachments
- Document & audio analysis: PDF / ZIP / Word (docx) / Excel (xlsx) / PowerPoint (pptx) and audio (MP3 / WAV / M4A / OGG / FLAC / WebM) are deterministically extracted to text on the server (audio is transcribed via a configured provider) before entering the conversation. Code from files is never executed
- Attachment limits: up to 5 files, 10 MB each for images/documents/audio, 1 MB per text file, 2 MB total text, 20 MB total (SVG and legacy .doc/.xls/.ppt are not supported)
- Past images from long conversations are re-sent newest-first, up to 10 MiB and 4 images total (images in the current user message are outside this budget)
- Conversation history and per-user long-term memory stored in PostgreSQL, with bulk wipe from the settings screen
- Private sessions (nothing persisted to the server; long-term memory is neither read nor updated. PDF/Office generation is limited to normal chats)
- PWA (installable to home screen) with the default model saved per device
- Automatic "Financial Analysis" skill for finance questions (fresh data search + analysis format)
- Neutral audit mode (a second model reviews the draft, then the main model rewrites the final report)
- Translation mode (auto Japanese⇄English / Japanese⇄Korean / Japanese⇄Chinese plus fixed directions. Just send text to translate. Conversation history keeps terminology, tone, and nuance; adjustments like "make it more casual" are accepted too. Chinese uses Simplified with mainland conventions)
- Vision bridge so non-vision models (DeepSeek / GLM) can still take image attachments (a vision-capable model transcribes the images before answering and auditing)
- LLM-generated PDF / Word / Excel / PowerPoint downloads (format buttons in the composer, or natural language like "summarize as a PDF")
- Self-improvement loop where generated files are rasterized and a vision-capable LLM reviews and fixes the layout (up to 2 iterations)

## Stack

| Layer      | Technology                                              |
| ---------- | ------------------------------------------------------- |
| Frontend   | Vite, React 19, wouter, TanStack Query, Clerk, Tailwind |
| API        | Express 5                                               |
| DB         | PostgreSQL + Drizzle ORM                                |
| Validation | Zod, drizzle-zod                                        |
| Workspace  | pnpm workspaces, TypeScript 6.0                         |

## Layout

```
artifacts/ai-chat-space/   # Frontend (@workspace/ai-chat-space)
artifacts/api-server/      # API (@workspace/api-server)
lib/db/                    # Drizzle schema
lib/api-spec/              # OpenAPI → Orval source
lib/api-zod/               # Generated Zod schemas
lib/api-client-react/      # Generated React Query hooks
```

## Setup

Requires Node.js 22+, pnpm, and Postgres.

```bash
cp .env.example .env
# edit .env with your DATABASE_URL / Clerk / OpenAI keys

pnpm install
pnpm --filter @workspace/db run push   # apply the schema to Postgres (dev)
```

### Running

Use two terminals:

```bash
# API (default :5000)
pnpm --filter @workspace/api-server run dev

# Frontend (local: PORT=5173 BASE_PATH=/)
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/ai-chat-space run dev
```

Vite proxies `/api` to `API_PROXY_TARGET` (defaults to `http://127.0.0.1:5000`).

### Self-hosting on a VPS (Docker Compose)

See [deploy/README.md](./deploy/README.md) for Docker Compose self-hosting. It starts PostgreSQL, the app, SearXNG, and a coding environment (OpenCode + file browser) together.

### Other commands

```bash
pnpm run typecheck
pnpm run test
pnpm run build
pnpm --filter @workspace/api-spec run codegen   # regenerate hooks / Zod from OpenAPI
pnpm --filter @workspace/api-server run test:ssrf
pnpm run check:api-routes              # verify OpenAPI ↔ Express route contract
```

Tests use Vitest and cover `artifacts/api-server` and `artifacts/ai-chat-space`.

## Environment variables

See [`.env.example`](./.env.example) for the full list.

- `DATABASE_URL` — Postgres
- `CLERK_PUBLISHABLE_KEY` / `VITE_CLERK_PUBLISHABLE_KEY` — auth
- `FRONTEND_URL` — browser origins allowed to call the API. Comma-separated. Required for cross-origin production setups
- `AI_INTEGRATIONS_OPENAI_BASE_URL` / `AI_INTEGRATIONS_OPENAI_API_KEY` — OpenAI-compatible endpoint (omit to freeze OpenAI)
- `AI_STREAM_MAX_ATTEMPTS` / `AI_STREAM_RETRY_BASE_MS` / `AI_STREAM_RETRY_MAX_MS` — max attempts and backoff for transient stream-start failures (defaults 5 / 750ms / 6000ms. Later DashScope attempts reduce thinking and output caps. No retry after the response body has started, to avoid duplicated output)
- `Xiaomi_Mimo_KEY` / `XIAOMI_API_KEY` — Xiaomi MiMo (the former wins). `XIAOMI_BASE_URL` defaults to `https://token-plan-sgp.xiaomimimo.com/v1`. The same key also enables speech synthesis (`mimo-v2.5-tts` / `mimo-v2.5-tts-voicedesign`) and recognition (`mimo-v2.5-asr`)
- `DISABLE_OPENAI_MODELS` / `DISABLE_DASHSCOPE_MODELS` / `DISABLE_XIAOMI_MODELS` — set `true` to freeze the model list, chat, auxiliary image processing, speech recognition/synthesis, and Alibaba specialist capabilities for that provider. Restart the server after changing
- `DASHSCOPE_API_KEY` — optional, for Qwen etc.
- `ALIBABA_SPECIALIST_API_KEY` / `ALIBABA_SPECIALIST_WORKSPACE_ID` — regular Alibaba Model Studio workspace credentials (optional, for image generation/editing and Qwen Audio TTS/Realtime specialist backends. Token Plan Personal/Team keys are rejected; without them capabilities stay catalog-only)
- `ALIBABA_SPECIALIST_HTTP_BASE_URL` / `ALIBABA_SPECIALIST_TTS_WS_URL` / `ALIBABA_SPECIALIST_REALTIME_WS_URL` — allow-listed HTTPS/WSS endpoints for specialist transports (optional, see [`.env.example`](./.env.example))
- `AI_REQUESTS_PER_MINUTE` — per-user, PostgreSQL-shared AI request limit for chat, media generation, and realtime session issuance (default 20/60s, 0 disables)
- `AI_MAX_CONCURRENT_REQUESTS` — per-user concurrent AI generation limit shared across all Autoscale instances (default 2, 0 disables)
- `AI_CONCURRENCY_LEASE_TTL_MS` — expiry of the concurrency lease (default 90000ms, renewed by heartbeat while running)
- `TRANSCRIBE_MODEL` — transcription model for audio attachments (optional. Defaults to `gpt-4o-mini-transcribe`, falling back to `whisper-1`, then Qwen ASR/paraformer-v2 when DashScope is configured, then `mimo-v2.5-asr` with a Xiaomi MiMo key. MiMo accepts only wav and mp3, so other formats are converted with ffmpeg)
- Token Plan DashScope requires a dedicated endpoint, not the region-common URL

## Shared model memory

Preferences, decisions, progress, and sourced knowledge are shared across chat models. Supports correction history, invalidation and hard deletion, automatic expiry, and bounded context retrieval. An authenticated `/api/memories` API is also available for external apps. See [Shared Memory Service](./docs/shared-memory.md) for the spec and examples.

## Safety and operational notes

- Attachments travel as structured JSON separate from the message body; the server validates image data URLs, base64 canonical form, image signatures, and UTF-8 text before converting them to model input. `CS_ATTACHMENTS_V1:` exists for DB/display compatibility.
- Document/audio attachments are typed by magic bytes, not the client-declared MIME, and only text extracted by trusted parsers (or transcription for audio) is stored or passed to the model. The extraction is wrapped per message with a randomized boundary as "untrusted data" to mitigate prompt injection.
- ZIP is double-bounded by central directory inspection and measured expanded size (64 MB total / 1000 entries / 50 text extractions at 4 MB each); path traversal, absolute paths, and nested archives are excluded.
- The large JSON parser is limited to the chat send path, behind auth and the PostgreSQL-shared AI usage guard.
- The AI usage guard is per authenticated user with PostgreSQL as the shared state: a fixed request window and a time-limited concurrency lease shared across all Autoscale instances. If the DB-side usage check is unavailable, AI generation fails closed.
- Every long-term memory operation requires the authenticated user id, and rows are isolated by `user_id` in PostgreSQL. Private sessions do not expose the memory tools to the model at all. Memories passed into conversations are wrapped as "untrusted reference data" that must not be followed as instructions.
- The legacy `data/llm-memory/memories.db` has no identifiable owner, so it is never auto-migrated or read by the new implementation. Operators should decide whether to back it up and then dispose of it safely.
- Web fetching includes SSRF defenses against DNS rebinding and truncates bodies at 1 MB per page / 2 MB per search result.
- Image attachments are currently stored inline in conversation messages as data URLs for compatibility; re-sending past images to the model is capped at the most recent 10 MiB / 4 images. Consider reference-based storage if attachment storage grows.
- Generated PDF/Office binaries are stored transactionally in PostgreSQL with a default shared quota of 50 MiB per user. Retention/deletion and object-storage migration criteria are in [`docs/generated-binary-storage-policy.md`](./docs/generated-binary-storage-policy.md).

## What's new in v1.0.0

A summary of the work shipped on top of the upstream Replit fork:

### UI (Apple HIG)
- New design-system primitives: `EmptyState`, `ErrorState`, `ScreenHeader`
  under `artifacts/ai-chat-space/src/design-system/components/`.
- All empty branches in `message-feed.tsx`, `file-browser.tsx`,
  `project-panel.tsx`, `project-memory-section.tsx`,
  `tool-bank-section.tsx`, and the admin non-admin branch use
  `EmptyState` / `ErrorState` with verb-first recovery copy.
- `not-found.tsx`, `error-boundary.tsx`, `pages/settings.tsx`,
  `pages/admin.tsx` use the same primitives consistently.
- `Button` default + icon variant bumped to `h-11` (44px) to satisfy
  Apple HIG §4.4 (44×44pt minimum tap target).
- Reduced-motion CSS broadened to neutralise `tailwindcss-animate`
  and decorative `transition-property` whenever
  `prefers-reduced-motion: reduce` is set.
- `window.confirm()` (jarring, off-spec) replaced with a platform
  `AlertDialog` for the video-generation confirmation flow.

### Coding & data
- `runCodingLoop()` test double (no LLM dependency) via `chat-stream-coding.test.ts`.
- `tool-bank-store.pg.test.ts` integration test covers create → copy →
  soft-delete → purge against the existing postgres:17 service.

### VPS deploy pipeline (`deploy/deploy.sh`)
- Refuses uncommitted local changes before any deploy.
- Builds images with a timestamp tag (`chat-space:app-YYYYMMDDTHHMMSSZ`)
  + `:latest` for individual rollback.
- `chown 1000:1000` the bind-mounted `code-workspace` so writes by the
  OpenCode / filebrowser containers are owned correctly.
- Default `code-access-mode` to `ask` (verb-first per-action approval
  instead of the prior `auto` blanket grant).
- Applies schema changes without `--force`: `drizzle-kit migrate` when a
  migration journal exists, otherwise the app's boot-time ensure-schema.
  `ALLOW_DESTRUCTIVE_PUSH=1` opts into `push --force` on greenfield
  bootstraps.
- Refuses to start the database on a postgres volume that does not exist
  yet (`ALLOW_NEW_DB_VOLUME=1` for a first install); host-specific volumes
  go in the gitignored `deploy/compose.override.yaml`.
- Probes `/api/healthz` after restart; prints rollback instructions on
  failure.
- `deploy/code/Dockerfile` pins Node 22, pnpm 10, and opencode-ai
  versions to keep deploys deterministic.

### Tests
- Frontend vitest: **156/156 passing** (`pnpm --filter
  @workspace/ai-chat-space test`). The previous `matchMedia`-jsdom
  bug in `useIsMobile` was also fixed in this release.
- Typecheck clean for both apps (`pnpm --filter
  @workspace/ai-chat-space typecheck` and the same for api-server).

### Self-hosting
See [`deploy/README.md`](./deploy/README.md) for the docker compose
production layout. The hardened `deploy.sh` is the supported path:

```bash
sudo SKIP_PULL=1 bash deploy/deploy.sh
```

(`SKIP_PULL=1` is only needed if the VPS does not have read access to
the upstream Git remote. Use `sudo -E` to forward environment variables
across the sudo boundary.)

## License

MIT
