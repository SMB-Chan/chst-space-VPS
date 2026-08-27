---
name: Qwen Realtime transport
description: Alibaba Qwen Audio Realtimeの接続境界と音声形式に関する判断
---

Qwen Audio Realtimeのブラウザ接続は、通常のチャットモデルとは分離した専門能力として扱い、APIサーバーの短命・一回限りチケット経由でWorkspace-specific WSSへ中継する。PTTでは `turn_detection: null` を使い、入力は16kHz PCM16 mono、出力は24kHz PCM16 monoとする。

**Why:** Alibabaの公式Realtime仕様は、Workspace endpoint、Bearer認証、手動commit/response.create、上記のサンプルレートを要求する。ブラウザへAPI keyやproviderイベントを渡すと認証情報と内部プロトコルが露出する。

**How to apply:** 通常のモデル一覧にはRealtimeモデルを加えず、音声の最終transcriptだけを既存チャット送信経路へ渡す。設定済みendpointはWSS・固定path・固定model query・信頼済みAlibaba hostを検証し、Token Planキーは専門APIで拒否する。