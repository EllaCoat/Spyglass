import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { rawCacheToken, writeCacheAtomically } from '../lib/cache-file.js'
import { createDependencyGraph, expandAffectedFiles, toSymbolKey } from '../lib/graph.js'
import { isPerFileManifest, type PerFileManifest } from '../lib/manifest.js'
import { runImpDocLint } from '../lib/runner.js'
import { scanMcfunctionFiles } from '../lib/scanner.js'

function fixtureManifest(): PerFileManifest {
	const generation = 3
	const a = toSymbolKey('function', ['example:a'])
	const b = toSymbolKey('function', ['example:b'])
	return {
		generation,
		files: {
			'a.mcfunction': {
				generation,
				sha1: 'a'.repeat(40),
				parse: { bytes: 1, lines: 1, parserErrors: 0 },
				exports: [{
					category: 'function',
					path: ['example:a'],
					key: a,
					usage: ['declaration'],
				}],
				references: [],
				diagnostics: [],
			},
			'b.mcfunction': {
				generation,
				sha1: 'b'.repeat(40),
				parse: { bytes: 1, lines: 1, parserErrors: 0 },
				exports: [{
					category: 'function',
					path: ['example:b'],
					key: b,
					usage: ['declaration'],
				}],
				references: [a],
				diagnostics: [],
			},
			'c.mcfunction': {
				generation,
				sha1: 'c'.repeat(40),
				parse: { bytes: 1, lines: 1, parserErrors: 0 },
				exports: [],
				references: [b],
				diagnostics: [],
			},
		},
	}
}

describe('incremental manifest and dependency graph', () => {
	it('validates the generation fence and expands transitive reverse dependencies', () => {
		const manifest = fixtureManifest()
		assert.equal(isPerFileManifest(manifest, 3), true)
		assert.equal(isPerFileManifest(manifest, 4), false)

		const graph = createDependencyGraph(manifest)
		assert.deepEqual(graph.dependents[toSymbolKey('function', ['example:a'])], [
			'b.mcfunction',
		])
		assert.deepEqual(
			[...expandAffectedFiles(['a.mcfunction'], [], manifest, graph)].sort(),
			['a.mcfunction', 'b.mcfunction', 'c.mcfunction'],
		)
	})

	it('terminates with deterministic affected sets for mutual and self references', () => {
		const mutual = fixtureManifest()
		const a = toSymbolKey('function', ['example:a'])
		const b = toSymbolKey('function', ['example:b'])
		mutual.files['a.mcfunction'].references = [b]
		mutual.files['b.mcfunction'].references = [a]
		mutual.files['c.mcfunction'].references = []
		assert.deepEqual(
			[...expandAffectedFiles(
				['a.mcfunction'],
				[],
				mutual,
				createDependencyGraph(mutual),
			)].sort(),
			['a.mcfunction', 'b.mcfunction'],
		)

		const self = fixtureManifest()
		self.files['a.mcfunction'].references = [a]
		self.files['b.mcfunction'].references = []
		self.files['c.mcfunction'].references = []
		assert.deepEqual(
			[...expandAffectedFiles(
				['a.mcfunction'],
				[],
				self,
				createDependencyGraph(self),
			)].sort(),
			['a.mcfunction'],
		)
	})
})

