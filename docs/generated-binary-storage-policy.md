# Generated Binary Storage and Retention Policy

This document defines the current production policy for assistant-generated PDF / Word / Excel / PowerPoint files in Chat-Space and the conditions that should trigger a move to a different storage architecture.

## Current decision

For the current scale of Chat-Space, generated binary files are intentionally stored in PostgreSQL as base64-encoded text rows in the `assets` table.

This is a deliberate bounded design, not an assumption that PostgreSQL text storage is the ideal long-term blob store.

The current design is acceptable because:

- generated files are persisted in the same transaction as the user/assistant messages and text artifacts, so a failed completion cannot leave a durable unreachable binary;
- quota decisions are serialized per authenticated user with a PostgreSQL advisory transaction lock;
- the default durable generated-file quota is **50 MiB per user** across generated binary assets and downloadable text artifacts;
- message and conversation deletion remove the associated downloads through owner-checked deletion and foreign-key cascade semantics;
- generated-file download endpoints remain owner-scoped;
- Replit Published App filesystems are not treated as durable storage.

Base64 increases the stored representation relative to raw bytes, so the quota is intentionally accounted in decoded file bytes rather than encoded text length. The representation overhead is accepted at the current bounded scale.

## Retention semantics

The default retention model is **conversation-bound retention**:

1. A generated file is retained while its owning message/conversation is retained.
2. Deleting the owning assistant message removes its generated binary assets and cascades text-artifact cleanup.
3. Deleting a conversation removes all assets and artifacts belonging to that conversation.
4. Legacy orphan binary rows with no message association are removed by the startup schema-ensure path.
5. There is currently **no independent time-based expiry** for a generated file that still belongs to a retained conversation.
6. A future account-erasure flow must continue to delete conversations (or otherwise explicitly remove their assets/artifacts) rather than leaving account-owned downloads behind.

Time-based expiry should not be introduced silently because it changes the user-visible meaning of saved conversations: a historical conversation that still displays a file card should not unexpectedly point to an expired download unless the UI and API explicitly represent that lifecycle.

## Capacity and migration triggers

Re-evaluate the PostgreSQL representation when **any** of the following becomes true:

- generated binary/text-download storage becomes a material fraction of the database (review at **25% of total logical database size**);
- generated-download data exceeds **5 GiB** in a deployment even if the percentage threshold has not been reached;
- the default per-user durable generated-file quota needs to increase beyond **100 MiB**;
- normal backup, restore, migration, vacuum, or database-clone operations are measurably dominated by generated file payloads;
- p95 generated-file size or retained-file count grows enough that transferring base64 rows materially increases API/database latency;
- product requirements introduce independent expiration, archival tiers, large media, sharing, or CDN delivery;
- database cost or operational limits make blob growth more expensive than a durable object store.

These are review triggers, not automatic migration events. A measurement should confirm that generated payloads are the actual bottleneck before changing architecture.

## Preferred future architecture

If a migration is triggered, prefer durable object storage for binary bytes while PostgreSQL remains the source of truth for ownership and metadata.

A future asset row should retain at least:

- asset id;
- owner/conversation/message relationship;
- filename and MIME type;
- decoded byte size;
- object-storage key;
- integrity hash/checksum;
- creation time and, if introduced, explicit expiry time.

Do **not** persist long-lived public object URLs as the authorization mechanism. Downloads should continue through an owner-authorized API path or short-lived signed URLs issued only after ownership validation.

### Transactional migration requirement

Moving bytes outside PostgreSQL must not reintroduce the orphan-window that the current transactional design removed.

An object-storage implementation should use one of these patterns:

- upload to a temporary/staging key, commit the database metadata transaction, then promote/finalize the object with compensating cleanup on failure; or
- commit an outbox/pending-upload record transactionally and let an idempotent worker complete upload/finalization; or
- another design with equivalent retry, idempotency, and orphan reclamation guarantees.

Every path must define cleanup for both directions:

- object exists but DB transaction fails;
- DB metadata exists but object upload/finalization fails.

## Migration compatibility

A storage migration should be rolling and reversible:

1. Add a storage-kind/object-key representation without removing existing `data` rows.
2. Make reads support both legacy PostgreSQL payloads and object-backed assets.
3. Write new assets to the new backend only after the dual-read path is deployed.
4. Backfill legacy assets with checksums and verify byte size/content before marking them migrated.
5. Remove legacy base64 payloads only after verification and a rollback window.

The existing owner-scoped download API should remain stable so the frontend does not need to know which backend stores a file.

## Monitoring

At minimum, operations should be able to measure:

- decoded generated-file bytes per user;
- total `assets` and `artifacts` retained bytes;
- generated-file quota rejections;
- asset/artifact row counts and size distribution;
- database size attributable to generated downloads;
- failed persistence/rollback events;
- download failures and integrity/size mismatches.

## Review cadence

Review this policy whenever storage limits, deployment topology, retention requirements, or generated-file formats materially change. Otherwise, review it before deliberately raising the default durable quota or introducing file types substantially larger than the current document-oriented outputs.
