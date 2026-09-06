---
name: 動的検索schedulerのテスト分離
description: 動的な検索engine順位付けがテスト間の共有観測状態で不安定にならないための原則
---

動的schedulerのテストでは、各テスト後にengine runtime観測値とprovider health/cooldown状態をリセットする。

**Why:** 成功率・失敗率・レイテンシを使う順位付けは、前のテストの結果でproviderの初期順序が変わり、fan-outやキャンセル検証が順序依存になる。

**How to apply:** schedulerまたはprovider ensembleのテストでprovider名を再利用する場合、環境変数の復元だけでなくruntime/healthのテストリセットもafterEachで実行する。