---
name: Git backup history
description: 自動バックアップ由来のcommitが作業ブランチ履歴に現れた場合の確認方針
---

自動バックアップ由来のcommitが作業ブランチの親や近傍に現れ、作業中に追加された未追跡ファイルがそのcommitのtreeへ先に含まれる場合がある。最終確認では、親commit名だけで作業内容を推測せず、`git status`、対象ファイルの`git ls-files`、HEADのtree、リモートrefを突き合わせる。

**Why:** バックアップ処理とcommit操作の間に履歴が変わると、最終commitのstatだけでは引き継いだ変更の全体像を誤認しやすいため。

**How to apply:** 既存の未コミット変更を引き継ぐ作業では、commit前後に対象ファイルの存在・追跡状態・remoteとの一致を確認する。バックアップcommit自体を削除・書き換えず、必要な変更だけを後続commitへ積む。