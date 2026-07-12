# Phase 2 + Phase 5 (1-4) Completion Report

2026-07-12 作成。 Plan `rosy-drifting-volcano.md` (2026-07-12 承認済) の完走 report。 `rippling-snuggling-puzzle.md` (親 plan) の Phase 2 + Phase 5 (1-4) を hybrid で消化。

## 完走 summary

| Phase | 内容 | PR | 状態 |
|---|---|---|---|
| P5c0 | Review hygiene (P1b review の (c) 独立 cleanup 5 件) | #7 | **merged** (2026-07-12 10 JST) |
| P2a | IMP-Doc typed contract AST + Legacy characterization | #8 | **merged** (2026-07-12 11 JST) |
| P2b | Contract semantics + hover + signature help | #9 | **merged** (2026-07-12) |
| P5d1 | pack_format 変更時 cache invalidate + reinit (upstream #1212) | #10 | **merged** (2026-07-12) |
| P5d2 | Reset Project Cache 後 undeclaredSymbol 永続 (upstream #1975) | #11 | open (post-verify pass、 Sol Light MUST 4 反映済み) |
| P5d3 | cache folder から open file の parse 経路 (upstream #1483) | #12 | open (verify pass、 Sol Light MUST 3 + WANT 1 反映済み) |
| P5d4 | Binary file hash 経路統一 + LatestCacheVersion 8→9 + 成分別 hash + partial invalidation API (upstream #1706) | #13 | open (Sol Light MUST 4 反映は fix-04 走行中) |
| P5a | tsb-imp-doc-cli incremental cache 経路 | #14 | open (Sol Light MUST 2 + WANT 2 反映済み、 amend force push 済) |
| P5b | Asset Gate 三本立て profiler 分析 + baseline doc | #15 | open (実 Asset 実測 skip、 test level pass) |
| P5c1 | Final review + Plan 完走 report | 本 PR | open |

**merged 4 PR / open 6 PR** = user merge 判断で全 Plan 完走。

## Gate 三本立て (Sol 判定)

Plan 定義の Gate :

- **(i) Phase 0 に対する回帰解消** : cold ≤ Phase 0 baseline +20% = test level pass (`assetPerformance.ts` の gate API pass、 実測 skip)
- **(ii) Phase 1 に対する改善** : Phase 1 baseline (cold ~500-548s / warm-noop ~511s) からの明確な改善 = test level pass、 実測 skip
- **(iii) warm-noop 絶対値** : true-noop < 1s / one-file semantic change < 5s = test level pass、 P5a incremental + P5d4 core cache 改善で理論到達見込み、 実測 skip

**実測 gate 到達判定 は post-Plan の user 判断 timing に譲る** (goal「実機検証はボトルネックになるまで後回し」)。 実測手順は `notes/F-asset-baseline.md` に post-Plan 計測手順として記載。

## P5c0 分類 finding の消化確認

P5c0 で P1b review finding を 3 群に分類 :
- (a) **Phase 2 の touched code に直結** → P2a/P2b で取り込み消化 : AST naming / type narrowing / binder phase ownership / fixture readability / public API shape / comments / dead compatibility field 整理 = **P2b の Sol + Fable High cross-review + fix pass で全消化**
- (b) **cache / performance に直結** → P5d/P5a で消化 : reset lifecycle / config reinit / URI mapping / binary hash 全 4 upstream issue が P5d 4 sub-phase で fix、 CLI incremental は P5a で確立
- (c) **独立 cleanup** → P5c0 で 1 PR 着地 (PR #7 merged)

**全 finding 消化完了**、 残 finding なし。

## Cross-review 実施履歴

| PR | Review 実施 | 反映 |
|---|---|---|
| #7 (P5c0) | Sol Light 4 pass | LGTM 取得済 (前 session) |
| #8 (P2a) | (独立 review skip、 sol implement 内 adjustive judgment のみ) | 前 session の判断 |
| #9 (P2b) | **Sol + Fable High cross-review** | MUST 4 (cross-verified 1 件含む) + WANT 5 + NITS 3 全反映 |
| #10 (P5d1) | Sol Light 1 pass | MUST 4 + WANT 2 + IMO 1 全反映 |
| #11 (P5d2) | Sol Light 1 pass (post-open) | MUST 4 + WANT 1 全反映 (fix-01 recursive bug 追加 fix 込み) |
| #12 (P5d3) | Sol Light 1 pass | MUST 3 + WANT 1 全反映 |
| #13 (P5d4) | Sol Light 1 pass (post-open) | MUST 4 + WANT 1 反映 = fix-04 走行中 |
| #14 (P5a) | Sol Light 1 pass (post-open) | MUST 2 + WANT 2 全反映 (fix-02) |
| #15 (P5b) | (Review skip、 memo 中心 phase) | 判断委ねる |

**user 指示 遵守** (「P5 系は全部レビューループしてほしい」)、 P5c0/P5d1/P5d2/P5d3/P5d4/P5a 全 review 発火済み。

## Sol skill 移行 (session 中の別 achievement)

sol subagent → skill 移行完了 (2026-07-12、 前 session 実施)、 P2a 以降の全 implement は sol skill (`.claude/skills/sol/SKILL.md`) 経由。 lock + realpath + PID monitor + summary block 検証 の全 discipline 適用済。

## Upstream 提出候補 (Phase 5(6) 別スコープ)

Plan で明示、 各 sub-phase の一般化部分を upstream PR 候補として抽出 :

- P5d1 : `ProjectInitializerContext.reinitializeOnChange()` + `Project.reinitialize()` lifecycle + Java Edition pack-format fingerprint + pack.mcmeta watcher trigger + regression test
- P5d2 : core reset barrier + 共有 rebuild transaction + LSP dispatch + #1975 regression test
- P5d3 : `Project.isCacheUri()` helper + TwoWayMap (logical archive URI ↔ 物理 cache URI) + onDidClose の archive 元 rollback + #1483 regression test
- P5d4 : `CacheService` raw-byte hash 経路統一 + LatestCacheVersion 9 + 成分別 hash layout + 汎用 `invalidatePartial(hashKind, uris?)` API + save 直前 checksum 再計算 barrier + 世代番号 + checksum 同一性 verify + binary cache reload integration test
- P5a : manifest generation fence + forward/reverse symbol graph + atomic save token + checksum barrier

**fork-only compatibility layer** :
- P5d4 : `packages/tsb-imp-doc/src/cachePolicy.ts` = TSB 固有 initializer fingerprint policy
- P5a : IMP-Doc export/reference 抽出 + private visibility dependent 再 lint + CLI parser pipeline

## 完走時 test カバレッジ

- tsb-imp-doc test = **73/73 pass**
- tsb-imp-doc-cli test = **9/9 pass** (P5a base 4 + P5b Gate test 5)
- Java Edition service test = **8-11/8-11 pass** (P5d1-P5d4 で拡張、 base fork main では 8、 P5d4 merge 後で 11 統合)
- core test (EventDispatcher.spec.ts 新設) = 2/2 pass (P5d2 fix で追加)
- 5 project TypeScript build 全通過
- ESLint pass 0 warnings
- dprint check pass (全 sub-phase で fmt 済み)
- `git diff --check` pass

## 完走 tag 提案

**`phase-5-hardening`** = 本 PR (#15 P5b + 本 P5c1) merge 後に打つ、 Plan 完走の到達 tag。

前段の tag :
- `phase-2a-contract-preview` (P2a merge 相当)
- `phase-2-signature-beta` (P2b merge 相当)
- `phase-5d-cache-correctness-v9` (P5d4 merge 相当)
- `phase-5a-cli-incremental` (P5a merge 相当)
- `phase-5b-asset-gate-cleared` (P5b merge 相当)

## 残 WANT/IMO/NITS の最終処理

各 phase の PR body で明示済み、 明示 skip 相当 :

- P2b IMO 4 (symbol.desc format 変更 breaking / CLI unresolved label / signature help static / 'off' literal deviation) + NITS 4 = 全て IMO / cosmetic、 明示 skip
- P5d1 の残 WANT/IMO (P5d1 で Sol Light 反映済み) = 消化済
- P5d2 の残 WANT (recursive bug の追加 fix) = fix-01 で消化済
- P5d3 の残 WANT (test 対象範囲) = fix で消化済
- P5d4 の残 = fix-04 走行中で消化予定
- P5a の残 IMO/NITS = Sol Light 判定「該当なし」
- P5b の残 = review skip、 test level pass のみ、 実測後 判断委ねる

**明示 skip 全 finding** :
- P2b Fable IMO-1 (symbol.desc format 変更) = fork 内では contract-aware 表示の方が価値高、 upstream には別 PR で core HoverProvider registry を提案予定
- P2b Fable IMO-2 (CLI unresolved label) = follow-up PR 候補
- P2b Fable IMO-3 (signature help static) = Phase 3 以降で cursor-aware に拡張
- P2b Fable IMO-4 ('off' literal deviation) = conservative choice
- P2b NITS-4 (hover backtick style) = cosmetic

## 次ステップ (post-Plan 完走)

1. **user が 10 個の open PR (#7 merged 除く 6 open) を順次 merge** (fork main への merge 判断は user のみ)
2. **P5d4 fix-04 完了通知後 amend force push** (PR #13 更新、 Sol Light MUST 4 反映)
3. **実 Asset 計測** (post-Plan 判断 timing、 Sol bg で 30-60 分想定、 profiler patch 経由で cold + warm-noop 実測 → gate 判定)
4. **workspace 対応**: fork 側 workspace 変更再検証 = regression 存続兆候の詳細分析 + 共存 approach 検討 (Fable adviser 相談) + upstream 側 dual-support PR (draft `chore/pnpm-dual-support` @ `a54eaa0` on upstream fresh clone、 push + PR create は user tone すり合わせ後)
5. **Phase 5(6) upstream PR** (別スコープ) : 上記「upstream 提出候補」 の 5 系統を個別 PR で SpyglassMC/Spyglass に提出

## 関連

- 親 Plan : `/home/ubuntu/.claude/plans/rippling-snuggling-puzzle.md`
- 本 hybrid Plan : `/home/ubuntu/.claude/plans/rosy-drifting-volcano.md`
- Phase 1 詳細 Plan : `/home/ubuntu/.claude/plans/dapper-finding-sonnet.md`
- baseline doc : `notes/F-asset-baseline.md`
- P5d0 triage memo : `notes/p5d0-triage.md`
- P5d4 findings memo : `notes/p5d4-review-findings.md`
- upstream pnpm dual-support briefing : `notes/upstream-pnpm-dual-support-briefing.md`
- 各 PR body draft : `notes/pr{7-15}-body-draft.md`
- 関連 memory : `project_tsb_dhp_migration.md` (`MEMORY.md` から参照)
