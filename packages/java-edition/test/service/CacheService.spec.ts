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
	errors?: Record<string, unknown[]>
	initializerHash: string
	lintHash?: string
	version: number
}

/** One `CacheService#save` a test observed. */
interface SaveRecord {
	options: core.SaveOptions | undefined
	result: boolean
}

class FixtureWatcher extends core.EventDispatcher<core.FileWatcherEventMap>
	implements core.FileWatcher
{
	readonly watchedFiles = new core.UriStore()

	constructor(...uris: string[]) {
		super()
		for (const uri of uris) {
			this.watchedFiles.add(uri)
		}
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
		beforeCheck?: (uri: string) => Promise<void>,
	): core.Project {
		const initializer: core.ProjectInitializer = ({ meta }) => {
			meta.registerLanguage('png', { extensions: ['.png'] })
			if (beforeCheck) {
				meta.registerChecker('file', async (_node, ctx) => beforeCheck(ctx.doc.uri))
			}
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

	async function readyProject(
		project: core.Project,
		...extraWatchedUris: string[]
	): Promise<void> {
		await project.init()
		await project.ready({
			projectRootsWatcher: new FixtureWatcher(binaryUri, ...extraWatchedUris),
		})
	}

	/** Add another fixture file to the project directory and return its canonical URI. */
	async function writeProjectFile(name: string): Promise<string> {
		const uri = core.normalizeUri(pathToFileURL(join(projectDir, name)).toString())
		await writeFile(new URL(uri), BinaryPngBytes)
		return uri
	}

	async function waitForRecordedHashes(project: core.Project, uri: string): Promise<void> {
		const deadline = Date.now() + 5000
		while (Date.now() < deadline) {
			if (
				project.cacheService.checksums.fileContents[uri] !== undefined
				&& project.cacheService.checksums.files[uri] !== undefined
			) {
				return
			}
			await new Promise<void>(resolve => setTimeout(resolve, 20))
		}
		assert.fail(`Timed out waiting for recorded hashes of ${uri}`)
	}

	it('does not report an unchanged binary file as changed after cache reload', async () => {
		assert.equal(core.LatestCacheVersion, 10)

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

	it('persists the v10 component hashes and separate raw/text file hashes', async () => {
		const project = createProject()
		try {
			await readyProject(project)
		} finally {
			await project.close()
		}

		const cache = await readCacheFile()
		assert.equal(cache.version, 10)
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

	it('rejects v9 caches, newer caches after downgrade, and incomplete v10 schemas', async () => {
		const seed = createProject()
		try {
			await readyProject(seed)
		} finally {
			await seed.close()
		}
		const validCache = await readCacheFile()

		for (
			const fixture of [
				{ name: 'v9', patch: { version: 9 } },
				{ name: 'newer v11', patch: { version: 11 } },
				{ name: 'incomplete v10', patch: { lintHash: undefined } },
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

	it('drops the diagnostics of a cache written for an older format version', async () => {
		const seed = createProject()
		try {
			await readyProject(seed)
		} finally {
			await seed.close()
		}
		const validCache = await readCacheFile()
		// A cache carries the diagnostics its own build produced, and an unchanged file is not
		// re-checked, so adopting a cache from a build whose checkers reported something else
		// keeps reporting it. Bumping the format version is what ends that, which only holds as
		// long as a fix to a checker comes with a bump.
		const staleError = {
			message: 'diagnostic of a build whose checkers have since been fixed',
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			severity: 3,
		}
		const withStaleErrors = (version: number): SerializedCacheFixture => ({
			...structuredClone(validCache),
			errors: { [binaryUri]: [staleError] },
			version,
		})

		// The current version does restore them, so the assertion below measures the version
		// check rather than something else dropping the entry on the way.
		await writeCacheFile(withStaleErrors(core.LatestCacheVersion))
		const current = createProject()
		try {
			await current.init()
			assert.deepEqual(current.cacheService.errors[binaryUri], [staleError])
		} finally {
			await current.close()
		}

		await writeCacheFile(withStaleErrors(core.LatestCacheVersion - 1))
		const outdated = createProject()
		try {
			await outdated.init()
			assert.deepEqual(outdated.cacheService.errors, {})
		} finally {
			await outdated.close()
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
			await project.withClientFeatureAccess(binaryUri, () => {})
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

	/**
	 * Record which files a save reads back from disk. `FileService`'s `file:` supporter forwards
	 * straight to the externals, so every read `createVerifiedChecksums` performs shows up here.
	 */
	function createReadRecordingProject(): {
		project: core.Project
		readUris: string[]
		restoreReadFile: () => void
	} {
		const fs = { ...NodeJsExternals.fs }
		const externals: core.Externals = { ...NodeJsExternals, fs }
		const read = fs.readFile.bind(fs)
		const readUris: string[] = []
		fs.readFile = async (location) => {
			readUris.push(location.toString())
			return read(location)
		}
		return {
			project: createProject(externals),
			readUris,
			restoreReadFile: () => {
				fs.readFile = read
			},
		}
	}

	/**
	 * Record every save the project performs from here on, with the options it was given and the
	 * result it reported. Which files a save reads is not measurable this way: `saveOnce` drains
	 * the pending hash recordings first, and their reads are indistinguishable from the ones the
	 * verification itself performs. The tests calling `save` directly cover that instead.
	 */
	function recordSaves(project: core.Project): SaveRecord[] {
		const records: SaveRecord[] = []
		const save = project.cacheService.save.bind(project.cacheService)
		project.cacheService.save = async (options) => {
			const record: SaveRecord = { options, result: false }
			records.push(record)
			record.result = await save(options)
			return record.result
		}
		return records
	}

	it('reuses the recorded hashes of tracked files when the caller trusts them', async () => {
		const { project, readUris, restoreReadFile } = createReadRecordingProject()
		try {
			await readyProject(project)
			// The checksum updates `documentUpdated` queued during `ready` are still in flight
			// here. A first save doubles as their barrier: `saveOnce` awaits every pending hash
			// update before it verifies anything, so the reads recorded below belong to the
			// measured save alone.
			assert.equal(await project.cacheService.save(), true)
			const recorded = {
				fileContent: project.cacheService.checksums.fileContents[binaryUri],
				file: project.cacheService.checksums.files[binaryUri],
			}
			assert.ok(recorded.fileContent)
			assert.ok(recorded.file)

			readUris.length = 0
			assert.equal(await project.cacheService.save({ trustRecordedHashes: true }), true)

			assert.deepEqual(
				readUris.filter(uri => uri === binaryUri),
				[],
				'a tracked file that already has both recorded hashes must not be read again by a '
					+ 'save that follows the rebuild which recorded them',
			)
			const cache = await readCacheFile()
			assert.equal(cache.checksums.files[binaryUri], recorded.file)
			assert.equal(cache.checksums.fileContents[binaryUri], recorded.fileContent)
		} finally {
			restoreReadFile()
			await project.close()
		}
	})

	it('re-reads every tracked file when the caller does not trust recorded hashes', async () => {
		const { project, readUris, restoreReadFile } = createReadRecordingProject()
		try {
			await readyProject(project)
			// Drain the checksum updates queued by `ready` first; see the test above.
			assert.equal(await project.cacheService.save(), true)

			readUris.length = 0
			assert.equal(await project.cacheService.save(), true)

			assert.deepEqual(
				readUris.filter(uri => uri === binaryUri),
				[binaryUri],
				'the default save path must keep verifying tracked files against disk so that a '
					+ 'change the watcher missed cannot reach the cache file',
			)
		} finally {
			restoreReadFile()
			await project.close()
		}
	})

	it('reuses the recorded hashes of the listed URIs alone', async () => {
		const outsideDir = await realpath(await mkdtemp(join(tmpdir(), 'spyglass-binary-outside-')))
		// Tracked and hashed like any other file, but outside every project root — the shape of
		// the dependency files a partial pass such as `analyzeProject` walks past.
		const outsideUri = core.normalizeUri(
			pathToFileURL(join(outsideDir, 'tracked.png')).toString(),
		)
		await writeFile(new URL(outsideUri), BinaryPngBytes)

		const { project, readUris, restoreReadFile } = createReadRecordingProject()
		try {
			await readyProject(project, outsideUri)
			// Drain the checksum updates queued by `ready` first; see the trusting test above.
			assert.equal(await project.cacheService.save(), true)

			readUris.length = 0
			assert.equal(
				await project.cacheService.save({
					trustRecordedHashesFor: new Set([binaryUri]),
				}),
				true,
			)

			assert.deepEqual(
				readUris.filter(uri => uri === binaryUri),
				[],
				'a listed URI whose two hashes are both recorded must not be read again',
			)
			assert.deepEqual(
				readUris.filter(uri => uri === outsideUri),
				[outsideUri],
				'a tracked file the caller did not list keeps the full read path, so that a change '
					+ 'the watcher missed under it cannot reach the cache file',
			)
			const cache = await readCacheFile()
			assert.equal(
				cache.checksums.files[binaryUri],
				project.cacheService.checksums.files[binaryUri],
			)
			assert.equal(
				cache.checksums.files[outsideUri],
				project.cacheService.checksums.files[outsideUri],
			)
		} finally {
			restoreReadFile()
			await project.close()
			await rm(outsideDir, { recursive: true, force: true })
		}
	})

	it('reads a listed URI back after a file notification', async () => {
		const { project, readUris, restoreReadFile } = createReadRecordingProject()
		try {
			await readyProject(project)
			// Drain the checksum updates queued by `ready` first; see the trusting test above.
			assert.equal(await project.cacheService.save(), true)
			project.cacheService.markFileChange(binaryUri)

			readUris.length = 0
			assert.equal(
				await project.cacheService.save({
					trustRecordedHashesFor: new Set([binaryUri]),
				}),
				true,
			)

			assert.deepEqual(
				readUris.filter(uri => uri === binaryUri),
				[binaryUri],
				'a notification is a reason to distrust the recorded hashes of this very file, '
					+ 'which listing the URI cannot overrule',
			)
		} finally {
			restoreReadFile()
			await project.close()
		}
	})

	it('does not trust hashes after a file notification queued behind a rebuild', async () => {
		const checkStarted = Promise.withResolvers<void>()
		const releaseCheck = Promise.withResolvers<void>()
		let shouldBlockCheck = false
		const project = createProject(NodeJsExternals, undefined, async (uri) => {
			if (shouldBlockCheck && uri === binaryUri) {
				shouldBlockCheck = false
				checkStarted.resolve()
				await releaseCheck.promise
			}
		})
		const watcher = new FixtureWatcher(binaryUri)
		try {
			await project.init()
			await project.ready({ projectRootsWatcher: watcher })
			assert.deepEqual(
				(await readdir(cacheDir, { recursive: true }))
					.filter(entry => entry.endsWith('.json.gz')),
				[],
				'the fixture must not have a cache that could hide a stale rebuild save',
			)

			// A rebuild checks the documents the client has open and nothing else, and it runs
			// those checks after binding every tracked file. Opening the fixture is therefore
			// what puts the gate below behind the hash recording this test snapshots.
			await project.onDidOpen(
				binaryUri,
				'png',
				1,
				core.bufferToString(await readFile(new URL(binaryUri))),
			)

			shouldBlockCheck = true
			const reset = project.reset()
			await checkStarted.promise
			await waitForRecordedHashes(project, binaryUri)
			const recordedBeforeNotification = {
				fileContent: project.cacheService.checksums.fileContents[binaryUri],
				file: project.cacheService.checksums.files[binaryUri],
			}

			await writeFile(new URL(binaryUri), new Uint8Array([0x41, 0x42, 0x43]))
			watcher.emit('change', binaryUri)
			releaseCheck.resolve()
			await reset

			assert.deepEqual(
				(await readdir(cacheDir, { recursive: true }))
					.filter(entry => entry.endsWith('.json.gz')),
				[],
				'a trusting rebuild save must re-read a notified URI and reject the hashes recorded '
					+ 'from its old contents',
			)
			assert.ok(recordedBeforeNotification.fileContent)
			assert.ok(recordedBeforeNotification.file)
		} finally {
			releaseCheck.resolve()
			await project.close()
		}
	})

	it('reads a tracked file whose raw-byte hash an unsaved edit dropped, even when trusted', async () => {
		const { project, readUris, restoreReadFile } = createReadRecordingProject()
		try {
			await readyProject(project)
			// An unsaved client-managed edit makes `trackDocumentUpdate` drop `checksums.files`
			// while keeping `checksums.fileContents`, which is the state a trusting save must not
			// take at face value.
			await project.onDidOpen(binaryUri, 'png', 1, 'unsaved editor contents')
			await project.withClientFeatureAccess(binaryUri, () => {})
			// Drain the checksum updates queued by `ready` and by the edit above; see the first
			// test of this trio.
			assert.equal(await project.cacheService.save(), false)

			readUris.length = 0
			assert.equal(
				await project.cacheService.save({ trustRecordedHashes: true }),
				false,
				'a document that disagrees with its file on disk must still abort the save',
			)

			assert.ok(project.cacheService.checksums.fileContents[binaryUri])
			assert.equal(project.cacheService.checksums.files[binaryUri], undefined)
			assert.deepEqual(
				readUris.filter(uri => uri === binaryUri),
				[binaryUri],
				'a tracked file missing its raw-byte hash must be read back even when the caller '
					+ 'trusts recorded hashes',
			)
		} finally {
			restoreReadFile()
			await project.close()
		}
	})

	it('reads a tracked file whose text hash is missing, even when trusted', async () => {
		const { project, readUris, restoreReadFile } = createReadRecordingProject()
		try {
			await readyProject(project)
			assert.equal(await project.cacheService.save(), true)
			assert.ok(project.cacheService.checksums.files[binaryUri])
			// No production transition leaves `files` behind while dropping only `fileContents`,
			// so manipulate the checksum fixture directly to cover the other half of the skip guard.
			delete project.cacheService.checksums.fileContents[binaryUri]

			readUris.length = 0
			assert.equal(
				await project.cacheService.save({ trustRecordedHashes: true }),
				false,
				'a file with cached diagnostics but no text hash must abort publication',
			)
			assert.deepEqual(
				readUris.filter(uri => uri === binaryUri),
				[binaryUri],
				'a tracked file missing its text hash must be read back even when the caller trusts '
					+ 'recorded hashes',
			)
		} finally {
			restoreReadFile()
			await project.close()
		}
	})

	it('waits for a pending hash recording before trusting recorded hashes', async () => {
		const fs = { ...NodeJsExternals.fs }
		const externals: core.Externals = { ...NodeJsExternals, fs }
		const read = fs.readFile.bind(fs)
		const hashReadStarted = Promise.withResolvers<void>()
		const releaseHashRead = Promise.withResolvers<void>()
		const unexpectedVerificationRead = Promise.withResolvers<void>()
		let binaryReadCount = 0
		fs.readFile = async (location) => {
			if (location.toString() === binaryUri) {
				binaryReadCount += 1
				if (binaryReadCount === 2) {
					hashReadStarted.resolve()
					await releaseHashRead.promise
				} else if (binaryReadCount === 3) {
					unexpectedVerificationRead.resolve()
				}
			}
			return read(location)
		}
		const project = createProject(externals)
		try {
			await readyProject(project)
			await hashReadStarted.promise
			assert.equal(project.cacheService.checksums.fileContents[binaryUri], undefined)
			assert.equal(project.cacheService.checksums.files[binaryUri], undefined)

			const save = project.cacheService.save({ trustRecordedHashes: true })
			const readBeforeRelease = await Promise.race([
				unexpectedVerificationRead.promise.then(() => true),
				new Promise<false>(resolve => setTimeout(() => resolve(false), 100)),
			])
			assert.equal(
				readBeforeRelease,
				false,
				'the save must wait for the pending recording instead of verifying an incomplete '
					+ 'checksum snapshot',
			)

			releaseHashRead.resolve()
			assert.equal(await save, true)
			const cache = await readCacheFile()
			assert.equal(
				cache.checksums.fileContents[binaryUri],
				project.cacheService.checksums.fileContents[binaryUri],
			)
			assert.equal(
				cache.checksums.files[binaryUri],
				project.cacheService.checksums.files[binaryUri],
			)
		} finally {
			releaseHashRead.resolve()
			await project.close()
		}
	})

	it('saves once when an analysis runs to completion', async () => {
		const project = createProject()
		const saves = recordSaves(project)
		try {
			await readyProject(project)
			const result = await project.analyzeProject()

			assert.deepEqual(result, { analyzedFiles: 1, cancelled: false, totalFiles: 1 })
			assert.equal(
				saves.length,
				1,
				'an analysis must persist its result once on the way out, never once per file',
			)
			assert.equal(saves[0].result, true)
			assert.equal(
				saves[0].options?.trustRecordedHashes,
				undefined,
				'an analysis covers the project files alone, so it may not trust every tracked file',
			)
			assert.deepEqual([...saves[0].options?.trustRecordedHashesFor ?? []], [binaryUri])
		} finally {
			await project.close()
		}
	})

	it('lists only the files an analysis published as trusted', async () => {
		const outsideDir = await realpath(await mkdtemp(join(tmpdir(), 'spyglass-binary-outside-')))
		// Tracked, bound during `ready`, and outside every project root — the shape of the
		// dependency files an analysis walks past.
		const outsideUri = core.normalizeUri(
			pathToFileURL(join(outsideDir, 'tracked.png')).toString(),
		)
		await writeFile(new URL(outsideUri), BinaryPngBytes)
		const unreadableUri = await writeProjectFile('unreadable.png')

		const project = createProject()
		const saves = recordSaves(project)
		const readFileFromProject = project.fs.readFile.bind(project.fs)
		let failUnreadable = false
		project.fs.readFile = async (uri) => {
			if (failUnreadable && uri === unreadableUri) {
				throw new Error('fixture prepare failure')
			}
			return readFileFromProject(uri)
		}
		try {
			await readyProject(project, outsideUri, unreadableUri)
			failUnreadable = true
			const result = await project.analyzeProject({
				onProgress: (done, total, phase) => {
					// Lifted before the save so that the file the `prepare` pass could not read is
					// one the analysis skipped, rather than one whose verification also fails.
					if (phase === 'prepare' && done === total) {
						failUnreadable = false
					}
				},
			})

			assert.deepEqual(result, { analyzedFiles: 1, cancelled: false, totalFiles: 2 })
			assert.equal(saves.length, 1)
			assert.equal(saves[0].result, true)
			assert.deepEqual(
				[...saves[0].options?.trustRecordedHashesFor ?? []],
				[binaryUri],
				'a tracked file outside the project roots is never analyzed and one the analysis '
					+ 'failed to read carries nothing fresh, so neither may skip verification',
			)
		} finally {
			project.fs.readFile = readFileFromProject
			await project.close()
			await rm(outsideDir, { recursive: true, force: true })
		}
	})

	it('does not save the cache after the caller cancels an analysis', async () => {
		const secondUri = await writeProjectFile('second.png')
		const project = createProject()
		const saves = recordSaves(project)
		const controller = new AbortController()
		try {
			await readyProject(project, secondUri)
			const result = await project.analyzeProject({
				signal: controller.signal,
				onProgress: (done, _total, phase) => {
					if (phase === 'analyze' && done === 1) {
						controller.abort()
					}
				},
			})

			assert.deepEqual(result, { analyzedFiles: 1, cancelled: true, totalFiles: 2 })
			assert.equal(
				saves.length,
				0,
				'a cancelled analysis covered part of the corpus, so it returns its partial '
					+ 'diagnostics instead of persisting them',
			)
		} finally {
			await project.close()
		}
	})

	it('does not save the cache when a file notification cancels an analysis', async () => {
		const secondUri = await writeProjectFile('second.png')
		const project = createProject()
		const watcher = new FixtureWatcher(binaryUri, secondUri)
		const saves = recordSaves(project)
		try {
			await project.init()
			await project.ready({ projectRootsWatcher: watcher })
			const result = await project.analyzeProject({
				onProgress: (done, _total, phase) => {
					if (phase === 'analyze' && done === 1) {
						watcher.emit('change', binaryUri)
					}
				},
			})

			assert.deepEqual(result, { analyzedFiles: 1, cancelled: true, totalFiles: 2 })
			assert.equal(
				saves.length,
				0,
				'a notification stops the analysis so that a rebuild can redo it, and saving the '
					+ 'state that rebuild is about to discard buys nothing',
			)
		} finally {
			await project.close()
		}
	})

	it('reports a completed analysis when its save is skipped', async () => {
		const project = createProject()
		try {
			await readyProject(project)
			project.cacheService.save = async () => false
			assert.deepEqual(
				await project.analyzeProject(),
				{ analyzedFiles: 1, cancelled: false, totalFiles: 1 },
				'the diagnostics are already published, so a save the cache declined to perform '
					+ 'does not make the analysis itself a failure',
			)
		} finally {
			await project.close()
		}
	})

	it('reports a completed analysis when its save throws', async () => {
		const project = createProject()
		try {
			await readyProject(project)
			project.cacheService.save = async () => {
				throw new Error('fixture save failure')
			}
			assert.deepEqual(
				await project.analyzeProject(),
				{ analyzedFiles: 1, cancelled: false, totalFiles: 1 },
				'a failed save is logged, not raised to the caller who asked for an analysis',
			)
		} finally {
			await project.close()
		}
	})

	it('drops the analysis save when the cache generation moves during it', async () => {
		const fs = { ...NodeJsExternals.fs }
		const externals: core.Externals = { ...NodeJsExternals, fs }
		const project = createProject(externals)
		const saves = recordSaves(project)
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
			await readyProject(project)
			const analysis = project.analyzeProject()
			await temporaryFileWritten.promise
			project.cacheService.invalidatePartial('lint', [binaryUri])
			releaseTemporaryWrite.resolve()

			assert.deepEqual(await analysis, { analyzedFiles: 1, cancelled: false, totalFiles: 1 })
			assert.equal(saves.length, 1)
			assert.equal(
				saves[0].result,
				false,
				'the trusted set does not exempt a save from the generation guard',
			)
			assert.deepEqual(
				(await readdir(cacheDir, { recursive: true }))
					.filter(entry => entry.endsWith('.json.gz')),
				[],
				'a save whose snapshot moved must leave the cache file untouched',
			)
		} finally {
			fs.writeFile = write
			releaseTemporaryWrite.resolve()
			await project.close()
		}
	})

	it('verifies an unsaved client-managed document an analysis published', async () => {
		const project = createProject()
		const saves = recordSaves(project)
		try {
			await readyProject(project)
			await project.onDidOpen(binaryUri, 'png', 1, 'unsaved editor contents')
			await project.withClientFeatureAccess(binaryUri, () => {})
			const result = await project.analyzeProject()

			assert.deepEqual(result, { analyzedFiles: 1, cancelled: false, totalFiles: 1 })
			assert.equal(saves.length, 1)
			assert.deepEqual(
				[...saves[0].options?.trustRecordedHashesFor ?? []],
				[binaryUri],
				'the analysis published this document, so it lists the URI like any other',
			)
			assert.equal(
				project.cacheService.checksums.files[binaryUri],
				undefined,
				'a buffer that disagrees with its file on disk has no raw-byte hash to trust',
			)
			assert.equal(
				saves[0].result,
				false,
				'listing the URI cannot overrule that, so the verification still aborts the save',
			)
		} finally {
			await project.close()
		}
	})
})
