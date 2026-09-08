# 音声能力の脱Alibaba化と Xiaomi MiMo 音声モデル統合

監査日: 2026-09-09（JST）
対象: 音声合成（TTS）と音声認識（ASR）のプロバイダ依存。`026619f` 以降の未コミット作業ツリーに対して実施。

## 動機

既存の音声能力は Alibaba Model Studio 専用に組まれていた。

- TTS は `alibaba-tts.ts` が WebSocket で `qwen-audio-3.0-tts-plus` を叩く唯一の経路
- ASR は `audio-transcription.ts` が OpenAI → DashScope の順で試し、`transcribe_audio` ツールは `transcribeDashScopeAudio` へ直結
- 能力ゲートは `isAlibabaSpecialistConfigured()` 一本
- ルーターのプロンプトは「日本語は未対応なので `none` を返せ」と明記

一方で共有起動設定は `DISABLE_OPENAI_MODELS=true` / `DISABLE_DASHSCOPE_MODELS=true` であり、`getAlibabaSpecialistConfigured()` は凍結時に `null` を返す。結果として **この構成では音声合成も音声添付の文字起こしも一切動いていなかった**。`synthesize_speech` ツールは登録すらされない。

Xiaomi MiMo は既にチャット용으로設定済み（`Xiaomi_Mimo_KEY` / `XIAOMI_API_KEY`、`https://token-plan-sgp.xiaomimimo.com/v1`）で、同じエンドポイントが音声モデルも公開している。追加の資格情報なしに音声能力を復活させられる。

## 実API調査（2026-09-09、Token Plan Singapore ホスト）

`GET /v1/models` の応答:

```
mimo-v2.5, mimo-v2.5-pro,
mimo-v2.5-asr, mimo-v2.5-tts,
mimo-v2.5-tts-voiceclone, mimo-v2.5-tts-voicedesign
```

### TTS

OpenAI の `/v1/audio/speech` ではなく **`POST /v1/chat/completions` + `audio` パラメータ**（gpt-4o-audio 同型）。

- 読み上げテキストは `role:"assistant"` の `content`
- voicedesign は `role:"user"` の `content` が声質指示。`audio.voice` は送れない
- voiceclone は `audio.voice` に **DataURL** が必要（ドキュメントは base64 と記載しているが、実APIは `audio.voice must be a DataURL for voice clone model` を返す）
- 応答は `choices[0].message.audio.data`（base64）。`stream:true` では `choices.delta.audio.data`
- `audio.format` は wav / mp3 / pcm / pcm16
- 既定のボイス: `mimo_default`、中国語系 `冰糖`/`茉莉`/`苏打`/`白桦`、英語系 `Mia`/`Chloe`/`Milo`/`Dean`

### ASR

同じく `POST /v1/chat/completions`。`content` に `{type:"input_audio", input_audio:{data, format}}` を**ちょうど1つ**。

- `format` は **wav と mp3 のみ**受理。`m4a`/`ogg`/`flac`/`webm`/`opus` は `input_audio.format must be one of: wav, mp3` で拒否
- DataURL 形式でも MIME は `audio/wav` / `audio/mpeg` / `audio/mp3` のみ。デコーダ側の案内文（mp3/flac/m4a/wav/ogg）より手前のゲートウェイ検証で落ちる
- 素の base64 には `format` が必須
- **テキストパートは追加できない**: `ASR request must not include text parts; text prompt is injected by the gateway`。`language` パラメータは無視される
- `max_completion_tokens` は **4096 が上限**（8192 は拒否）

### 言語品質（TTS出力を ASR に戻す往復で確認）

| 入力 | 結果 |
| --- | --- |
| 英語 `mimo-v2.5-tts`（mimo_default / Mia） | ASR が原文と完全一致 |
| 日本語 `mimo-v2.5-tts-voicedesign`（長いニュース文） | 「本日のニュースをお伝えします。东京でくるるでは午前中から気温が上升し、午后には20米度を超える见込みです。」— ほぼ復元。ただし簡体字混じり |
| 日本語 `mimo-v2.5-tts`（mimo_default） | 「留里瓦切啊，英雄发车诺，testesses。」— 破綻 |
| 日本語 `mimo-v2.5-tts`（冰糖） | 「它会开音声合成No Test七四。」— 一部のみ |
| 日本語 `mimo-v2.5-tts-voicedesign`（短い挨拶） | 「こんにちは。お水ご奉赠の茶素です。」— 冒頭のみ |

**結論: 英語は実用、日本語は voicedesign 経由なら実用に届くが安定しない。ASR の日本語出力は簡体字が混ざる。** 既定ボイスによる日本語は実用にならない。

## 実装

### 新規

