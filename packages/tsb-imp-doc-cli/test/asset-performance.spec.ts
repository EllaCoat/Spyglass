import * as core from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
	AssetProfilerIds,
	type AssetProfilerOutput,
	type AssetProfilerPattern,
	AssetProfilerSession,
	buildAssetHotspotReport,
	evaluateAssetGates,
	evaluatePhase0RegressionGate,
	evaluatePhase1ImprovementGate,
	evaluateWarmNoopGate,
} from '../lib/assetPerformance.js'
import { runImpDocLint, SerializeManifestProfilerId, SerializeProfilerId } from '../lib/runner.js'
import { scanMcfunctionFiles } from '../lib/scanner.js'

const FixtureDir = fileURLToPath(
	new URL('../../tsb-imp-doc/test/fixtures/', import.meta.url),
)

function metadata(pattern: AssetProfilerPattern) {
	return {
		runId: `fixture-${pattern.cacheState}`,
		phase: 'phase-5b-test',
		pattern,
		generatedAt: '2026-07-12T00:00:00.000Z',
	}
}

function profilerOutput(phase: string, totalMs: number): AssetProfilerOutput {
	return {
		schemaVersion: 1,
		runId: phase,
		phase,
		pattern: { cacheState: 'cold' },
		generatedAt: '2026-07-12T00:00:00.000Z',
		profilers: [{
			id: 'project#ready#parse',
			style: 'top-n',
			totalTasks: 1,
			totalMs,
			minMs: totalMs,
			avgMs: totalMs,
			maxMs: totalMs,
			tasks: [{ name: 'file:///fixture.mcfunction', durationMs: totalMs }],
			topN: 10,
		}],
	}
}

describe('Phase 5b Asset profiler', () => {
	it('serializes cold, warm, and warm-noop patterns', () => {
		const patterns: AssetProfilerPattern[] = [
			{ cacheState: 'cold' },
			{ cacheState: 'warm' },
			{ cacheState: 'warm-noop', changeKind: 'true-noop' },
			{ cacheState: 'warm-noop', changeKind: 'one-file-semantic-change' },
		]
		for (const pattern of patterns) {
			const session = new AssetProfilerSession(metadata(pattern))
			session.factory.get('project#ready#parse', 'top-n', 2)
				.task('file:///fixture.mcfunction')
				.finalize()
			const output = JSON.parse(session.toJSON()) as AssetProfilerOutput
			assert.equal(output.schemaVersion, 1)
			assert.deepEqual(output.pattern, pattern)
			assert.equal(output.profilers[0].id, 'project#ready#parse')
			assert.equal(output.profilers[0].totalTasks, 1)
			assert.equal(output.profilers[0].tasks[0].name, 'file:///fixture.mcfunction')
		}
	})

	it('starts all stage profilers and emits output for the CLI fixture', async () => {
		const files = await scanMcfunctionFiles(FixtureDir)
		const session = new AssetProfilerSession(metadata({ cacheState: 'cold' }))
		const result = await runImpDocLint(files, {
			targetDir: FixtureDir,
			parallel: 2,
			skipUnresolved: true,
			profilers: session.factory,
		})

		assert.equal(result.filesScanned, 13)
		const output = session.toOutput()
		assert.deepEqual(
			output.profilers.map(profiler => profiler.id),
			AssetProfilerIds,
		)
		for (const profiler of output.profilers) {
			assert.equal(profiler.totalTasks, 13)
			assert.ok(profiler.tasks.length > 0)
		}
	})
})

