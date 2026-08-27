---
name: GitHub API write rate limit
description: Replit GitHub connector git-data writes can hit a per-second request limit during multi-file reconciles.
---

For multi-file GitHub reconciles, create blobs sequentially with a deliberate delay between requests instead of using Promise.all.

**Why:** The connector enforces a low per-Repl request rate; parallel blob creation can fail partway through the operation. Partial blobs are harmless, but tree and ref updates must not run until every blob exists.

**How to apply:** Re-check the target ref SHA immediately before creating the tree, throttle blob creation, and update the ref with force disabled so a concurrent branch move fails safely.

The workspace's GitHub HTTPS remote can reject normal git fetch/push authentication even while the installed GitHub integration remains usable. In that case, use the integration's git-data API as the fast-forward equivalent after verifying the target ref.

**Why:** The authenticated connector and the shell git remote do not necessarily share credentials in Replit workspaces.

**How to apply:** Never force-update an unexpected ref; create the commit with the verified target SHA as its parent, update the named branch with `force: false`, and re-read the branch and PR afterward.

For large multi-file syncs, GitHub GraphQL `createCommitOnBranch` with `expectedHeadOid` and inline base64 additions is a more reliable atomic alternative to many REST blob calls.

**Why:** Even sequential connector blob calls can encounter transient HTML/rate-limit responses; GraphQL keeps the ref update atomic and avoids partial branch movement.

**How to apply:** Read all workspace files first, re-check the branch head in the same operation, then create the commit with the observed head as `expectedHeadOid`; never force-update.