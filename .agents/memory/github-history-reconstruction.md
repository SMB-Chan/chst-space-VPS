---
name: Git履歴のAPI復元
description: GitHub連携APIだけで欠損した履歴をSHAを変えずに復元する際の制約
---

GitHub Git Data APIで履歴を復元する場合は、既存の親commitから順に、必要なblob、差分tree、commitを作成し、各返却SHAをローカルSHAと比較する。commit作成時の`parents`省略やtreeの基準間違いは別SHAを生成するため、ref作成前に停止する。既存branchが別SHAならforce updateせず中止する。

**Why:** APIは入力のparent・tree・author・committer・messageから新しいGit objectを生成するため、通常のcommit作成と同じ感覚で扱うと履歴SHAが変わる。空差分commitは親treeを直接再利用し、blobは存在確認後に不足分だけ登録すると書き込み制限を避けられる。

**How to apply:** 対象ref作成前にlocal HEAD、全commit/tree SHA、remote ref SHAを照合し、通常のcreate refまたはSHA一致時のno-opだけを許可する。