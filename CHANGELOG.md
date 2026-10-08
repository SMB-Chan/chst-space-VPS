# Changelog

All notable changes to Chat-Space will be documented in this file. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Coding workspace (`/api/files*`, `/api/dev/access-mode`, project folders,
  coding-mode writes) is admin-only; general users can no longer read, write
  or delete the shared VPS workspace or switch OpenCode to `full`.
- Workspace and coding-mode paths are checked after resolving symlinks, and
  the coding tree/search walkers no longer follow symlinks out of a project.
- Deleting a project no longer removes a workspace folder that another
  project (possibly another user's) still maps to.
- BYOK provider base URLs: private/loopback/link-local targets are admin-only
  (save, key test without redirects, and every chat request) to close an SSRF.
- Google connect: OAuth `state` is HMAC-signed, expires after 10 minutes and
  is bound to the starting browser by an HttpOnly cookie (multi-user modes).
- Conversations and tool-bank copies can only be linked to the caller's own
  projects.
- Sign-out clears the pending mobile message and the cached role.

### Fixed

- Stale tests after the c6a8351 catalog change (`o4-mini` removed,
  `deepseek/deepseek-v4-pro` added) and the tool-bank store test (TDZ and a
  nonexistent column); the BYOK `/openai/providers` routes are now in the
  OpenAPI spec, so `check:api-routes` passes again.
- `deploy.sh` no longer aborts at the schema step: `drizzle-kit migrate`
  only runs when `lib/db/drizzle/meta/_journal.json` exists (there are no
  authored migrations yet); otherwise the app's boot-time ensure-schema
  applies the schema.
- `deploy.sh` refuses to start postgres on a volume that does not exist
  (`ALLOW_NEW_DB_VOLUME=1` for a first install), and host-specific compose
  settings live in the gitignored `deploy/compose.override.yaml`.
- `deploy.sh` health probe now actually warns when `/api/healthz` never
  answers, and prints rollback commands with the right service names.
- OpenCode entrypoint: an unknown access mode now falls back to `ask` (it
  said `ask` but used `auto`); the compose default is `ask` as documented.

## [1.0.0] - 2026-09-19

The first stable release of Chat-Space on top of the OpenCode / mobile Chat/Work
foundation. This release ships the autonomous coding loop, the tool-bank, a
deploy-hardened VPS pipeline, and a full Apple HIG UI rollout.

### Highlights

- **Autonomous coding** — `runCodingLoop()` with `ScriptedStream` test
  double, per-turn file-write ceiling, xiaomi `reasoning_content`
  attachment, and `clientGone` short-circuit. Tool bank CRUD with
  policy-guarded copy / soft-delete / purge.
- **Apple HIG UI** — design-system primitives (`EmptyState`, `ErrorState`,
  `ScreenHeader`), 44pt tap targets throughout, reduced-motion CSS,
  verb-first buttons, AlertDialog instead of `window.confirm()`.
- **VPS deploy pipeline** — hardened `deploy.sh` (refuses uncommitted
  changes, timestamps images, runs migrations via `drizzle-kit
  migrate`, probes healthz), pinned Node / pnpm / opencode-ai
  versions, `OPENCODE_ACCESS_MODE=ask` default, basic-auth required
  for the OpenCode web UI.

### Added

#### Tests (vitest)
- `artifacts/api-server/src/lib/chat-stream-coding.test.ts` — six tests
  for the autonomous coding loop (touch accumulation, AbortSignal,
  clientGone, per-turn ceiling, CODING_MAX_TOOL_CALLS bailout +
  final-answer fallback, xiaomi reasoning_content).
- `artifacts/api-server/src/lib/tool-bank-policy.test.ts` — pins the
  lifecycle ceilings (40 000 code chars, 2 000 summary chars,
  90-day archive, 30-day purge).
- `artifacts/api-server/src/lib/tool-bank-store.pg.test.ts` —
  PostgreSQL integration test (CRUD → version bump → copy →
  soft-delete → purge), wired into the `production-boot` CI job.
- Apple HIG design-system unit tests (12 tests across
  `EmptyState`, `ErrorState`, `ScreenHeader`, `Button`).
- `message-feed.test.tsx`, `screen-header.test.tsx`,
  `file-browser.test.tsx` — empty/landmark surface contracts.
- `button-tap-target.test.ts` — regression test pinning Apple HIG
  §4.4 (≥ 44×44pt tap target on `default` and `icon` variants).

#### Design system
- `artifacts/ai-chat-space/src/design-system/components/empty-state.tsx`
- `artifacts/ai-chat-space/src/design-system/components/error-state.tsx`
- `artifacts/ai-chat-space/src/design-system/components/screen-header.tsx`
- Barrel export `artifacts/ai-chat-space/src/design-system/components/index.ts`
- `artifacts/ai-chat-space/src/hooks/use-mobile.tsx` — jsdom-safe
  (`window.matchMedia` shim guard).

#### Deploy
- `deploy/deploy.sh` — hardened bootstrapper. Refuses uncommitted
  changes, builds images with a timestamp tag (`chat-space:app-YYYYMMDDTHHMMSSZ`)
  + `:latest`, `chown 1000:1000` the bind-mounted `code-workspace`,
  defaults `code-access-mode` to `ask`, runs schema migrations
  through `drizzle-kit migrate`, probes `/api/healthz`. Override
  `ALLOW_DESTRUCTIVE_PUSH=1` for greenfield bootstraps.
- `deploy/code/Dockerfile` — pinned `node:22.20.0-bookworm-slim`,
  `pnpm@10.34.5` (matching CI), `opencode-ai@1.18.31`. Dropped unused
  `python3-pip` / `build-essential`.
- `deploy/code/entrypoint.sh` — `OPENCODE_ACCESS_MODE` default `ask`,
  fallback log message matches.
- `deploy/.env.example` — documents `OPENCODE_ACCESS_MODE=ask`,
  `OPENCODE_SERVER_USERNAME/PASSWORD` (both required past 127.0.0.1),
  `REDIS_URL`, `SMTP_*`, `APP_HOST`, etc.
- `drop/`-stage bundle / patch workflow (gitignored).

#### Database
- `lib/db/package.json` exposes `generate` and `migrate` scripts
  alongside `push` / `push-force`, so the deploy.sh `migrate` call
  no longer fails with "None of the selected packages has a 'migrate'
  script".

#### UI empty branches
- `EmptyState` is wired into the empty branches of:
  - `project-panel.tsx` — projects list
  - `components/chat/message-feed.tsx` — empty conversation
  - `components/files/file-browser.tsx` — empty folder
  - `components/settings/project-memory-section.tsx` — no projects
  - `components/settings/tool-bank-section.tsx` — empty bank

#### Headers / screens
- `ScreenHeader` is wired into the top-of-page header of:
  - `pages/settings.tsx`
  - `pages/admin.tsx` (with the refresh button in the `actions` slot)
- `ErrorState` is wired into the non-admin branch of `pages/admin.tsx`.

### Changed

- `pages/not-found.tsx` — uses `ErrorState`, drops imperative
  command-style copy, primary action `ホームへ戻る` is verb-first.
- `components/error-boundary.tsx` — verb-first "もう一度試す" + a
  secondary "ホームへ戻る" action.
- `pages/home.tsx` — privacy chip was rewritten from the vague
  "会話データを安全に保存" (an exact example of the empty-privacy
  rationale Apple HIG forbids) to the concrete
  "自分の会話のみ、本人のみがアクセス可能".
- `components/chat/message-input.tsx` — video-generation confirmation
  uses an `AlertDialog` instead of `window.confirm()`. Wired through a
  one-shot `videoConfirmedRef`.
- `components/ui/button.tsx` — default size `h-10` (40px) → `h-11`
  (44px) for the Apple HIG §4.4 minimum tap target. Icon variant
  likewise.
- `index.css` — reduced-motion CSS broadened to neutralise
  `tailwindcss-animate` `.animate-in` / `.fade-in` /
  `.slide-in-from-bottom-2` and decorative `transition-property`
  whenever `prefers-reduced-motion: reduce` is set.
- `.github/workflows/ci.yml` — `production-boot` job now runs
  `tool-bank-store.pg.test.ts` against the existing postgres:17 service.
- `.gitignore` — `/drop` (local bundle / patch staging directory) is
  gitignored.

### Security

- Disables the most dangerous default of the OpenCode coding agent.
  The prior `auto` mode allowed arbitrary file writes / bash under
  the bind-mounted `code-workspace`; the new `ask` default requires
  per-action approval.

### Removed

- Unused build dependencies from `deploy/code/Dockerfile`
  (`python3-pip`, `build-essential`).

### Verification

- `pnpm --filter @workspace/ai-chat-space test` — **156/156 passing**
  (Apple HIG roll-out, message-feed, file-browser, screen-header,
  design-system primitives, Button 44px regression, message-input,
  chat-stream-coding-style integration coverage from earlier).
- `pnpm --filter @workspace/ai-chat-space typecheck` — clean.
- `pnpm --filter @workspace/api-server typecheck` — clean.
- Live VPS smoke: `GET /api/healthz` 200×3, `GET /` 200 (1764 bytes),
  `GET /sign-in` 200, `GET /api/openai/models` 200, all 5 chat-space
  containers `Up`, security headers match CI assertions.

[1.0.0]: https://github.com/SMB-Chan/chst-space-VPS/releases/tag/v1.0.0
