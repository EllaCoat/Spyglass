/**
 * matchesVisibility の RegExp compile 回数 + wall-clock を測る手動実行 benchmark。
 * Phase 1 (per-pattern RegExp cache) / Phase 2 (unified regex cache) の
 * before/after 比較の土台。 CI / unit test suite には組み込まない。
 *
 * 実行方法 (repo root から、 事前に `pnpm build` で lib/ を生成しておく) :
 *
 *     node packages/tsb-imp-doc/test/benchmark/within-pattern.bench.mjs
 *
 * 出力 : patterns 数ごとの RegExp compile 回数と wall-clock (ms) の JSON を stdout に出す。
 *
 * 実 workload での profile 手順 (getCaller cost attribution 等) :
 * `--cpu-prof` フラグで対象コマンドを回して .cpuprofile を Chrome DevTools
 * (Performance タブ → Load profile) で開く。 例 :
 *
 *     node --cpu-prof --cpu-prof-dir=./prof \
 *         --import=./packages/core/test/snapshot-setup.ts \
 *         --test --test-timeout=60000 --experimental-test-isolation=none
 *
 * 実際の profile 実行は Phase 1 完走後の before/after で行う想定 (Phase 0 では手順のみ)。
 *
 * 注意 : repo root の `pnpm test` (`node --test`) は default glob
 * (`**\/test/**\/*.{js,mjs,cjs}`) でこの file も拾うため、 test runner 配下では
 * 下部の guard で workload を skip する (= 何もせず終了、 test suite を汚さない)。
 */
import assert from 'node:assert/strict'
import { matchesVisibility } from '../../lib/util/withinPattern.js'

const PatternCounts = [1, 4, 16, 64]
const CallerCandidates = 20
const IterationsPerPatternCount = 10000

/**
 * global の RegExp を construct 回数 counter 付き subclass に差し替える spy。
 * matchesVisibility は call のたびに global scope の `new RegExp(...)` を解決する
 * ため、 差し替え後の compile が全て counter に乗る。
 */
function createRegExpSpy() {
	const original = globalThis.RegExp
	let count = 0
	class CountingRegExp extends original {
		constructor(...args) {
			super(...args)
			count += 1
		}
	}
	globalThis.RegExp = CountingRegExp
	return {
		count: () => count,
		reset: () => {
			count = 0
		},
		restore: () => {
			globalThis.RegExp = original
		},
	}
}

/** patterns 数 N の within visibility を literal で組む (WithinPattern shape は 3 field)。 */
function buildVisibility(patternCount) {
	const patterns = []
	for (let i = 0; i < patternCount; i++) {
		patterns.push({
			raw: `allowed:ns${i}/**`,
			targetType: i % 2 === 0 ? '*' : 'function',
			regex: `^allowed:ns${i}/.*$`,
		})
	}
	return { type: 'within', owner: 'owner:helper', patterns }
}

/**
 * caller candidate 20 個 : owner match (fast path、 compile 0) / pattern match
 * (途中の pattern まで compile) / no match (全 pattern を compile) の混在。
 */
function buildCallers(patternCount) {
	const callers = []
	for (let i = 0; i < CallerCandidates; i++) {
		switch (i % 5) {
			case 0:
				callers.push('owner:helper')
				break
			case 1:
			case 2:
				callers.push(`allowed:ns${i % patternCount}/deep/nested`)
				break
			default:
				callers.push(`denied:ns${i}/deep`)
		}
	}
	return callers
}

function runBenchmark() {
	const spy = createRegExpSpy()
	const results = []
	try {
		for (const patternCount of PatternCounts) {
			const visibility = buildVisibility(patternCount)
			const callers = buildCallers(patternCount)
			spy.reset()
			const start = performance.now()
			for (let i = 0; i < IterationsPerPatternCount; i++) {
				matchesVisibility(visibility, callers[i % callers.length])
			}
			const wallClockMs = performance.now() - start
			results.push({
				patternCount,
				calls: IterationsPerPatternCount,
				regExpCompiles: spy.count(),
				wallClockMs: Number(wallClockMs.toFixed(3)),
			})
		}
	} finally {
		spy.restore()
	}

	// spy の sanity check のみ (timing assert は置かない)。
	const totalCompiles = results.reduce((sum, row) => sum + row.regExpCompiles, 0)
	assert.ok(totalCompiles > 0, 'RegExp spy should observe at least one compile')

	console.log(JSON.stringify(
		{
			iterationsPerPatternCount: IterationsPerPatternCount,
			callerCandidates: CallerCandidates,
			results,
		},
		undefined,
		'\t',
	))
}

// `node --test` 配下では workload を実行しない (unit test suite への混入防止)。
// default isolation (child-v8) は NODE_TEST_CONTEXT、 --experimental-test-isolation=none
// は execArgv の `--test` で検出する。
const isUnderTestRunner = process.env.NODE_TEST_CONTEXT !== undefined
	|| process.execArgv.includes('--test')
if (!isUnderTestRunner) {
	runBenchmark()
}
