/**
 * Tool Bank lifecycle policy.
 *
 * 納入 (bank):
 *   - プロジェクト遂行中に「再利用価値がある」と判断したコード/スクリプトを登録する
 *   - 必須: name, code, summary（何が・どこで使えるか）
 *   - 推奨: language, tags, usage, sourceProjectId
 *
 * コピー利用 (copy):
 *   - 他プロジェクトで使うときは bank から **コピー** する（リンクしない）
 *   - コピー時に useCount++ / lastUsedAt を更新する
 *   - コピー後は呼び出し側プロジェクトの責任で改変してよい
 *
 * 更新 (update) — 以下をすべて満たす場合のみ:
 *   1. バグ修正・API破壊の解消・明確な改善のいずれかである
 *   2. changeSummary に「何をなぜ変えたか」を書く（必須）
 *   3. version を +1 する
 *   4. status が archived のツールは更新不可（新規登録する）
 *   - 互換性のない変更は slug を変えるか新規ツールとして bank する
 *
 * 非推奨 (deprecate):
 *   - 代替があり新規利用を止めたいとき status=deprecated
 *   - 既存コピーは動き続ける。新規 copy は警告表示
 *
 * 削除 (delete) — soft delete から始める:
 *   A. 明示削除: ユーザー/管理者が意図的に消す（deletedAt を立てる）
 *   B. 自動退避候補 (archived):
 *      - status=active/deprecated かつ lastUsedAt も updatedAt も
 *        90 日以上前、かつ useCount=0
 *   C. 物理削除 (purge) の条件:
 *      - deletedAt から 30 日経過、または archived かつ 180 日未使用
 *      - project_tool_copies にはスナップショットが残るため、bank 側
 *        消去で他プロジェクトのコピーは壊れない
 */

export const TOOL_BANK_POLICY = {
  /** Days of no use/update before an active tool is eligible for archive. */
  ARCHIVE_IDLE_DAYS: 90,
  /** Days a soft-deleted row is kept before purge is allowed. */
  PURGE_SOFT_DELETE_DAYS: 30,
  /** Days an archived unused tool is kept before purge is allowed. */
  PURGE_ARCHIVED_IDLE_DAYS: 180,
  MAX_CODE_CHARS: 40_000,
  MAX_SUMMARY_CHARS: 2_000,
} as const;

export const TOOL_BANK_POLICY_DOC_JA = `
## ツールバンク更新・削除基準

### 納入
- 再利用価値があるコードを name / code / summary 付きで登録

### コピー
- 他プロジェクトでは **コピーして** 使用（リンクしない）
- コピー時に useCount / lastUsedAt が更新される

### 更新してよい条件
1. バグ修正・破壊的変更の解消・明確な改善
2. changeSummary に理由を記載（必須）
3. version をインクリメント
4. archived は更新不可 → 新規登録

### 非推奨
- 代替がある場合は deprecated。既存コピーは維持

### 削除
- soft delete（deletedAt）→ 30日後に物理削除可
- active かつ 90日未使用は archived 候補
- archived かつ 180日未使用は物理削除可
- プロジェクト側のコピーはスナップショットなので bank 削除の影響を受けない
`.trim();
