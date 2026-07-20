import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { toSymbolKey } from '../lib/graph.js'
import { runImpDocLint } from '../lib/runner.js'
import { scanMcfunctionFiles } from '../lib/scanner.js'

interface RawCache {
	contextHash: string
	manifest: { files: Record<string, { exports: { key: string }[] }> }
	symbols: Record<string, Record<string, unknown>>
}

describe('sequence canonical category across cache lifecycles', () => {
	let projectDir: string
	let functionsDir: string
	let declarer: string
	let cachePath: string

	beforeEach(async () => {
		projectDir = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-cli-sequence-'))
		functionsDir = join(projectDir, 'data', 'example', 'functions')
		await mkdir(functionsDir, { recursive: true })
		declarer = join(functionsDir, 'declares.mcfunction')
		await writeFile(
			declarer,
			'#> example:declares\n# @public\n\n'
				+ '#> Sequence declaration\n# @public\n    #declare sequence Seq.One\n\n'
				+ 'say declares\n',
		)
		cachePath = join(projectDir, '.tsb-lint-cache.json')
	})

	afterEach(async () => {
		await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
	})

	async function run() {
		const files = await scanMcfunctionFiles(projectDir)
		return runImpDocLint(files, {
			targetDir: projectDir,
			parallel: 2,
			cachePath,
		})
	}

	async function readCache(): Promise<RawCache> {
		return JSON.parse(await readFile(cachePath, 'utf8')) as RawCache
	}

	function assertCanonicalOnly(cache: RawCache): void {
		assert.ok(
			cache.symbols['random_sequence']?.['Seq.One'],
			'expected the declaration to land in the canonical random_sequence table',
		)
		assert.equal(
			cache.symbols['sequence'],
			undefined,
			'expected no duplicate symbol to remain in the legacy sequence table',
		)
		const keys = cache.manifest.files[declarer]?.exports.map(entry => entry.key) ?? []
		assert.ok(keys.includes(toSymbolKey('random_sequence', ['Seq.One'])))
		assert.equal(keys.includes(toSymbolKey('sequence', ['Seq.One'])), false)
	}

	it('consolidates #declare sequence into random_sequence on cold and warm runs', async () => {
		const cold = await run()
		assert.equal(cold.cacheHit, false)
		assertCanonicalOnly(await readCache())

		const warm = await run()
		assert.equal(warm.cacheHit, true)
		assert.deepEqual(warm.diagnostics, cold.diagnostics)
		assertCanonicalOnly(await readCache())
	})

	it('drops a stale cache whose context hash predates the consolidation', async () => {
		await run()
		// A cache written before the version bump carries a different context
		// hash (contextHash embeds ImpDocVersion) and possibly a legacy
		// `sequence` table. It must be discarded wholesale so the two tables
		// can never coexist after a warm reload.
		const stale = await readCache()
		stale.contextHash = 'pre-consumer-parity'
		stale.symbols['sequence'] = {
			'Seq.One': { category: 'sequence', identifier: 'Seq.One', path: ['Seq.One'] },
		}
		await writeFile(cachePath, JSON.stringify(stale))

		const rerun = await run()
		assert.equal(rerun.cacheHit, false)
		assert.equal(rerun.fullScan, true)
		assertCanonicalOnly(await readCache())
	})
})
