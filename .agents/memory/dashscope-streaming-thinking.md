---
name: DashScopeストリームと推論
description: Alibabaモデルの累積ストリームとデフォルト推論による二重回答の回避
---

## ルール
DashScope（Qwen 3.6/3.7、GLM 5.2 など）は推論がデフォルト ON。OpenAI互換でも
`extra_body.incremental_output = true` を必ず送り、`delta.content` は累積の可能性が
あるので単純連結せず `mergeStreamDelta` する。推論は `reasoning_content` に分離し、
本文へ混ぜない。検索判定コールでは `enable_thinking: false`。

**Why:** incremental_output が false だと各チャンクが「これまでの全文」になり、
append すると回答が二重・三重に見える。推論本文が content に混ざると「回答が2つ」
に見える。

**How to apply:** `applyGenerationParams` で enable_thinking / reasoning_effort /
thinking_budget を明示。フロントは推論中・生成中を別アニメーションで出す。
