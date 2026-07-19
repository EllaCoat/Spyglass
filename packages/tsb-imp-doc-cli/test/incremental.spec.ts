import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
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

	it('accepts lean and legacy v2 export summaries, then rewrites legacy entries lean', async () => {
		const cold = await run()
		const leanCache = JSON.parse(await readFile(cachePath, 'utf8')) as {
			manifest: {
				files: Record<string, { exports: Record<string, unknown>[] }>
			}
		}
		const leanExports = Object.values(leanCache.manifest.files).flatMap(entry => entry.exports)
		assert.ok(leanExports.length > 0)
		assert.ok(leanExports.every(entry => !('data' in entry) && !('description' in entry)))

		const leanReload = await run()
		assert.equal(leanReload.cacheHit, true)
		assert.equal(leanReload.filesProcessed, 0)
		assert.deepEqual(leanReload.diagnostics, cold.diagnostics)

		for (const entry of Object.values(leanCache.manifest.files)) {
			for (const exported of entry.exports) {
				exported['data'] = { legacy: true }
				exported['description'] = 'legacy v2 metadata'
			}
		}
		await writeFile(cachePath, JSON.stringify(leanCache))

		const legacyReload = await run()
		assert.equal(legacyReload.cacheHit, true)
		assert.equal(legacyReload.filesProcessed, 0)
		assert.deepEqual(legacyReload.diagnostics, cold.diagnostics)

		await writeFile(privateFile, '#> example:private\n# @private\n\nsay private changed\n')
		const rewritten = await run()
		assert.equal(rewritten.fullScan, false)
		const rewrittenCache = JSON.parse(await readFile(cachePath, 'utf8')) as {
			manifest: {
				files: Record<string, { exports: Record<string, unknown>[] }>
			}
		}
		const rewrittenExports = Object.values(rewrittenCache.manifest.files)
			.flatMap(entry => entry.exports)
		assert.ok(rewrittenExports.every(entry => !('data' in entry) && !('description' in entry)))
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

describe('incremental legacy export discovery', () => {
	let cachePath: string
	let projectDir: string
	let functionsDir: string
	let exportFile: string
	let declarationDependent: string
	let knownAliasDependent: string
	let extensionAliasDependent: string

	beforeEach(async () => {
		projectDir = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-cli-'))
		functionsDir = join(projectDir, 'data', 'example', 'functions')
		await mkdir(functionsDir, { recursive: true })
		cachePath = join(projectDir, '.tsb-lint-cache.json')
		exportFile = join(functionsDir, 'exports.mcfunction')
		declarationDependent = join(functionsDir, 'declaration-dependent.mcfunction')
		knownAliasDependent = join(functionsDir, 'known-alias-dependent.mcfunction')
		extensionAliasDependent = join(functionsDir, 'extension-alias-dependent.mcfunction')
		await Promise.all([
			writeFile(exportFile, 'say exports\n'),
			writeFile(declarationDependent, 'function minecraft:foo\n'),
			writeFile(knownAliasDependent, 'say known alias dependent\n'),
			writeFile(extensionAliasDependent, 'say extension alias dependent\n'),
			writeFile(join(functionsDir, 'independent.mcfunction'), 'say independent\n'),
		])
	})

	afterEach(async () => {
		await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
	})

	async function run() {
		return runImpDocLint(await scanMcfunctionFiles(projectDir), {
			targetDir: projectDir,
			parallel: 2,
			cachePath,
		})
	}

	it('reprocesses a dependent for a newly added canonical #define export', async () => {
		const cold = await run()
		assert.equal(cold.fullScan, true)
		assert.equal(cold.filesProcessed, 5)

		await writeFile(
			exportFile,
			'#> example:exports\n# @public\n\n'
				+ '#> Legacy function export\n# @public\n'
				+ '    #define function #foo\n\n'
				+ 'say exports\n',
		)
		const incremental = await run()
		assert.equal(incremental.fullScan, false)
		assert.equal(incremental.filesProcessed, 2)
		assert.deepEqual(incremental.diagnostics, [])

		const cache = JSON.parse(await readFile(cachePath, 'utf8')) as {
			manifest: PerFileManifest
		}
		assert.ok(
			cache.manifest.files[exportFile]?.exports.some(entry =>
				entry.key === toSymbolKey('function', ['minecraft:foo'])
			),
		)
	})

	it('discovers and binds permissive declarations in a doc adjacent to the function header', async () => {
		await run()
		const keys = [
			toSymbolKey('score_holder', ['RW.TargetModel']),
			toSymbolKey('entity', ['@s']),
			toSymbolKey('tag', ['foo/bar']),
		]
		const cache = JSON.parse(await readFile(cachePath, 'utf8')) as {
			manifest: PerFileManifest
			graph: ReturnType<typeof createDependencyGraph>
		}
		cache.manifest.files[declarationDependent]!.references = keys
		cache.graph = createDependencyGraph(cache.manifest)
		await writeFile(cachePath, JSON.stringify(cache))

		await writeFile(
			exportFile,
			'#> example:exports\n# @public\n'
				+ '#> private\n# @private\n'
				+ '    #declare score_holder RW.TargetModel\n'
				+ '    #declare entity @s\n'
				+ '    #declare tag foo/bar\n\n'
				+ 'say exports\n',
		)
		const incremental = await run()
		assert.equal(incremental.fullScan, false)
		assert.equal(incremental.filesProcessed, 2)
		assert.deepEqual(incremental.diagnostics, [])

		const updated = JSON.parse(await readFile(cachePath, 'utf8')) as {
			manifest: PerFileManifest
		}
		const exports = updated.manifest.files[exportFile]!.exports.map(entry => entry.key)
		for (const key of keys) {
			assert.ok(exports.includes(key), key)
		}
	})

	it('reprocesses dependents for decoded known and extension alias keys', async () => {
		await run()
		const knownKey = toSymbolKey('alias/vector', ['launch vector'])
		const extensionKey = toSymbolKey('alias/selectorTemplate', ["foo'bar"])
		const cache = JSON.parse(await readFile(cachePath, 'utf8')) as {
			manifest: PerFileManifest
			graph: ReturnType<typeof createDependencyGraph>
		}
		// Phase 4-3: consumer 実装時に、この seed graph への手動 references 注入を
		// 実 reference 生成経路の end-to-end test へ置換、または追加する。
		cache.manifest.files[knownAliasDependent]!.references = [knownKey]
		cache.manifest.files[extensionAliasDependent]!.references = [extensionKey]
		cache.graph = createDependencyGraph(cache.manifest)
		await writeFile(cachePath, JSON.stringify(cache))

		await writeFile(
			exportFile,
			'#> example:exports\n# @public\n\n'
				+ '#> Legacy aliases\n# @public\n'
				+ '    #alias vector "launch vector" 0 1 2\n'
				+ "    #alias selectorTemplate 'foo\\'bar' @e\n\n"
				+ 'say exports\n',
		)
		const incremental = await run()
		assert.equal(incremental.fullScan, false)
		assert.equal(incremental.filesProcessed, 3)
		assert.deepEqual(incremental.diagnostics, [])

		const updated = JSON.parse(await readFile(cachePath, 'utf8')) as {
			manifest: PerFileManifest
		}
		const keys = updated.manifest.files[exportFile]!.exports.map(entry => entry.key)
		assert.ok(keys.includes(knownKey))
		assert.ok(keys.includes(extensionKey))
	})
})

describe('manifest exports characterization', () => {
	let cachePath: string
	let projectDir: string
	let functionsDir: string
	let privateFile: string

	beforeEach(async () => {
		projectDir = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-cli-'))
		functionsDir = join(projectDir, 'data', 'example', 'functions')
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
				join(functionsDir, 'declares.mcfunction'),
				'#> example:declares\n# @public\n\n'
					+ '#> Tag declaration\n# @public\n    #declare tag Enemy.Boss\n\n'
					+ '#> Storage declaration\n# @private\n    #declare storage example:data\n\n'
					+ '#> Score holder declaration\n# @public\n    #declare score_holder $Counter\n\n'
					+ 'say declares\n',
			),
			writeFile(join(functionsDir, 'noexports.mcfunction'), 'say hello\n'),
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

	async function cachedExports(): Promise<unknown> {
		const value = JSON.parse(await readFile(cachePath, 'utf8')) as {
			manifest: { files: Record<string, { exports: unknown }> }
		}
		return Object.fromEntries(
			Object.entries(value.manifest.files).map(([file, entry]) => [file, entry.exports]),
		)
	}

	/**
	 * Pinned output of the manifest `exports` field. Captured from the per-file
	 * `collectExports` implementation to guard usage filtering (`reference` is
	 * excluded) and the per-file key sort during refactors of the collection
	 * strategy.
	 */
	function expectedExports(): Record<string, unknown> {
		return {
			// References example:private, which must not surface as an export here.
			[join(functionsDir, 'caller.mcfunction')]: [{
				category: 'function',
				path: ['example:caller'],
				key: toSymbolKey('function', ['example:caller']),
				usage: ['declaration'],
			}],
			// Multiple categories in one file pin the sort by symbol key.
			[join(functionsDir, 'declares.mcfunction')]: [{
				category: 'function',
				path: ['example:declares'],
				key: toSymbolKey('function', ['example:declares']),
				usage: ['declaration'],
			}, {
				category: 'score_holder',
				path: ['$Counter'],
				key: toSymbolKey('score_holder', ['$Counter']),
				usage: ['declaration'],
			}, {
				category: 'storage',
				path: ['example:data'],
				key: toSymbolKey('storage', ['example:data']),
				usage: ['declaration'],
			}, {
				category: 'tag',
				path: ['Enemy.Boss'],
				key: toSymbolKey('tag', ['Enemy.Boss']),
				usage: ['declaration'],
			}],
			// No imp-doc header: the synthesized declaration remains a regular export.
			[join(functionsDir, 'noexports.mcfunction')]: [{
				category: 'function',
				path: ['example:noexports'],
				key: toSymbolKey('function', ['example:noexports']),
				usage: ['declaration'],
			}],
			[join(functionsDir, 'private.mcfunction')]: [{
				category: 'function',
				path: ['example:private'],
				key: toSymbolKey('function', ['example:private']),
				usage: ['declaration'],
			}],
		}
	}

	it('pins per-file exports across cold and incremental runs', async () => {
		const cold = await run()
		assert.equal(cold.fullScan, true)
		assert.equal(cold.filesProcessed, 4)
		assert.deepEqual(await cachedExports(), expectedExports())

		await writeFile(privateFile, '#> example:private\n# @private\n\nsay private again\n')
		const incremental = await run()
		assert.equal(incremental.fullScan, false)
		assert.equal(incremental.filesProcessed, 2)
		assert.deepEqual(await cachedExports(), expectedExports())
	})
})

/**
 * Multi-usage behavior of the batched export collection, pinned through real
 * runs: duplicate same-type locations collapse into a single `usage` entry,
 * `reference` locations never surface (also when they share a URI with a
 * declaration of the same symbol), and the locations of one symbol split into
 * separate per-URI buckets. The CLI pipeline only ever enters `declaration`
 * (URI binder, IMP-Doc declarations) and `reference` (checker) usages, so the
 * relative order of `definition` / `implementation` / `typeDefinition` usages
 * cannot surface through `runImpDocLint` and stays unpinned here.
 */
describe('manifest exports multi-usage characterization', () => {
	let cachePath: string
	let projectDir: string
	let functionsDir: string
	let dupFile: string

	beforeEach(async () => {
		projectDir = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-cli-'))
		functionsDir = join(projectDir, 'data', 'example', 'functions')
		await mkdir(functionsDir, { recursive: true })
		cachePath = join(projectDir, '.tsb-lint-cache.json')
		dupFile = join(functionsDir, 'dup.mcfunction')
		await Promise.all([
			writeFile(
				dupFile,
				'#> example:dup\n# @public\n\n'
					+ '#> First duplicate\n# @public\n    #declare tag Enemy.Boss\n\n'
					+ '#> Second duplicate\n# @public\n    #declare tag Enemy.Boss\n\n'
					+ 'say dup\n',
			),
			writeFile(
				join(functionsDir, 'other.mcfunction'),
				'#> example:other\n# @public\n\n'
					+ '#> Shared tag\n# @public\n    #declare tag Enemy.Boss\n\n'
					+ 'say other\n',
			),
			writeFile(
				join(functionsDir, 'selfref.mcfunction'),
				'#> example:selfref\n# @public\n\n'
					+ 'function example:selfref\nfunction example:missing\n',
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

	interface CachedSymbol {
		declaration?: { uri: string }[]
		reference?: { uri: string }[]
	}

	interface CacheContent {
		manifest: {
			files: Record<string, { exports: { key: string; usage: string[] }[] }>
		}
		symbols: Record<string, Record<string, CachedSymbol | undefined> | undefined>
	}

	async function readCache(): Promise<CacheContent> {
		return JSON.parse(await readFile(cachePath, 'utf8')) as CacheContent
	}

	async function exportSummaries(): Promise<Record<string, { key: string; usage: string[] }[]>> {
		return Object.fromEntries(
			Object.entries((await readCache()).manifest.files).map(([file, entry]) => [
				file,
				entry.exports.map(({ key, usage }) => ({ key, usage })),
			]),
		)
	}

	function expectedSummaries(): Record<string, { key: string; usage: string[] }[]> {
		return {
			[join(functionsDir, 'dup.mcfunction')]: [
				{ key: toSymbolKey('function', ['example:dup']), usage: ['declaration'] },
				{ key: toSymbolKey('tag', ['Enemy.Boss']), usage: ['declaration'] },
			],
			[join(functionsDir, 'other.mcfunction')]: [
				{ key: toSymbolKey('function', ['example:other']), usage: ['declaration'] },
				{ key: toSymbolKey('tag', ['Enemy.Boss']), usage: ['declaration'] },
			],
			[join(functionsDir, 'selfref.mcfunction')]: [{
				key: toSymbolKey('function', ['example:selfref']),
				usage: ['declaration'],
			}],
		}
	}

	it('collapses duplicate same-type locations into a single usage entry across runs', async () => {
		const cold = await run()
		assert.equal(cold.fullScan, true)
		assert.equal(cold.filesProcessed, 3)
		assert.deepEqual(cold.diagnostics, [])

		// Fixture premise: the duplicate `#declare` lines produce two declaration
		// locations at the same URI before the collection deduplicates them.
		const tag = (await readCache()).symbols['tag']?.['Enemy.Boss']
		assert.deepEqual(tag?.declaration?.map(location => location.uri), [
			pathToFileURL(dupFile).toString(),
			pathToFileURL(dupFile).toString(),
			pathToFileURL(join(functionsDir, 'other.mcfunction')).toString(),
		])
		assert.deepEqual(await exportSummaries(), expectedSummaries())

		await writeFile(
			dupFile,
			'#> example:dup\n# @public\n\n'
				+ '#> First duplicate\n# @public\n    #declare tag Enemy.Boss\n\n'
				+ '#> Second duplicate\n# @public\n    #declare tag Enemy.Boss\n\n'
				+ 'say dup again\n',
		)
		// The unchanged co-exporter of the shared tag is re-processed as well, so
		// both URI buckets are rebuilt by the batched collection in this pass.
		const incremental = await run()
		assert.equal(incremental.fullScan, false)
		assert.equal(incremental.filesProcessed, 2)
		assert.deepEqual(await exportSummaries(), expectedSummaries())
	})

	it('excludes reference usages, also when mixed with a declaration at one URI', async () => {
		await run()
		const selfrefUri = pathToFileURL(join(functionsDir, 'selfref.mcfunction')).toString()
		const cache = await readCache()

		// Fixture premise: the self call mixes declaration and reference locations
		// of one symbol at one URI, and example:missing has only references.
		const selfref = cache.symbols['function']?.['example:selfref']
		assert.deepEqual(selfref?.declaration?.map(location => location.uri), [selfrefUri])
		assert.deepEqual(selfref?.reference?.map(location => location.uri), [selfrefUri])
		const missing = cache.symbols['function']?.['example:missing']
		assert.deepEqual(missing?.declaration ?? [], [])
		assert.deepEqual(missing?.reference?.map(location => location.uri), [selfrefUri])

		assert.deepEqual(
			(await exportSummaries())[join(functionsDir, 'selfref.mcfunction')],
			[{ key: toSymbolKey('function', ['example:selfref']), usage: ['declaration'] }],
		)
	})

	it('splits the locations of one symbol into separate per-URI buckets', async () => {
		await run()
		const summaries = await exportSummaries()
		const tagKey = toSymbolKey('tag', ['Enemy.Boss'])
		assert.deepEqual(
			Object.entries(summaries)
				.filter(([, exports]) => exports.some(entry => entry.key === tagKey))
				.map(([file]) => file)
				.sort(),
			[join(functionsDir, 'dup.mcfunction'), join(functionsDir, 'other.mcfunction')],
		)
		assert.deepEqual(summaries[join(functionsDir, 'dup.mcfunction')], [
			{ key: toSymbolKey('function', ['example:dup']), usage: ['declaration'] },
			{ key: tagKey, usage: ['declaration'] },
		])
		assert.deepEqual(summaries[join(functionsDir, 'other.mcfunction')], [
			{ key: toSymbolKey('function', ['example:other']), usage: ['declaration'] },
			{ key: tagKey, usage: ['declaration'] },
		])
	})
})
