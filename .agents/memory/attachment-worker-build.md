---
name: Attachment worker build
description: API build constraints for the terminable attachment-extraction worker.
---

The API server's logging build plugin injects additional entrypoints, so the attachment worker must be bundled in a separate explicit build without that plugin; otherwise an explicit worker outfile conflicts with esbuild's multi-entry output.

**Why:** A single shared multi-entry build failed at bundle time, while the isolated worker still needs a stable sibling `.mjs` file for runtime termination.

**How to apply:** Keep the main server bundle and the attachment worker bundle as separate build invocations, and verify the built worker directly after build changes.