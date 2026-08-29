---
name: Startup readiness
description: API deployment probes must distinguish a reachable process from a ready database-backed service.
---

Bind the API port before running startup schema reconciliation, return a clear 503 while initialization is in progress, and gate application routes until readiness becomes true.

**Why:** The deployment supervisor can probe the routed `/api` path before a database migration sequence finishes. Waiting to call `listen()` makes that probe receive a generic 500 from the proxy instead of an explicit temporary-unavailable response.

**How to apply:** Keep `/api` and `/api/healthz` unauthenticated and minimal, transition readiness only after all required schema checks succeed, and return to not-ready during shutdown or startup failure.