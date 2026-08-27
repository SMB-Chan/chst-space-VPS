---
name: GitHub API write rate limit
description: Replit GitHub connector git-data writes can hit a per-second request limit during multi-file reconciles.
---

For multi-file GitHub reconciles, create blobs sequentially with a deliberate delay between requests instead of using Promise.all.

**Why:** The connector enforces a low per-Repl request rate; parallel blob creation can fail partway through the operation. Partial blobs are harmless, but tree and ref updates must not run until every blob exists.

**How to apply:** Re-check the target ref SHA immediately before creating the tree, throttle blob creation, and update the ref with force disabled so a concurrent branch move fails safely.