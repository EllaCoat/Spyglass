# TSB Asset baseline — Phase 5b test-level gate

## 状態

Phase 5b では、Phase 5a の CLI incremental cache 経路と P5d4 の core cache 改善が
統合されることを前提に、profiler 出力、Gate 三本立ての判定 API、hotspot 分析 schema を
test level で固定した。

実 Asset の cold 3 iter / warm 5 iter / warm-noop 3 iter は意図的に実施していない。
実データによる gate 到達判定は post-Plan のユーザー判断後に行う。Phase 5a と P5d4 によって
全走査を避ける core / CLI 経路が成立するため、特に warm-noop は理論上 target 到達を見込むが、
この見込みを実測 pass としては扱わない。

## 既存 baseline

Phase 0 の保存値は次のとおり。連続 cold iter 2/3 は OS disk cache が warm のため、Gate (i) の
基準値には真の cold である iter 1 を使う。

| pattern | walltime | 備考 |
|---|---:|---|
| Phase 0 cold iter 1 | 394.42 s | 16094 files、真の cold |
| Phase 0 cold iter 2/3 median | 3.05 s | Spyglass cache cold / OS cache warm |
| Phase 0 warm 5 iter median | 2.88 s | min 2.79 s / max 3.14 s |
| Phase 0 warm-noop 1 iter | 341.54 s | 1 file 変更で全 project scan |
| Phase 1 cold | 約 500–548 s | Gate (ii) 入力時は対応 iter の確定値を使用 |
| Phase 1 warm-noop | 約 511 s | 同上 |

## profiler output schema

実装は `AssetProfilerSession` が core の `ProfilerFactory` reporter hook を受け、同じ profiler ID が
複数回 finalize された場合も run 単位に集約する。CLI fixture smoke では parse / bind / check /
lint の全 profiler が起動し、構造化 output を生成することを確認する。

```jsonc
{
  "schemaVersion": 1,
  "runId": "2026-07-12T00-00-00Z-asset-cold-01",
  "phase": "phase-5b",
  "pattern": {
    "cacheState": "cold"
  },
  "generatedAt": "2026-07-12T00:00:00.000Z",
  "profilers": [
    {
      "id": "project#ready#parse",
      "style": "top-n",
      "topN": 50,
      "totalTasks": 16094,
      "totalMs": 45000,
      "minMs": 0.2,
      "avgMs": 2.8,
      "maxMs": 1200,
      "tasks": [
        { "name": "file:///.../heavy.mcfunction", "durationMs": 1200 }
      ]
    }
  ]
}
```

`pattern` は次の三本を表現する。

| pattern | schema |
|---|---|
| cold | `{ "cacheState": "cold" }` |
| warm | `{ "cacheState": "warm" }` |
| warm-noop | `{ "cacheState": "warm-noop", "changeKind": "true-noop" }` |

warm-noop の `changeKind` は `true-noop`、`one-file-semantic-change`、
`one-file-contract-change` のいずれかとする。後者は依存 fan-out の観測用であり、Gate (iii) の
5 秒判定対象は `one-file-semantic-change` である。

## Gate 三本立て

閾値は Phase 0 の observability 定義と Phase 5 Plan を具体化したもの。walltime は ms で API に
渡し、負値・NaN・Infinity は入力不正として reject する。

| Gate | 判定 | 境界 | 現時点 |
|---|---|---|---|
| (i) Phase 0 回帰解消 | `cold <= phase0Cold * 1.20` | Phase 0 394.42 s 使用時は 473.304 s 以下 | **test-level pass**。境界値と超過を unit test 済。実測未判定 |
| (ii) Phase 1 からの改善 | `observed < phase1Baseline` | 同値は fail。比較対象と同一 pattern / 条件の確定値を入力 | **test-level pass**。strict 境界を unit test 済。実測未判定 |
| (iii-a) true-noop | `< 1000 ms` | 1000 ms は fail | **test-level pass**。境界値を unit test 済。実測未判定 |
| (iii-b) one-file semantic change | `< 5000 ms` | 5000 ms は fail | **test-level pass**。境界値を unit test 済。実測未判定 |

`evaluateAssetGates` の総合 pass は (i)、(ii)、(iii-a)、(iii-b) がすべて pass の場合だけ true と
する。test-level pass は判定ロジックと profiler 経路の成立を示すもので、Asset performance の
実測 pass を意味しない。

## hotspot report schema

`buildAssetHotspotReport` は同一 pattern の Phase 0 / Phase 1 / Phase 2 / current output を入力に
取り、stage ごとに次の差分を返す。

| field | 算出 | 用途 |
|---|---|---|
| `phase1FromPhase0Ms` | Phase 1 − Phase 0 | Phase 1 由来 regression の候補 |
| `phase2FromPhase1Ms` | Phase 2 − Phase 1 | Phase 2 由来 regression の候補 |
| `currentFromPhase2Ms` | current − Phase 2 | Phase 5 cache 改善後の増減 |

正値は増加、負値は改善を示す。自動的に原因を断定せず、stage delta と profiler top-n URI を
調査対象の絞り込みに使う。pattern が異なる入力は比較不能として reject する。

### profiler top-n 実データ入力欄

| pattern | profiler | rank | URI | duration (ms) | stage 内比率 | 所見 |
|---|---|---:|---|---:|---:|---|
| cold | project#ready#parse | 1 | post-Plan 実測待ち | | | |
| cold | project#ready#bind | 1 | post-Plan 実測待ち | | | |
| cold | project#check | 1 | post-Plan 実測待ち | | | |
| cold | project#lint | 1 | post-Plan 実測待ち | | | |
| warm | project#ready#parse | 1 | post-Plan 実測待ち | | | |
| warm-noop | project#check | 1 | post-Plan 実測待ち | | | |

## 実データ保存欄

| pattern | iterations | walltime median / p95 | peak RSS | profiler output | 判定 |
|---|---:|---|---|---|---|
| cold | 3 | 実測 skip | 実測 skip | post-Plan | 未判定 |
| warm | 5 | 実測 skip | 実測 skip | post-Plan | 未判定 |
| warm-noop: true-noop | 3 | 実測 skip | 実測 skip | post-Plan | 未判定 |
| warm-noop: one-file semantic change | 3 | 実測 skip | 実測 skip | post-Plan | 未判定 |

Phase 5a + P5d4 の core / CLI 改善で理論値到達を見込む。実測値を得るまではこの欄を
`未判定` のまま保持し、推定値を記入しない。

## post-Plan 実測

ユーザーが実測 gate 到達判定へ進むと判断した時点で、fork 外の Asset を Sol bg で計測する。
所要時間は 30–60 分を想定し、cold 3 iter、warm 5 iter、warm-noop 3 iter を同一 build / revision /
環境で実施する。各 run は外部 harness の walltime / peak RSS と、この文書の schemaVersion 1
profiler output を同じ `runId` で保存する。

計測後は次を順に行う。

1. median / p95 と profiler top-n を実データ保存欄へ転記する。
2. Gate 三本立て API に walltime を入力し、test-level 判定とは別に実測判定を記録する。
3. Phase 0 / 1 / 2 / current の同一 pattern output で hotspot report を生成する。
4. Phase 1 / Phase 2 の delta と top URI を照合し、regression 帰属を人手で確定する。

