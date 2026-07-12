import * as core from '@spyglassmc/core'

export const AssetProfilerSchemaVersion = 1 as const

export const AssetProfilerIds = [
	'project#ready#parse',
	'project#ready#bind',
	'project#check',
	'project#lint',
] as const

export const AssetGateThresholds = {
	phase0RegressionRatio: 1.2,
	trueNoopMs: 1_000,
	oneFileSemanticChangeMs: 5_000,
} as const

export type AssetProfilerPattern =
	| { cacheState: 'cold' }
	| { cacheState: 'warm' }
	| {
		cacheState: 'warm-noop'
		changeKind: 'true-noop' | 'one-file-semantic-change' | 'one-file-contract-change'
	}

export interface AssetProfilerRunMetadata {
	runId: string
	phase: string
	pattern: AssetProfilerPattern
	generatedAt: string
}

export interface AssetProfilerOutput extends AssetProfilerRunMetadata {
	schemaVersion: typeof AssetProfilerSchemaVersion
	profilers: core.ProfilerSummary[]
}

function aggregateProfilerSummaries(
	summaries: readonly core.ProfilerSummary[],
): core.ProfilerSummary[] {
	const grouped = new Map<string, core.ProfilerSummary[]>()
	for (const summary of summaries) {
		const key = `${summary.id}\0${summary.style}`
		const values = grouped.get(key) ?? []
		values.push(summary)
		grouped.set(key, values)
	}

	return [...grouped.values()].map((values) => {
		const first = values[0]
		const totalTasks = values.reduce((sum, value) => sum + value.totalTasks, 0)
		const totalMs = values.reduce((sum, value) => sum + value.totalMs, 0)
		const nonEmpty = values.filter(value => value.totalTasks > 0)
		const topN = first.style === 'top-n'
			? Math.max(...values.map(value => value.topN ?? value.tasks.length))
			: undefined
		const sortedTasks = values
			.flatMap(value => value.tasks)
			.sort((a, b) => b.durationMs - a.durationMs)
		const tasks = topN === undefined ? sortedTasks : sortedTasks.slice(0, topN)
		return {
			id: first.id,
			style: first.style,
			totalTasks,
			totalMs,
			minMs: nonEmpty.length === 0 ? 0 : Math.min(...nonEmpty.map(value => value.minMs)),
			avgMs: totalTasks === 0 ? 0 : totalMs / totalTasks,
			maxMs: nonEmpty.length === 0 ? 0 : Math.max(...nonEmpty.map(value => value.maxMs)),
			tasks,
			...(topN === undefined ? {} : { topN }),
		}
	})
}

/** Collects structured summaries from the core profiler without performing file-system I/O. */
export class AssetProfilerSession {
	readonly factory: core.ProfilerFactory
	readonly #summaries: core.ProfilerSummary[] = []

	constructor(
		private readonly metadata: AssetProfilerRunMetadata,
		logger: core.Logger = core.Logger.noop(),
		enabledProfilers: readonly string[] = AssetProfilerIds,
	) {
		this.factory = new core.ProfilerFactory(
			logger,
			[...enabledProfilers],
			summary => this.#summaries.push(summary),
		)
	}

	toOutput(): AssetProfilerOutput {
		return {
			schemaVersion: AssetProfilerSchemaVersion,
			...this.metadata,
			profilers: aggregateProfilerSummaries(this.#summaries),
		}
	}

	toJSON(): string {
		return JSON.stringify(this.toOutput(), undefined, 2)
	}
}

export interface WalltimeGateResult {
	name: 'phase-0-regression' | 'phase-1-improvement' | 'true-noop' | 'one-file-semantic-change'
	pass: boolean
	actualMs: number
	thresholdMs: number
	comparison: '<=' | '<'
}

function assertWalltime(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new RangeError(`${name} must be a finite, non-negative number`)
	}
}

/** Gate (i): the observed cold walltime must be at most 120% of the Phase 0 baseline. */
export function evaluatePhase0RegressionGate(
	walltimeMs: number,
	phase0BaselineMs: number,
): WalltimeGateResult {
	assertWalltime(walltimeMs, 'walltimeMs')
	assertWalltime(phase0BaselineMs, 'phase0BaselineMs')
	const thresholdMs = phase0BaselineMs * AssetGateThresholds.phase0RegressionRatio
	return {
		name: 'phase-0-regression',
		pass: walltimeMs <= thresholdMs,
		actualMs: walltimeMs,
		thresholdMs,
		comparison: '<=',
	}
}

/** Gate (ii): the observed walltime must be strictly lower than its Phase 1 baseline. */
export function evaluatePhase1ImprovementGate(
	walltimeMs: number,
	phase1BaselineMs: number,
): WalltimeGateResult {
	assertWalltime(walltimeMs, 'walltimeMs')
	assertWalltime(phase1BaselineMs, 'phase1BaselineMs')
	return {
		name: 'phase-1-improvement',
		pass: walltimeMs < phase1BaselineMs,
		actualMs: walltimeMs,
		thresholdMs: phase1BaselineMs,
		comparison: '<',
	}
}

export interface WarmNoopGateResult {
	pass: boolean
	trueNoop: WalltimeGateResult
	oneFileSemanticChange: WalltimeGateResult
}

