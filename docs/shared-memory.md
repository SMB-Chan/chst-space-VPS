# モデル共通の記憶サービス

既存のChat SpaceのPostgreSQLを利用し、認証ユーザーごとの記憶をモデル間で共有します。モデルIDは記憶の所有者や検索条件に含めません。通常の保存されるチャットでは共通の検索とメモリツールに接続済みです。プライベートセッションと翻訳モードでは読み書きしません。

外部のLLMアプリも、同じユーザーの認証で `/api/memories` APIを利用できます。接続はアプリ側で行います。全世界のモデルや各社の公式チャットアプリへ自動的に記憶が伝播する仕組みではありません。今回の共有範囲は**本人のモデル間**です。公開知識の共同編集や組織間共有、MCPアダプターは含めていません。

## 起動

既存の `DATABASE_URL` とClerkの認証設定を使います。新しい外部サービスやAPIキーは不要です。

```sh
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/api-server run start
```

起動時に既存テーブルへ列と訂正履歴テーブルを追加し、完了後にAPIを公開します。既存データは出典区分が不明なため `unverified` として扱い、自動参照から除外します。管理APIから確認し、出典を確認できたものだけ訂正APIで分類してください。期限のない旧データには学習日から180日の期限が付きます。

## 保存するもの

- `kind`: `user_statement`（ユーザー本人の発言）、`sourced_fact`（出典付き事実）、`inference`（推測）、`unverified`（未確認）。省略時は `unverified`。
- `category`: `preference`（好み）、`decision`（決定）、`progress`（進捗）、`knowledge`（知識）。省略時は `knowledge`。
- `source_url` / `source_ref`: HTTP(S)の出典URL、会話や資料の参照ID。
- `valid_as_of`: 情報の基準日。`sourced_fact` では出典URLと基準日を必須とします。
- `expires_at`: タイムゾーン付きISO日時。新規作成・訂正時は未来の日時が必要です。
- `confidence`: 0〜1の申告値（既定0.5）。検証済みである確率ではありません。
- `revision`: 訂正ごとに増える版番号。訂正・失効APIでは `expected_revision` に読み取った版を渡します。競合時は409を返します。

出典の必須化は内容の真偽を保証しません。出典本文の取得や時事情報の更新には既存のWeb検索を使います。このサービス単独でニュースを巡回したり、事実を自動認定したりはしません。推測と未確認の情報は管理APIに残せますが、検索・自動プロンプトには入りません。

## 記憶の寿命と削除

明示した有効期限を優先します。省略時の既定値は、推測・未確認が3日、進捗が14日、出典付き事実が7日、それ以外が180日です。よく参照されても有効期限は延びません。未来の基準日を持つ情報はその日（UTC基準）まで参照されません。

| 操作 | 参照への影響 | 本文・履歴の扱い |
|---|---|---|
| 訂正 | 次回から最新版を参照 | 旧版を最大10件、30日間保持 |
| 失効 (`incorrect` / `unnecessary` / `outdated`) | 直ちに検索対象外 | 失効から30日後の定期処理で廃棄 |
| 置換 | 旧記憶を検索対象外 | 旧記憶を置換から30日後の定期処理で廃棄 |
| 期限切れ | 定期処理を待たず検索対象外 | 期限切れから30日後の定期処理で廃棄 |
| 完全削除 | 直ちに取得不能 | その記憶と全訂正履歴をDBから削除 |

有効な記憶はユーザー当たり500件。超過時は申告信頼度・最終参照日時などによって低優先のものを失効させます。失効・期限切れ・置換済みの保存は合計100件までなので、上限に達した履歴は30日より早く廃棄されることがあります。情報の意味が似ているだけでは自動統合せず、同じ内容・分類・出典・タグ等の重複保存のみ統合します。

廃棄ワーカーは起動後と60秒ごとに動きます。各回、記憶と期限切れの履歴をそれぞれ最大1000件処理し、非利用ユーザーも対象にします。停止中や大量のバックログがある場合、物理削除は次の処理まで遅れます。期限切れ・失効済みの情報が検索から外れることには影響しません。

