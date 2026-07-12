# Phase 2 + Phase 5 統合状況 report

2026-07-12 更新。fork main `6ef7a43` と session-wide High cross-review fix の実状態を SoT として記録する。

## 統合状況

| Phase | 内容 | PR | fork main `6ef7a43` での状態 |
|---|---|---|---|
| P5c0 | P1b review hygiene | #7 | **merged** |
| P2a | IMP-Doc typed contract AST + Legacy characterization | #8 | **merged** |
| P2b | Contract semantics + hover + signature help | #9 | **merged** |
| P5d1 | pack_format 変更時 cache invalidate + reinit | #10 | **merged** |
| P5d2 | Reset Project Cache barrier | #11 | **merged** (`b3f8cbe`) |
| P5d3 | cache folder から open した file の parse 経路 | #12 | **merged** (`f8a9ea7`) |
| P5d4 | Binary hash 経路統一 + cache v9 + partial invalidation | #13 | **merged** (`04837df`) |
| P5a | tsb-imp-doc-cli incremental cache | #14 | **merged** (`6ef7a43`) |
| P5b | Asset Gate profiler 分析 + baseline doc | #15 | **skip / open**。実装 `b96ff60` は fork main の ancestor ではない |
| P5c1 | Final review + Plan 完走 report | #16 | **merged** (`e5f7cee`)。merge 時点の report が古かったため本 fix で復元 |

fork main への統合は **merged 9 / skip・open 1**。P5b branch は `c43667b` から分岐しており、P5d2/P5d3/P5d4/P5a と未統合である。したがって `notes/F-asset-baseline.md`、`packages/tsb-imp-doc-cli/src/assetPerformance.ts`、profiler 拡張、Asset Gate test は fork main に存在しない。Phase 2、P5d1-4、P5a、P5c1 は統合済みだが、Phase 5 全体を merged/完走とは扱わない。

## Gate 三本立て

Plan 定義の Gate は次の三本である。

- Phase 0 に対する cold regression 解消
- Phase 1 baseline に対する改善
- true-noop と one-file semantic change の絶対値

P5b が fork main に未 merge のため、test level を含む Gate 判定は **P5b を現行 main に統合した後に実施**する。現 HEAD では pass と記録しない。実 Asset 計測も同じ統合後の別実行とする。

## Session-wide High cross-review 反映

- editor `onDidOpen` / `onDidChange` / `onDidClose` と initial `ready` を project lifecycle queue に統合した。rebuild 中の editor mutation は commit/rollback 後に適用される。
- initial scan の `documentUpdated` は per-file streaming に戻した。rebuild は派生済み diagnostics のみを stage し、全 client check と transaction commit の後に client-managed map の現値を取得して publish する。disk AST/TextDocument を全件保持しない。
- `invalidatePartial('initializer', uris?)` は `uris` にかかわらず linked symbol table、全 file-derived state、roots、registrar checksums を無効化する契約にした。`lint` の URI 単位 invalidation は維持する。
- CLI cache publish は sidecar exclusive lock 内で token を再検証して rename し、親 directory を sync する CAS にした。同一 token の競合 writer は一方だけ publish できる。
- core/CLI 共通 `mapLimit` を追加し、core save barrier の tracked-file read fan-out を 32 に制限した。
- `LatestCacheVersion` は **9** を維持する。

## Verify

session-wide fix 後の指定 suite 件数は次のとおり。

- tsb-imp-doc: **74/74 pass**
- tsb-imp-doc-cli: **7/7 pass**
- Java Edition service: **24/24 pass**
- 合計: **105/105 pass**
- core / tsb-imp-doc / tsb-imp-doc-cli / language-server / tsb-imp-doc test の 5 TypeScript project: pass
- ESLint: 0 warnings
- dprint check: pass
- `git diff --check HEAD`: pass

## WANT / IMO judgment

本 fix に反映した項目:

- CLI removed-file detection の `includes` loop を `Set` lookup に変更し、O(N×M) を除去
- `Project.close()` が lifecycle queue を drain してから save し、shutdown cache save error を log に留めるよう修正
- `Symbol.data.impDoc.contract` の v9 cache round-trip を既存 integration test に追加
- cache schema の string record 判定で array を拒否
- `publishRebuildEvents` の同一分岐を解消

別 phase / 別 PR 候補として明示 skip した項目:

- hot config update での partial invalidation 利用: 現行 full rebuild は P5d2 の correctness boundary。initializer partial 契約を安全化した上で、最適化は計測後に扱う。
- cache transaction と進行中 hash update の三者 race: pending update/token snapshot を含む transaction 再設計が必要。
- save starvation retry と per-keystroke hash debounce: idle scheduling policy と cache freshness SLA を決める必要がある。
- reinit/reset scheduler と settle guard の共通抽象化、generation/token/barrier の rename: upstream 抽出時の設計 PR とする。
- signature-help provider priority API: fork 側の回帰 test は維持し、MetaRegistry の upstream API 変更として扱う。
- `symbol.desc` の lazy rendering: cache 表示形式と hover pipeline を同時に変更するため別 PR とする。
- config rebuild と manual reset の scheduler 統合、および追加の cross-barrier race coverage: coalescing semantics を定義する別 PR とする。
- browser rename mock の追加仕様化: Node CLI CAS の修正範囲外。

## 次の判定点

1. P5b を現行 fork main 上へ rebase/移植し、Asset profiler、baseline doc、Gate test を統合する。
2. P5b merge 後に Gate 三本を test level で再判定する。
3. 必要な実 Asset cold / warm-noop / one-file 計測を実施する。
4. Gate 通過後にのみ Plan 完走 tag を判断する。

## 関連

- P5d0 triage: `notes/p5d0-triage.md`
- P5d4 findings: `notes/p5d4-review-findings.md`
- upstream pnpm dual-support briefing: `notes/upstream-pnpm-dual-support-briefing.md`