describe('incremental runner cache', () => {
	let cachePath: string
	let projectDir: string
	let privateFile: string

	beforeEach(async () => {
		projectDir = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-cli-'))
		const functionsDir = join(projectDir, 'data', 'example', 'functions')
		await mkdir(functionsDir, { recursive: true })
		cachePath = join(projectDir, '.tsb-lint-cache.json')
		privateFile = join(functionsDir, 'private.mcfunction')
		await Promise.all([
			writeFile(privateFile, '#> example:private\n# @private\n\nsay private\n'),
			writeFile(
				join(functionsDir, 'caller.mcfunction'),
				'#> example:caller\n# @public\n\nfunction example:private\n',
			),
			writeFile(
				join(functionsDir, 'independent.mcfunction'),
				'#> example:independent\n# @public\n\nsay independent\n',
			),
		])
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

	function cachedDiagnostics(raw: string): unknown {
		const value = JSON.parse(raw) as {
			manifest: { files: Record<string, { diagnostics: unknown }> }
		}
		return Object.fromEntries(
			Object.entries(value.manifest.files)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([file, entry]) => [file, entry.diagnostics]),
		)
	}

	it(
		'processes changed files and dependents, then produces a deterministic warm no-op',
		async () => {
			const cold = await run()
			assert.equal(cold.fullScan, true)
			assert.equal(cold.filesProcessed, 3)
			assert.equal(
				cold.diagnostics.filter(diagnostic => diagnostic.rule === 'impDocPrivate').length,
				1,
			)

			const warmNoop = await run()
			assert.equal(warmNoop.cacheHit, true)
			assert.equal(warmNoop.filesProcessed, 0)
			assert.deepEqual(warmNoop.diagnostics, cold.diagnostics)

			await writeFile(privateFile, '#> example:private\n# @public\n\nsay private\n')
			const changed = await run()
			assert.equal(changed.fullScan, false)
			assert.equal(changed.filesProcessed, 2)
			assert.deepEqual(changed.diagnostics, [])
			const afterChanged = await readFile(cachePath, 'utf8')

			const repeated = await run()
			assert.equal(repeated.cacheHit, true)
			assert.equal(repeated.filesProcessed, 0)
			assert.deepEqual(repeated.diagnostics, changed.diagnostics)
			const afterRepeated = await readFile(cachePath, 'utf8')
			assert.deepEqual(
				cachedDiagnostics(afterRepeated),
				cachedDiagnostics(afterChanged),
			)
		},
	)

	it('falls back to a full scan for malformed cache data and generation mismatch', async () => {
		await run()
		await writeFile(cachePath, '{ malformed cache')
		const malformed = await run()
		assert.equal(malformed.fullScan, true)
		assert.equal(malformed.filesProcessed, 3)

		const cache = JSON.parse(await readFile(cachePath, 'utf8')) as {
			generation: number
			manifest: { files: Record<string, { generation: number }> }
		}
		const entry = Object.values(cache.manifest.files)[0]
		assert.ok(entry)
		entry.generation = cache.generation + 1
		await writeFile(cachePath, JSON.stringify(cache))

		const mismatched = await run()
		assert.equal(mismatched.fullScan, true)
		assert.equal(mismatched.filesProcessed, 3)
	})

	it('falls back to a full scan when an export key is not canonical', async () => {
		await run()
		const cache = JSON.parse(await readFile(cachePath, 'utf8')) as {
			manifest: {
				files: Record<string, { exports: { key: string }[] }>
			}
		}
		const exported = Object.values(cache.manifest.files)
			.flatMap(entry => entry.exports)[0]
		assert.ok(exported)
		exported.key = 'corrupted-symbol-key'
		await writeFile(cachePath, JSON.stringify(cache))

		const result = await run()
		assert.equal(result.fullScan, true)
		assert.equal(result.filesProcessed, 3)
	})

	it(
		'uses raw-byte tokens and permits only one process-local writer for a shared token',
		{ timeout: 2_000 },
		async () => {
			const first = Buffer.from([0x80])
			const second = Buffer.from([0x81])
			assert.equal(first.toString('utf8'), second.toString('utf8'))
			assert.notEqual(rawCacheToken(first), rawCacheToken(second))

			await writeFile(cachePath, first)
			const expectedToken = rawCacheToken(first)
			await writeFile(cachePath, second)
			assert.equal(
				await writeCacheAtomically(cachePath, expectedToken, '{"replacement":true}'),
				false,
			)
			assert.deepEqual(await readFile(cachePath), second)

			const sharedToken = rawCacheToken(second)
			const replacements = ['{"writer":1}', '{"writer":2}']
			const results = await Promise.all(
				replacements.map(content => writeCacheAtomically(cachePath, sharedToken, content)),
			)
			assert.deepEqual([...results].sort(), [false, true])
			assert.ok(replacements.includes(await readFile(cachePath, 'utf8')))
			assert.equal(
				(await readdir(projectDir)).some(name =>
					name.endsWith('.tmp') || name.endsWith('.lock')
				),
				false,
			)
		},
	)
})
