import * as core from '@spyglassmc/core'
import { NodeJsExternals } from '@spyglassmc/core/lib/nodejs.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

const BinaryPngBytes = new Uint8Array([
	0x89,
	0x50,
	0x4e,
	0x47,
	0x0d,
	0x0a,
	0x1a,
	0x0a,
	0x00,
	0xff,
	0xfe,
	0x80,
])

interface SerializedCacheFixture {
	checksums: {
		fileContents: Record<string, string>
		files: Record<string, string>
	}
	contextHash: string
	initializerHash: string
	lintHash?: string
	version: number
}

class FixtureWatcher extends core.EventDispatcher<core.FileWatcherEventMap>
	implements core.FileWatcher
{
	readonly watchedFiles = new core.UriStore()

	constructor(uri: string) {
		super()
		this.watchedFiles.add(uri)
	}

	async ready(): Promise<void> {}

	async close(): Promise<void> {}
}

describe('CacheService binary file hashing (#1706)', () => {
	let cacheDir: string
	let projectDir: string
	let binaryUri: string

	beforeEach(async () => {
		// realpath resolves Windows 8.3 short names (e.g. `RUNNER~1` on GitHub Actions runners)
		// so that fixture URIs match the long form used by Node internally, avoiding
		// `%7E` vs `~` URL encoding mismatches when cache keys are compared.
		cacheDir = await realpath(await mkdtemp(join(tmpdir(), 'spyglass-binary-cache-')))
		projectDir = await realpath(await mkdtemp(join(tmpdir(), 'spyglass-binary-project-')))
		// Canonicalize fixture URIs with core.normalizeUri (lowercases Windows drive letters,
		// like UriStore does for watched files) so that projectRoots, watcher entries, and
		// assertions all compare the same URI form. See core/common/util.ts#normalizeUriPathname.
		binaryUri = core.normalizeUri(pathToFileURL(join(projectDir, 'fixture.png')).toString())
		await writeFile(new URL(binaryUri), BinaryPngBytes)
	})

	afterEach(async () => {
		await Promise.all([
			rm(cacheDir, { recursive: true, force: true }),
			rm(projectDir, { recursive: true, force: true }),
		])
	})

	function createProject(
		externals: core.Externals = NodeJsExternals,
		extraProjectRoot?: core.RootUriString,
	): core.Project {
		const initializer: core.ProjectInitializer = ({ meta }) => {
			meta.registerLanguage('png', { extensions: ['.png'] })
			return { binaryFixture: 'v1' }
		}
		return new core.Project({
			cacheRoot: core.fileUtil.ensureEndingSlash(
				core.normalizeUri(pathToFileURL(cacheDir).toString()),
			),
			defaultConfig: core.ConfigService.merge(core.VanillaConfig, {
				env: { dependencies: [], exclude: [] },
			}),
			externals,
			initializers: [initializer],
			logger: core.Logger.noop(),
			projectRoots: [
				core.fileUtil.ensureEndingSlash(
					core.normalizeUri(pathToFileURL(projectDir).toString()),
				),
				...extraProjectRoot ? [extraProjectRoot] : [],
			],
		})
	}

	async function getCacheFilePath(): Promise<string> {
		const symbolsDir = join(cacheDir, 'symbols')
		const entries = await readdir(symbolsDir)
		const cacheFiles = entries.filter(entry => entry.endsWith('.json.gz'))
		assert.equal(cacheFiles.length, 1)
		return join(symbolsDir, cacheFiles[0])
	}

	async function readCacheFile(): Promise<SerializedCacheFixture> {
		return JSON.parse(
			gunzipSync(await readFile(await getCacheFilePath())).toString(),
		) as SerializedCacheFixture
	}

	async function writeCacheFile(cache: SerializedCacheFixture): Promise<void> {
		await writeFile(await getCacheFilePath(), gzipSync(JSON.stringify(cache)))
	}

	async function readyProject(project: core.Project): Promise<void> {
		await project.init()
		await project.ready({ projectRootsWatcher: new FixtureWatcher(binaryUri) })
	}

	it('does not report an unchanged binary file as changed after cache reload', async () => {
		assert.equal(core.LatestCacheVersion, 9)

		const first = createProject()
		try {
			await first.init()
			await first.ready({ projectRootsWatcher: new FixtureWatcher(binaryUri) })
		} finally {
			// close() must wait for the raw-byte checksum started by documentUpdated.
			await first.close()
		}

		const second = createProject()
		try {
			await second.init()
			// fs.hash requires file: supporter (registered in ready()); compute raw hash
			// via crypto directly so we can verify persistence before ready().
			const rawBytes = await second.externals.fs.readFile(binaryUri)
			const expectedHash = createHash('sha1').update(rawBytes).digest('hex')
			assert.equal(
				second.cacheService.checksums.files[binaryUri],
				expectedHash,
				`Persisted checksum must hash the raw bytes. binaryUri=${binaryUri} keys=${
					JSON.stringify(Object.keys(second.cacheService.checksums.files))
				}`,
			)

			let changedFiles: string[] | undefined
			let unchangedFiles: string[] | undefined
			const validate = second.cacheService.validate.bind(second.cacheService)
			second.cacheService.validate = async () => {
				const result = await validate()
				changedFiles = result.changedFiles
				unchangedFiles = result.unchangedFiles
				return result
			}
			await second.ready({ projectRootsWatcher: new FixtureWatcher(binaryUri) })

			assert.deepEqual(changedFiles, [])
			assert.deepEqual(unchangedFiles, [binaryUri])
		} finally {
			await second.close()
		}
	})

	it('hits the cache across casing/encoding variants of the same projectRoot', async () => {
		// The symbol cache file name is a hash over projectRoots. Both raw forms below
		// canonicalize to file:///c:/variant-root/ in the Project constructor, so the second
		// session finds the cache saved by the first one even though the client changed how
		// it encodes the drive-letter colon. The synthetic extra root never has to exist on
		// disk: it only participates in config lookup (ENOENT tolerated) and the name hash.
		const first = createProject(NodeJsExternals, 'file:///C:/variant-root/')
		// Snapshot the canonical roots before `first.close()`; accessing project state after
		// `close()` is not part of the public contract.
		let firstProjectRootsSnapshot: readonly string[] = []
		try {
			await readyProject(first)
			firstProjectRootsSnapshot = [...first.projectRoots]
		} finally {
			await first.close()
		}

		const second = createProject(NodeJsExternals, 'file:///c%3a/variant-root/')
		try {
			await second.init()
			assert.deepEqual([...second.projectRoots], firstProjectRootsSnapshot)
			const rawBytes = await second.externals.fs.readFile(binaryUri)
			const expectedHash = createHash('sha1').update(rawBytes).digest('hex')
			assert.equal(
				second.cacheService.checksums.files[binaryUri],
				expectedHash,
				'Metadata saved under the canonical hash must be found by the other variant',
			)
		} finally {
			await second.close()
		}
	})

	it('persists the v9 component hashes and separate raw/text file hashes', async () => {
		const project = createProject()
		try {
			await readyProject(project)
		} finally {
			await project.close()
		}

		const cache = await readCacheFile()
		assert.equal(cache.version, 9)
		for (const key of ['contextHash', 'initializerHash', 'lintHash'] as const) {
			const hash = cache[key]
			assert.ok(typeof hash === 'string')
			assert.match(hash, /^[0-9a-f]{40}$/)
		}
		const rawHash = createHash('sha1').update(BinaryPngBytes).digest('hex')
		const textHash = createHash('sha1')
			.update(new TextDecoder().decode(BinaryPngBytes))
			.digest('hex')
		assert.equal(cache.checksums.files[binaryUri], rawHash)
		assert.equal(cache.checksums.fileContents[binaryUri], textHash)
		assert.notEqual(rawHash, textHash)
	})

	it('rejects v8 caches, newer caches after downgrade, and incomplete v9 schemas', async () => {
		const seed = createProject()
		try {
			await readyProject(seed)
		} finally {
			await seed.close()
		}
		const validCache = await readCacheFile()

		for (
			const fixture of [
				{ name: 'v8', patch: { version: 8 } },
				{ name: 'newer v10', patch: { version: 10 } },
				{ name: 'incomplete v9', patch: { lintHash: undefined } },
			]
		) {
			const cache = structuredClone(validCache)
			Object.assign(cache, fixture.patch)
			await writeCacheFile(cache)
			const project = createProject()
			try {
				await project.init()
				assert.deepEqual(
					project.cacheService.checksums.files,
					{},
					`${fixture.name} cache must not be activated`,
				)
			} finally {
				await project.close()
			}
		}
	})

	it('does not publish a disk change before its parsed state catches up', async () => {
		const project = createProject()
		try {
			await readyProject(project)
			await writeFile(new URL(binaryUri), new Uint8Array([0x41, 0x42, 0x43]))
			assert.equal(await project.cacheService.save(), false)
		} finally {
			await project.close()
		}
	})

	it('does not persist symbols from an unsaved client-managed document', async () => {
		const project = createProject()
		try {
			await readyProject(project)
			await project.onDidOpen(binaryUri, 'png', 1, 'unsaved editor contents')
			await project.ensureClientManagedChecked(binaryUri)
			assert.equal(await project.cacheService.save(), false)
		} finally {
			await project.close()
		}
	})

	it('propagates a tracked-file read failure from save', async () => {
		const project = createProject()
		await readyProject(project)
		const readFileFromProject = project.fs.readFile.bind(project.fs)
		project.fs.readFile = async (uri) => {
			if (uri === binaryUri) {
				throw new Error('fixture read failure')
			}
			return readFileFromProject(uri)
		}
		try {
			await assert.rejects(project.cacheService.save(), /fixture read failure/)
		} finally {
			project.fs.readFile = readFileFromProject
			await project.close()
		}
	})

	it('serializes concurrent saves', async () => {
		const fs = { ...NodeJsExternals.fs }
		const externals: core.Externals = { ...NodeJsExternals, fs }
		const project = createProject(externals)
		await readyProject(project)

		const write = fs.writeFile.bind(fs)
		const firstTemporaryWrite = Promise.withResolvers<void>()
		const releaseFirstWrite = Promise.withResolvers<void>()
		let activeTemporaryWrites = 0
		let maxActiveTemporaryWrites = 0
		let temporaryWrites = 0
		fs.writeFile = async (location, data, options) => {
			if (location.toString().endsWith('.tmp')) {
				activeTemporaryWrites += 1
				maxActiveTemporaryWrites = Math.max(
					maxActiveTemporaryWrites,
					activeTemporaryWrites,
				)
				temporaryWrites += 1
				if (temporaryWrites === 1) {
					firstTemporaryWrite.resolve()
					await releaseFirstWrite.promise
				}
			}
			try {
				await write(location, data, options)
			} finally {
				if (location.toString().endsWith('.tmp')) {
					activeTemporaryWrites -= 1
				}
			}
		}

		try {
			const firstSave = project.cacheService.save()
			await firstTemporaryWrite.promise
			const secondSave = project.cacheService.save()
			releaseFirstWrite.resolve()
			assert.deepEqual(await Promise.all([firstSave, secondSave]), [true, true])
			assert.equal(maxActiveTemporaryWrites, 1)
			assert.equal(temporaryWrites, 2)
		} finally {
			fs.writeFile = write
			await project.close()
		}
	})

	it('rechecks generation after writing the temporary cache file', async () => {
		const fs = { ...NodeJsExternals.fs }
		const externals: core.Externals = { ...NodeJsExternals, fs }
		const project = createProject(externals)
		await readyProject(project)
		assert.equal(await project.cacheService.save(), true)
		const cachePath = await getCacheFilePath()
		const publishedBeforeRace = await readFile(cachePath)

		const write = fs.writeFile.bind(fs)
		const temporaryFileWritten = Promise.withResolvers<void>()
		const releaseTemporaryWrite = Promise.withResolvers<void>()
		fs.writeFile = async (location, data, options) => {
			await write(location, data, options)
			if (location.toString().endsWith('.tmp')) {
				temporaryFileWritten.resolve()
				await releaseTemporaryWrite.promise
			}
		}

		try {
			const save = project.cacheService.save()
			await temporaryFileWritten.promise
			project.cacheService.invalidatePartial('lint', [binaryUri])
			releaseTemporaryWrite.resolve()
			assert.equal(await save, false)
			assert.deepEqual(await readFile(cachePath), publishedBeforeRace)
		} finally {
			fs.writeFile = write
			await project.close()
		}
	})

	it('aborts a checksum barrier when the cache is reset', async () => {
		const project = createProject()
		await readyProject(project)
		const readFileFromProject = project.fs.readFile.bind(project.fs)
		const checksumReadStarted = Promise.withResolvers<void>()
		const releaseChecksumRead = Promise.withResolvers<void>()
		project.fs.readFile = async (uri) => {
			if (uri === binaryUri) {
				checksumReadStarted.resolve()
				await releaseChecksumRead.promise
			}
			return readFileFromProject(uri)
		}

		try {
			const save = project.cacheService.save()
			await checksumReadStarted.promise
			project.cacheService.reset()
			releaseChecksumRead.resolve()
			assert.equal(await save, false)
		} finally {
			project.fs.readFile = readFileFromProject
			await project.close()
		}
	})

	it('classifies a partially invalidated tracked URI as changed', async () => {
		const project = createProject()
		try {
			await readyProject(project)
			project.cacheService.invalidatePartial('lint', [binaryUri])
			const result = await project.cacheService.validate()
			assert.deepEqual(result.changedFiles, [binaryUri])
			assert.deepEqual(result.addedFiles, [])

			project.symbols.query(binaryUri, 'fixture', 'stale-initializer-symbol').enter({
				usage: { type: 'declaration' },
			})
			project.cacheService.checksums.roots[project.projectRoots[0]] = 'stale-root'
			project.cacheService.checksums.symbolRegistrars['stale'] = 'stale-registrar'
			assert.ok(project.symbols.lookup('fixture', ['stale-initializer-symbol']).symbol)

			project.cacheService.invalidatePartial('initializer', [])
			assert.equal(
				project.symbols.lookup('fixture', ['stale-initializer-symbol']).symbol,
				undefined,
			)
			assert.deepEqual(project.cacheService.checksums.roots, {})
			assert.deepEqual(project.cacheService.checksums.symbolRegistrars, {})
			const initializerResult = await project.cacheService.validate()
			assert.deepEqual(initializerResult.changedFiles, [binaryUri])
		} finally {
			await project.close()
		}
	})
})
