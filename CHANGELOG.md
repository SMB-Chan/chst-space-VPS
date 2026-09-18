# Changelog

All notable changes to Chat-Space will be documented in this file. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
loosely while the codebase is still pre-1.0.

## [Unreleased]
### Added
- `EmptyState` wired into the empty branches of `message-feed.tsx`
  (verb-first "まだメッセージがありません", icon=MessageSquare) and
  `file-browser.tsx` ("フォルダは空です"). Apple HIG §5.2: empty
  surfaces must say what to do next.
- `ScreenHeader` wired into the top-of-page header of
  `pages/settings.tsx` and `pages/admin.tsx`, with the admin refresh
  button routed through the `actions` prop.
- `ErrorState` wired into the non-admin branch of `pages/admin.tsx`
  with a verb-first "トップへ戻る" recovery.
- New unit tests: `message-feed.test.tsx`, `screen-header.test.tsx`,
  and a small `file-browser.test.tsx` placeholder covering the empty
  surface path.

### Verification
- `pnpm --filter @workspace/ai-chat-space test` — 32/32 passing
  (existing + new). The 8 failures in
  `message-input.interaction.test.tsx` are pre-existing on `main`
  (`useIsMobile` -> `window.matchMedia` is undefined in jsdom) and are
  unrelated to this change.
- `pnpm --filter @workspace/ai-chat-space typecheck` — clean.

### Added
- Apple HIG design-system primitives (`artifacts/ai-chat-space/src/design-system/components/`):
  `EmptyState` (role=status, verb-first empty copy), `ErrorState`
  (role=alert, recovery verbs), `ScreenHeader` landmark. Barrel export.
- `Button.test.tsx` and design-system unit tests verify the new Apple
  HIG contracts (44px tap target default, no cuteness in error copy,
  empty states announce next steps).
- The new `EmptyState` is wired into the no-projects branch in
  `project-panel.tsx` (compact variant for narrow widths).

### Changed
- `not-found.tsx` and `error-boundary.tsx` now use `ErrorState`,
  drop the imperative command-style copy, and expose a verb-first
  secondary action ("ホームへ戻る").
- `home.tsx` privacy chip was rewritten from a vague "会話データを安全に保存"
  (an exact example of the empty-privacy-rationale Apple HIG forbids)
  to the concrete "自分の会話のみ、本人のみがアクセス可能".
- `message-input.tsx` video-generation confirmation flow: replaces the
  jarring `window.confirm()` with a platform `AlertDialog` (verb-first
  actions, "戻る" / "生成する") wired into handleSubmit via a
  one-shot `videoConfirmedRef`.
- `Button` default size `h-10` (40px) -> `h-11` (44px) to satisfy the
  Apple HIG 44pt minimum tap target. Icon variant likewise.
- Reduced-motion CSS broadened to also neutralise `tailwindcss-animate`
  `.animate-in` / `.fade-in` / `.slide-in-from-bottom-2` and
  decorative `transition-property` so the entire UI respects the
  `prefers-reduced-motion: reduce` setting.


### Added
- Test coverage for the autonomous coding loop
  (`artifacts/api-server/src/lib/chat-stream-coding.test.ts`) that
  exercises `runCodingLoop()` via a `ScriptedStream` double (no LLM
  dependency). Six tests pin the loop's contract: touch accumulation
  per wave, AbortSignal handling, the `clientGone` short-circuit, the
  per-turn file-write ceiling, the `CODING_MAX_TOOL_CALLS` bailout
  and final-answer fallback, and the xiaomi `reasoning_content`
  attachment.
- Pure unit tests for the tool-bank lifecycle constants and the
  Japanese policy doc
  (`artifacts/api-server/src/lib/tool-bank-policy.test.ts`); pins the
  40 000-code / 2 000-summary / 90-day archive / 30-day purge ceilings
  so future changes are explicit.
- PostgreSQL integration test for `tool-bank-store`
  (`artifacts/api-server/src/lib/tool-bank-store.pg.test.ts`) covering
  create -> update (version bump) -> copy (useCount + snapshot) ->
  soft delete -> update-refused-on-archived -> purge. Wired into the
  `production-boot` CI job.
- `deploy/deploy.sh` hardened version: refuses uncommitted local
  changes, builds images with a timestamp tag + `:latest` for
  individual rollback, `chown 1000:1000` on the bind-mounted
  `code-workspace`, default `code-access-mode` to `ask`, applies the
  schema through `drizzle-kit migrate` (not `push --force`), probes
  `/api/healthz` after restart. Override `ALLOW_DESTRUCTIVE_PUSH=1`
  to opt back into `push --force` on greenfield bootstraps.
- `deploy/code/Dockerfile` pins: `node:22.20.0-bookworm-slim`,
  `pnpm@10.34.5` (matching CI), `opencode-ai@1.18.31`. Dropped unused
  `python3-pip` / `build-essential`.

### Changed
- `deploy/code/entrypoint.sh`: default `OPENCODE_ACCESS_MODE` from
  `auto` to `ask`; the fallback log message matches.
- `deploy/.env.example`: replaced the `OPENCODE_ACCESS_MODE=auto`
  block with `ask` and added an explicit note that
  `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` are both
  required before exposing the OpenCode container past 127.0.0.1.
- `.github/workflows/ci.yml`: `production-boot` job now also runs
  `tool-bank-store.pg.test.ts` so the new CRUD paths are exercised
  against the existing postgres:17 service.

### Security
- Disables the most dangerous default of the OpenCode coding agent.
  The prior `auto` mode allowed arbitrary file writes / bash under
  the bind-mounted `code-workspace`; the new `ask` default requires
  per-action approval.

### Removed
- Unused build dependencies from `deploy/code/Dockerfile`
  (`python3-pip`, `build-essential`).