完全削除の対象はこのサービスの記憶と訂正履歴です。元の会話ログ、既にモデルへ送られた入力、外部のバックアップは別の保存領域です。削除前に開始した推論の入力を取り消すものではありません。置換によって別IDで保存した記憶は別レコードとして管理します。

## API

[OpenAPI仕様](./shared-memory.openapi.json)。全エンドポイントで既存のClerk認証が必要です。ユーザーIDは認証情報から決定し、リクエスト本文での指定は受け付けません。

| メソッド | パス（`/api`に続く） | 用途 |
|---|---|---|
| POST | `/memories` | 保存（同一の有効記憶は再利用） |
| GET | `/memories?limit=50&offset=0` | 管理用一覧。失効・未確認も含む |
| GET | `/memories/search?query=東京&limit=10` | 有効で由来が明示された記憶のキーワード検索 |
| POST | `/memories/context` | モデルに渡す必要な記憶を予算内で取得 |
| GET | `/memories/{id}` | 状態・版・出典を確認 |
| PATCH | `/memories/{id}` | 履歴付き訂正 |
| GET | `/memories/{id}/revisions` | 保持中の訂正履歴 |
| POST | `/memories/{id}/invalidate` | 誤り・不要・古い情報の失効 |
| POST | `/memories/{id}/supersede` | 保存済みの新IDで古い記憶を置換 |
| DELETE | `/memories/{id}` | 本文と履歴の完全削除 |
| POST | `/memories/maintenance` | 本人の廃棄処理と保持件数の確認 |

例: 保存するJSON

```json
{
  "topic": "回答の言語",
  "content": "日本語で簡潔に回答してほしい",
  "kind": "user_statement",
  "category": "preference",
  "source_ref": "conversation:123",
  "confidence": 0.8
}
```

モデルへの入力を取得するJSON（`POST /api/memories/context`）:

```json
{ "message": "前回の方針で進めたい", "max_chars": 3000 }
```

応答の `context` をモデルに渡します。管理用一覧や訂正履歴をそのままモデルに渡さないでください。短い応答の形式の好みも取得でき、日英の単語分割で関連情報を検索します。標準チャットは直近会話による追加検索も利用します。専用ベクトルDBは使わず、500件の上限内をPostgreSQLで検索します。

訂正するJSON（`PATCH /api/memories/{id}`）:

```json
{ "content": "必要な説明は詳しく回答してほしい", "expected_revision": 1, "reason": "ユーザーによる希望の変更" }
```

失効するJSON（`POST /api/memories/{id}/invalidate`）:

```json
{ "reason": "incorrect", "expected_revision": 2 }
```

## モデルへの入力予算

自動挿入とメモリ検索ツールの出力は最大6000文字です。APIでは256〜6000文字で指定できます。完全な記録単位で選び、本文の途中切断による意味の変化を避けます。収まらない記録は省きます。検索した記憶は非信頼データとして包み、タグ境界もエスケープします。

文字数はトークン数ではありません。モデルごとにトークナイザーが異なるため、削減率は実際のAPI利用量で測定してください。今回、過去の会話履歴の既存予算は変更していません。記憶を追加することで入力が増える場合もあります。

## 検証

専用のテスト用PostgreSQLを指定してください。テストは専用のユーザーIDで記録を作成し終了時に削除します。保持期限ワーカーのテストは共通の期限切れ廃棄処理を実行するため、本番DBは使用しないでください。

```sh
DATABASE_URL=postgresql://USER@127.0.0.1:PORT/TEST_DB pnpm --filter @workspace/api-server exec vitest run --config ./vitest.config.ts src/lib/llm-memory-store.test.ts src/lib/llm-memory-store.pg.test.ts src/lib/llm-memory-tools.test.ts src/lib/llm-memory-worker.test.ts src/routes/memories.pg.test.ts
pnpm run typecheck
node scripts/check-memory-api.mjs
```

所有者分離、出典・日付の検証、訂正競合、重複、失効、期限、履歴削除、上限、プロンプト予算、HTTP操作、ワーカーの停止と再試行を検証します。DB未設定ではPostgreSQL/HTTPの統合テストはスキップされます。実際の複数LLMの回答品質・トークン削減率は別途モデルAPIで計測が必要です。
