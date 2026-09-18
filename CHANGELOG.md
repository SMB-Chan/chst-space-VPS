# Changelog

All notable changes to Chat-Space will be documented in this file. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
loosely while the codebase is still pre-1.0.

## [Unreleased] - 2026-09

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