describe('serialize stage profiler', () => {
	const SerializeTaskNames = [
		'Build manifest / collect exports',
		'Build dependency graph',
		'Checksum barrier',
		'Unlink symbol table',
		'JSON.stringify',
		'Atomic cache write',
	]

	let tempDir: string

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-cli-profiler-'))
	})

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
	})

	function createSession() {
		const summaries: core.ProfilerSummary[] = []
		const factory = new core.ProfilerFactory(
			core.Logger.noop(),
			[SerializeProfilerId, SerializeManifestProfilerId],
			summary => summaries.push(summary),
		)
		return { factory, summaries }
	}

	function serializeTasks(summaries: readonly core.ProfilerSummary[]): string[] {
		const summary = summaries.find(candidate => candidate.id === SerializeProfilerId)
		assert.ok(summary)
		return summary.tasks.map(task => task.name)
	}

	it('records all six serialize tasks when the cache is written', async () => {
		const files = await scanMcfunctionFiles(FixtureDir)
		const { factory, summaries } = createSession()
		await runImpDocLint(files, {
			targetDir: FixtureDir,
			parallel: 2,
			skipUnresolved: true,
			cachePath: join(tempDir, 'cache.json'),
			profilers: factory,
		})

		assert.deepEqual(serializeTasks(summaries), SerializeTaskNames)
		const manifest = summaries.find(candidate => candidate.id === SerializeManifestProfilerId)
		assert.ok(manifest)
		assert.equal(manifest.style, 'top-n')
		assert.equal(manifest.totalTasks, 13)
	})

	it('stops after the dependency graph when no cache path is configured', async () => {
		const files = await scanMcfunctionFiles(FixtureDir)
		const { factory, summaries } = createSession()
		await runImpDocLint(files, {
			targetDir: FixtureDir,
			parallel: 2,
			skipUnresolved: true,
			profilers: factory,
		})

		assert.deepEqual(serializeTasks(summaries), SerializeTaskNames.slice(0, 2))
	})

	it('stops after the checksum barrier when an input could not be read', async () => {
		const files = await scanMcfunctionFiles(FixtureDir)
		const { factory, summaries } = createSession()
		await runImpDocLint([...files, join(FixtureDir, 'missing.mcfunction')], {
			targetDir: FixtureDir,
			parallel: 2,
			skipUnresolved: true,
			cachePath: join(tempDir, 'cache.json'),
			profilers: factory,
		})

		assert.deepEqual(serializeTasks(summaries), SerializeTaskNames.slice(0, 3))
	})

	it('records the atomic write task even when publication fails', async () => {
		const files = await scanMcfunctionFiles(FixtureDir)
		const { factory, summaries } = createSession()
		// A directory as the cache path makes writeCacheAtomically fail closed.
		await runImpDocLint(files, {
			targetDir: FixtureDir,
			parallel: 2,
			skipUnresolved: true,
			cachePath: tempDir,
			profilers: factory,
		})

		assert.deepEqual(serializeTasks(summaries), SerializeTaskNames)
	})
})

describe('Phase 5b Asset gates', () => {
	it('applies the Phase 0 +20% inclusive boundary', () => {
		assert.equal(evaluatePhase0RegressionGate(1_200, 1_000).pass, true)
		assert.equal(evaluatePhase0RegressionGate(1_200.01, 1_000).pass, false)
	})

	it('requires a strict improvement from Phase 1', () => {
		assert.equal(evaluatePhase1ImprovementGate(999.99, 1_000).pass, true)
		assert.equal(evaluatePhase1ImprovementGate(1_000, 1_000).pass, false)
	})

	it('applies strict absolute warm-noop boundaries', () => {
		assert.equal(evaluateWarmNoopGate(999.99, 4_999.99).pass, true)
		assert.equal(evaluateWarmNoopGate(1_000, 4_999.99).pass, false)
		assert.equal(evaluateWarmNoopGate(999.99, 5_000).pass, false)
	})

	it('passes only when all three gate groups pass', () => {
		assert.equal(
			evaluateAssetGates({
				coldWalltimeMs: 450_000,
				phase0ColdBaselineMs: 394_420,
				phase1ColdBaselineMs: 500_000,
				trueNoopMs: 900,
				oneFileSemanticChangeMs: 4_000,
			}).pass,
			true,
		)
		assert.equal(
			evaluateAssetGates({
				coldWalltimeMs: 500_000,
				phase0ColdBaselineMs: 394_420,
				phase1ColdBaselineMs: 500_000,
				trueNoopMs: 900,
				oneFileSemanticChangeMs: 4_000,
			}).pass,
			false,
		)
	})

	it('rejects invalid walltime input', () => {
		assert.throws(() => evaluateWarmNoopGate(Number.NaN, 1), RangeError)
		assert.throws(() => evaluatePhase0RegressionGate(-1, 1), RangeError)
	})
})

describe('Phase 5b hotspot report', () => {
	it('separates Phase 1 and Phase 2 deltas and keeps a top-n frame', () => {
		const report = buildAssetHotspotReport({
			phase0: profilerOutput('phase-0', 100),
			phase1: profilerOutput('phase-1', 120),
			phase2: profilerOutput('phase-2', 150),
			current: profilerOutput('phase-5b', 140),
			topN: 1,
		})

		assert.equal(report.stages.length, 1)
		assert.deepEqual(report.stages[0].regression, {
			phase1FromPhase0Ms: 20,
			phase2FromPhase1Ms: 30,
			currentFromPhase2Ms: -10,
		})
		assert.deepEqual(report.stages[0].top, [{
			rank: 1,
			name: 'file:///fixture.mcfunction',
			durationMs: 140,
			sharePercent: 100,
		}])
	})
})