| ファイル | 役割 |
| --- | --- |
| `audio-format.ts` | マジックバイト／MIME／拡張子からのコンテナ判定、WAVサンプルレート、ffprobe による長さ、ffmpeg 可用性と WAV へのトランスコード。プロバイダ非依存 |
| `xiaomi-audio.ts` | MiMo の TTS／ASR トランスポート。`XiaomiAudioError`（publicMessage と retryable）、`isXiaomiAudioConfigured` |
| `speech-capabilities.ts` | 両ベンダの音声カタログと解決。`TTS_MODELS` / `ASR_MODELS`、`isTtsModelId` / `isAsrModelId`、`modelIdForVoice`、`selectDefaultTtsModel`、`availableTtsModels` / `availableAsrModels`、ルーター用の記述生成 |
| `audio-synthesis.ts` | `audio-transcription.ts` と対になる TTS のディスパッチャ。モデル解決・言語検査・声色検査を行い、ベンダ別トランスポートへ振り分け、エラーを `SpeechSynthesisError` に正規化 |

### 変更

| ファイル | 変更 |
| --- | --- |
| `alibaba-asr.ts` | コンテナ判定・WAV解析・ffprobe を `audio-format.ts` へ移設。公開APIとエラーメッセージは不変 |
| `audio-transcription.ts` | 候補チェーンに MiMo ASR を追加（OpenAI → DashScope → Xiaomi）。`AudioTranscriptionArgs` に `languageHints`。モデル指定経路 `transcribeAudioWithModel` を新設し、失敗理由をログに残すよう変更 |
| `capability-broker.ts` | ルーターのプロンプトを静的定数から `buildRouterSystemPrompt()` へ。利用可能な音声モデル・言語・声色・prosody 対応を実際の設定から生成するよう変更。`audio.synthesize` の検証を `speech-capabilities` 経由に。`languageHint` に `ja` を追加。声色だけ指定された場合はその声色が属するモデルを解決。prosody 非対応モデルでは rate/pitch/volume を落とす |
| `specialist-capabilities.ts` | 能力レジストリに MiMo 音声3モデルを追加し `provider:"xiaomi"` で登録。`synthesize_speech` のゲートを `isAlibabaSpecialistConfigured()` から「到達可能なTTSモデルがあるか」へ、`transcribe_audio` を「到達可能なASRモデルがあるか」へ。ツール定義の enum・説明文を設定から生成。実行経路を `synthesizeSpeech` / `transcribeAudioWithModel` へ。zod の modelId/voice を、画像ツールと同じく実行時解決に統一 |
| `provider-policy.ts` | `DISABLE_XIAOMI_MODELS` を追加 |
| `llm-time-context.ts` | **音声リクエストへ日付コンテキストを注入しない**。下記参照 |
| `vitest.config.ts`（api-server） | 凍結フラグを `false` に固定 |

### 発見した不具合と修正

| 重要度 | 不具合 | 修正 |
| --- | --- | --- |
| 高 | 共有の `llmFetch` が全 `/chat/completions` に system メッセージを先頭注入し、MiMo 音声が `messages[0] system role is not allowed for TTS model` で全滅する | `injectLlmTimeContextIntoBody` が `audio` フィールドまたは `input_audio` パーツを持つ本文を素通しするよう変更。curl では成功し SDK 経由でのみ失敗するため、実APIでの端到端検証で発覚した |
| 高 | Alibaba 凍結時に `synthesize_speech` ツール自体が登録されず、音声合成が到達不能 | ゲートを提供プロバイダ単位から能力単位へ変更 |
| 高 | `transcribe_audio` ツールが `transcribeDashScopeAudio` へ直結し、凍結時に必ず失敗。OpenAI 側の経路も使われない | 中立ディスパッチャ `transcribeAudioWithModel` へ変更 |
| 中 | ASR に `max_completion_tokens: 8192` を送り `This model supports at most 4096` で拒否される | パラメータ自体を送らない（上限はプロバイダ側が適用する） |
| 中 | MiMo ASR が wav/mp3 しか受け付けず、ブラウザ録音の webm や m4a が文字起こしできない | ffmpeg があれば 16kHz モノラル WAV へトランスコードし、無ければ MP3/WAV への変換を促す非再試行エラー |
| 中 | ルーターのプロンプトが「日本語の音声合成は約束するな」と固定で指示し、対応後も日本語を `none` に落とし続ける | プロンプトを設定から生成し、モデル別の対応言語を提示する形へ変更 |
| 中 | 単体テストが `.env` の凍結フラグを拾い、実装と無関係に20件失敗していた | api-server の vitest 設定でフラグを `false` に固定。凍結を検証するテストは各自でスタブする |
| 低 | 全プロバイダ失敗時のログに各段の失敗理由が残らない | `failures` をログフィールドに追加 |

## 検証