/** Gate (iii): both absolute warm-noop targets use strict upper bounds. */
export function evaluateWarmNoopGate(
	trueNoopMs: number,
	oneFileSemanticChangeMs: number,
): WarmNoopGateResult {
	assertWalltime(trueNoopMs, 'trueNoopMs')
	assertWalltime(oneFileSemanticChangeMs, 'oneFileSemanticChangeMs')
	const trueNoop: WalltimeGateResult = {
		name: 'true-noop',
		pass: trueNoopMs < AssetGateThresholds.trueNoopMs,
		actualMs: trueNoopMs,
		thresholdMs: AssetGateThresholds.trueNoopMs,
		comparison: '<',
	}
	const oneFileSemanticChange: WalltimeGateResult = {
		name: 'one-file-semantic-change',
		pass: oneFileSemanticChangeMs < AssetGateThresholds.oneFileSemanticChangeMs,
		actualMs: oneFileSemanticChangeMs,
		thresholdMs: AssetGateThresholds.oneFileSemanticChangeMs,
		comparison: '<',
	}
	return {
		pass: trueNoop.pass && oneFileSemanticChange.pass,
		trueNoop,
		oneFileSemanticChange,
	}
}

export interface AssetGateInput {
	coldWalltimeMs: number
	phase0ColdBaselineMs: number
	phase1ColdBaselineMs: number
	trueNoopMs: number
	oneFileSemanticChangeMs: number
}

export interface AssetGateResult {
	pass: boolean
	phase0Regression: WalltimeGateResult
	phase1Improvement: WalltimeGateResult
	warmNoop: WarmNoopGateResult
}

export function evaluateAssetGates(input: AssetGateInput): AssetGateResult {
	const phase0Regression = evaluatePhase0RegressionGate(
		input.coldWalltimeMs,
		input.phase0ColdBaselineMs,
	)
	const phase1Improvement = evaluatePhase1ImprovementGate(
		input.coldWalltimeMs,
		input.phase1ColdBaselineMs,
	)
	const warmNoop = evaluateWarmNoopGate(input.trueNoopMs, input.oneFileSemanticChangeMs)
	return {
		pass: phase0Regression.pass && phase1Improvement.pass && warmNoop.pass,
		phase0Regression,
		phase1Improvement,
		warmNoop,
	}
}

export interface ProfilerHotspot {
	rank: number
	name: string
	durationMs: number
	sharePercent: number
}

export interface ProfilerRegressionDeltas {
	phase1FromPhase0Ms: number
	phase2FromPhase1Ms: number
	currentFromPhase2Ms: number
}

export interface ProfilerHotspotStage {
	id: string
	totalMs: {
		phase0: number
		phase1: number
		phase2: number
		current: number
	}
	regression: ProfilerRegressionDeltas
	top: ProfilerHotspot[]
}

export interface AssetHotspotReport {
	pattern: AssetProfilerPattern
	stages: ProfilerHotspotStage[]
}

export interface AssetHotspotInput {
	phase0: AssetProfilerOutput
	phase1: AssetProfilerOutput
	phase2: AssetProfilerOutput
	current: AssetProfilerOutput
	topN?: number
}

function patternKey(pattern: AssetProfilerPattern): string {
	return JSON.stringify(pattern)
}

function profilerById(output: AssetProfilerOutput): Map<string, core.ProfilerSummary> {
	return new Map(output.profilers.map(summary => [summary.id, summary]))
}

/** Builds the Phase 1/Phase 2 attribution frame once same-pattern profiler data is available. */
export function buildAssetHotspotReport(input: AssetHotspotInput): AssetHotspotReport {
	const expectedPattern = patternKey(input.current.pattern)
	for (const output of [input.phase0, input.phase1, input.phase2]) {
		if (patternKey(output.pattern) !== expectedPattern) {
			throw new Error('Hotspot inputs must use the same profiler pattern')
		}
	}
	const topN = input.topN ?? 10
	if (!Number.isSafeInteger(topN) || topN < 1) {
		throw new RangeError('topN must be a positive integer')
	}

	const phase0 = profilerById(input.phase0)
	const phase1 = profilerById(input.phase1)
	const phase2 = profilerById(input.phase2)
	const current = profilerById(input.current)
	const ids = new Set([...phase0.keys(), ...phase1.keys(), ...phase2.keys(), ...current.keys()])
	const stages = [...ids].sort().map((id): ProfilerHotspotStage => {
		const phase0Ms = phase0.get(id)?.totalMs ?? 0
		const phase1Ms = phase1.get(id)?.totalMs ?? 0
		const phase2Ms = phase2.get(id)?.totalMs ?? 0
		const currentSummary = current.get(id)
		const currentMs = currentSummary?.totalMs ?? 0
		return {
			id,
			totalMs: {
				phase0: phase0Ms,
				phase1: phase1Ms,
				phase2: phase2Ms,
				current: currentMs,
			},
			regression: {
				phase1FromPhase0Ms: phase1Ms - phase0Ms,
				phase2FromPhase1Ms: phase2Ms - phase1Ms,
				currentFromPhase2Ms: currentMs - phase2Ms,
			},
			top: (currentSummary?.tasks ?? []).slice(0, topN).map((task, index) => ({
				rank: index + 1,
				name: task.name,
				durationMs: task.durationMs,
				sharePercent: currentMs === 0 ? 0 : task.durationMs / currentMs * 100,
			})),
		}
	})
	return { pattern: input.current.pattern, stages }
}