- `pnpm exec vitest run --exclude '**/src/pages/chat.test.tsx'`: **120ファイル・987件成功、31件スキップ**
- `pnpm build`: 型チェック（scripts / api-server / ai-chat-space）と両ビルド成功
- `pnpm run check:api-routes`: 22経路の契約整合性チェック成功。`CapabilityModel.provider` の enum に `xiaomi` は既存で、`id` は自由文字列のため **OpenAPI とコード生成の変更不要**
- 実APIでの端到端: 本番のコードパス（`getCapabilityRegistry` → `getSpecialistTools` → `executeSpecialistTool("synthesize_speech")` → `transcribeAudioWithModel`）で以下を確認
  - `audio-synthesis` と `speech-to-text` が両方 `available`、MiMo 3モデルを列挙
  - 日本語 `languageHint:"ja"` → voicedesign へ自動選択 → MP3 生成（43,224 bytes）
  - 英語 `voice:"Mia"` → MP3 生成（26,520 bytes）→ ASR が原文と完全一致
  - webm 添付 → ffmpeg トランスコード → MiMo ASR が文字列を返す
  - 検証用の一時テストファイルは削除済み
- 新規テスト: `audio-format.test.ts` / `xiaomi-audio.test.ts` / `speech-capabilities.test.ts` / `audio-synthesis.test.ts`。既存の `capability-broker.test.ts` / `audio-transcription.test.ts` / `specialist-capabilities.test.ts` / `llm-time-context.test.ts` を更新

### 未解決・環境要因

- `*.pg.test.ts` 4ファイルは `password authentication failed for user "user"` で失敗。変更前のベースラインでも同一に失敗しており、ローカル Postgres の資格情報不一致が原因。今回の作業とは無関係
- `mimo-stream.test.ts` と `ai-chat-space/src/lib/settings.ts` は prettier 未整形。いずれも今回の変更前に存在したファイルで、所有者の作業と判断して触れていない
- `chat.test.tsx` は変更前から失敗しているため上記コマンドで除外

## 運用上の注意

- **ffmpeg が必須になった**。MiMo ASR は wav/mp3 しか受け付けないため、m4a/ogg/flac/webm の添付はトランスコードする。ffprobe は Qwen ASR が既に必要としているので、通常は同じパッケージで揃う。無い場合は当該形式を非再試行エラーで拒否し、ほかのプロバイダが使えるならチェーンがそちらへ進む
- **voiceclone は未実装（実装しない方針を利用者が決定）**。`mimo-v2.5-tts-voiceclone` は Token Plan ホストで応答し、`audio.voice` に声サンプルの DataURL を要求する（公式ドキュメントの base64 記載は実APIと食い違う）。他人の声の複製になり得るため今回は入れない。将来入れる場合は同意・管理者限定・サイズと長さの制限を先に決めること
- **音声ツールは一般ユーザーにも開放した**。`chat-stream.ts` の `RESTRICTED_SPECIALIST_TOOL_NAMES` はもともと「メディアツールは管理者のAlibaba資格情報で動く」という理由で `synthesize_speech` / `transcribe_audio` を管理者限定にしていたが、MiMo 音声は MiMo チャットと同じキーで動くため根拠が消えた。利用者の方針決定により2つを外し、残りは `generate_image` / `edit_image`（引き続き管理者のAlibaba資格情報）。あわせて
  - 能力ルーターを一般ユーザーにも走らせるよう変更。ただし `couldNeedSpeechCapabilityTool`（音声意図だけの狭いゲート）を通ったときのみで、画像・動画の文言ではルーター呼び出しを買わない
  - 一般ユーザーのプランが `generate_image` / `edit_image` だった場合は破棄する。参照画像名も渡さないため `image.edit` は計画できない
  - `transcribe_audio` 用に音声添付を一般ユーザーのツールコンテキストへ渡すよう変更（画像添付は従来どおり管理者のみ）
  - 既存の `AI_REQUESTS_PER_MINUTE` / `AI_MAX_CONCURRENT_REQUESTS` ガードがそのまま効く
- **realtime 音声は Alibaba 専用のまま**。`qwen-audio-3.0-realtime-plus` と `alibaba-realtime.ts` は今回触れていない。ルーターは従来どおり realtime へ振り分けない。`openapi.yaml` の `RealtimeSession.modelId` は単一値の enum なので、MiMo の realtime を足す場合は仕様変更とコード生成（`pnpm --filter @workspace/api-spec run codegen`）が必要
- **日本語の既定経路は voicedesign**。`selectDefaultTtsModel` は `languageHint:"ja"` のとき Alibaba を飛ばし、MiMo の voicedesign を選ぶ。日本語の品質は上記の実測どおり安定しないため、利用者に品質を約束する文言は入れていない
- 反映にはサーバーの再起動が必要。凍結フラグは起動時ではなく呼び出し時に評価されるが、`xiaomiClient` の有無は起動時に決まる

## 参照仕様

[Xiaomi公式 Chat Completions 仕様](https://mimo.mi.com/docs/en-US/api/chat/openai-api)、[TTS](https://mimo.mi.com/docs/en-US/api/audio/tts)。ASR はドキュメントページが SPA で取得できなかったため、実APIの応答（エラーメッセージが受理範囲を明示する）から仕様を確定した。
