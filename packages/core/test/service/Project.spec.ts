import { memfs } from 'memfs'
import assert from 'node:assert/strict'
import type fsp from 'node:fs/promises'
import { describe, it } from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'
import type {
	ClientFeatureAccess,
	Externals,
	FileWatcher,
	FileWatcherEventMap,
	LiteralNode,
	MetaRegistry,
	PosRangeLanguageError,
	Profiler,
	ProjectInitializer,
	RootUriString,
} from '../../lib/index.js'
import {
	AsyncBinder,
	ConfigService,
	EventDispatcher,
	fileUtil,
	literal,
	Logger,
	ProfilerFactory,
	Project,
	UriStore,
	VanillaConfig,
} from '../../lib/index.js'
import { getNodeJsExternals } from '../../lib/nodejs.js'

const CacheRoot: RootUriString = 'file:///cache/'
const ProjectRoot: RootUriString = 'file:///root/'
const TestCheckerMessage = 'Test checker error'
/** Symbol category the fixtures below register into. */
const TestSymbolCategory = 'spyglasstest'

/**
 * A {@link FileWatcher} that populates its file store with the files that exist under the watched
 * locations when {@link ready} is called, similarly to the initial scan of the language server's
 * `LspFileWatcher`, and never reports any changes.
 */
class TestFileWatcher extends EventDispatcher<FileWatcherEventMap> implements FileWatcher {
	readonly #externals: Externals
	readonly #locations: readonly RootUriString[]
	readonly #watchedFiles = new UriStore()

	constructor(externals: Externals, locations: readonly RootUriString[]) {
		super()
		this.#externals = externals
		this.#locations = locations
	}

	get watchedFiles(): UriStore {
		return this.#watchedFiles
	}

	async ready(): Promise<void> {
		for (const location of this.#locations) {
			for (const uri of await fileUtil.getAllFiles(this.#externals, location)) {
				this.#watchedFiles.add(uri)
			}
		}
		this.emit('ready', undefined)
	}

	async close(): Promise<void> {}
}

/**
 * Registers a language `spyglasstest` for `.spyglasstest` files, the content of which must be the
 * literal `foo`, along with a checker that always reports {@link TestCheckerMessage}.
 */
const testLanguageInitializer: ProjectInitializer = ({ meta }) => {
	meta.registerLanguage('spyglasstest', {
		extensions: ['.spyglasstest'],
		parser: literal('foo'),
	})
	meta.registerChecker<LiteralNode>('literal', (node, ctx) => {
		ctx.err.report(TestCheckerMessage, node)
	})
}

/** The `checkOutcome` of a `documentErrored` event. */
type CheckOutcome = 'complete' | 'failed' | 'not-run'

interface SetupResult {
	errors: Map<string, readonly PosRangeLanguageError[]>
	fs: ReturnType<typeof memfs>['fs']
	/** The `checkOutcome` each URI was last published with. */
	outcomes: Map<string, CheckOutcome>
	project: Project
	watcher: TestFileWatcher
}

/**
 * Build a project over the given file system without starting it, so that a test can drive `init`
 * and `ready` itself. Passing the file system of an earlier session is how a warm start is set up:
 * the second project finds the cache file the first one saved.
 */
interface SetupOptions {
	/**
	 * Merged into the default config after the defaults, e.g. to move the lint fingerprint of a
	 * session away from the one that wrote the cache it reads.
	 */
	config?: Record<string, unknown>
	/** Replaces the no-op profilers, for a test that needs a stage inside a pass to throw. */
	profilers?: ProfilerFactory
}

function createSetup(
	fs: ReturnType<typeof memfs>['fs'],
	/** Runs after {@link testLanguageInitializer} and may therefore override its processors. */
	extraInitializer?: ProjectInitializer,
	options: SetupOptions = {},
): SetupResult {
	// memfs answers a read with a pooled `Buffer`, whose `.buffer` is the whole 8 KiB pool rather
	// than the file. Raw-byte checksums are computed over that `.buffer`, so under memfs they
	// depend on unrelated pool contents and never reproduce, which would leave every cached file
	// looking changed on a second start. Node's own `readFile` answers with an exact-size buffer;
	// copying into one here is what makes this harness behave like the file system it stands in
	// for.
	const nodeFsp = {
		...fs.promises,
		readFile: async (...args: Parameters<typeof fsp.readFile>) => {
			const content = await (fs.promises.readFile as typeof fsp.readFile)(...args)
			return typeof content === 'string' ? content : new Uint8Array(content)
		},
	} as unknown as typeof fsp
	const externals = getNodeJsExternals({
		cacheRoot: CacheRoot,
		logger: Logger.noop(),
		nodeFsp,
	})

	const project = new Project({
		cacheRoot: CacheRoot,
		defaultConfig: ConfigService.merge(
			VanillaConfig,
			{ env: { dependencies: [] } },
			options.config ?? {},
		),
		externals,
		initializers: extraInitializer
			? [testLanguageInitializer, extraInitializer]
			: [testLanguageInitializer],
		logger: Logger.noop(),
		...options.profilers ? { profilers: options.profilers } : {},
		projectRoots: [ProjectRoot],
	})
	const errors = new Map<string, readonly PosRangeLanguageError[]>()
	const outcomes = new Map<string, CheckOutcome>()
	project.on('documentErrored', ({ checkOutcome, uri, errors: documentErrors }) => {
		errors.set(uri, documentErrors)
		outcomes.set(uri, checkOutcome)
	})

	const watcher = new TestFileWatcher(externals, [ProjectRoot])

	return { errors, fs, outcomes, project, watcher }
}

async function setup(
	files: Record<string, string>,
	/** Runs after {@link testLanguageInitializer} and may therefore override its processors. */
	extraInitializer?: ProjectInitializer,
	options: SetupOptions = {},
): Promise<SetupResult> {
	const { fs } = memfs(files, '/')
	const result = createSetup(fs, extraInitializer, options)
	await result.project.init()
	await result.project.ready({ projectRootsWatcher: result.watcher })

	return result
}

/**
 * Register a checker that throws for the URIs `shouldThrow` selects and reports
 * {@link TestCheckerMessage} for the rest. The failure has to be injected like this: no file in a
 * real corpus makes a checker throw.
 */
function registerThrowingChecker(
	meta: MetaRegistry,
	shouldThrow: (uri: string) => boolean,
	/** Collects the URI of every document the checker is entered for, in order. */
	checkedUris?: string[],
): void {
	meta.registerChecker<LiteralNode>('literal', (node, ctx) => {
		checkedUris?.push(ctx.doc.uri)
		if (shouldThrow(ctx.doc.uri)) {
			throw new Error('Test checker failure')
		}
		ctx.err.report(TestCheckerMessage, node)
	})
}

/**
 * Profilers whose `project#lint` profiler throws when a task is recorded. That call sits inside
 * the same `try` as the checker but runs after it, which is the only stage of a check a fixture
 * can make fail from the outside once the checker itself has completed.
 */
class ThrowingLintProfilerFactory extends ProfilerFactory {
	constructor() {
		super(Logger.noop(), [])
	}

	override get(id: string): Profiler {
		const noop: Profiler = { task: () => noop, finalize: () => {} }
		if (id !== 'project#lint') {
			return noop
		}
		return {
			task: () => {
				throw new Error('Test profiler failure')
			},
			finalize: () => {},
		}
	}
}

/** The parts of a saved cache file the tests below inspect. */
interface SerializedCache {
	checksums: {
		fileContents: Record<string, string>
		files: Record<string, string>
	}
	errors: Record<string, { message: string }[]>
	failedChecks?: string[]
	[key: string]: unknown
}

function getCacheFilePath(fs: ReturnType<typeof memfs>['fs']): string {
	const directory = '/cache/symbols'
	const entries = (fs.readdirSync(directory) as string[])
		.filter((entry) => entry.endsWith('.json.gz'))
	assert.equal(entries.length, 1, 'expected exactly one saved cache file')
	return `${directory}/${entries[0]}`
}

function readCacheFile(fs: ReturnType<typeof memfs>['fs']): SerializedCache {
	const content = gunzipSync(fs.readFileSync(getCacheFilePath(fs)) as Buffer)
	return JSON.parse(content.toString()) as SerializedCache
}

function writeCacheFile(fs: ReturnType<typeof memfs>['fs'], cache: SerializedCache): void {
	fs.writeFileSync(getCacheFilePath(fs), gzipSync(JSON.stringify(cache)))
}

/**
 * Hand the event loop over often enough that anything already scheduled — including work that
 * yields a few times of its own — gets a chance to run.
 */
async function runPendingTurns(): Promise<void> {
	for (let i = 0; i < 5; i += 1) {
		await new Promise((resolve) => setImmediate(resolve))
	}
}

/**
 * Wait for everything currently in the project's lifecycle queue, including the work that watcher
 * events enqueue without returning a Promise. `onDidOpen` enqueues its own work and awaits it, and
 * an unsupported language makes that work return before it touches any project state.
 */
async function drainLifecycle(project: Project): Promise<void> {
	await project.onDidOpen(
		`${ProjectRoot}lifecycle-barrier.spyglass-test-unsupported`,
		'spyglass-test-unsupported',
		1,
		'',
	)
}

describe('Project', () => {
	describe('analyzeProject()', () => {
		it('Should check all files and emit their errors', async () => {
			const uriA = `${ProjectRoot}a.spyglasstest`
			const uriB = `${ProjectRoot}b.spyglasstest`
			const { errors, project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
			})
			try {
				assert.deepEqual(errors.get(uriA), [])
				assert.deepEqual(errors.get(uriB), [])
				const result = await project.analyzeProject()

				assert.deepEqual(result, { analyzedFiles: 2, cancelled: false, totalFiles: 2 })
				for (const uri of [uriA, uriB]) {
					assert.deepEqual(
						errors.get(uri)?.map((e) => e.message),
						[TestCheckerMessage],
					)
				}
			} finally {
				await project.close()
			}
		})

		it('Should report progress and support cancellation', async () => {
			const { project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
			})
			try {
				const controller = new AbortController()
				const progress: [number, number, string][] = []
				const result = await project.analyzeProject({
					onProgress: (done, total, phase) => {
						progress.push([done, total, phase])
						if (phase === 'analyze' && done === 1) {
							controller.abort()
						}
					},
					signal: controller.signal,
				})

				assert.deepEqual(result, { analyzedFiles: 1, cancelled: true, totalFiles: 2 })
				assert.deepEqual(progress, [
					[1, 2, 'prepare'],
					[2, 2, 'prepare'],
					[1, 2, 'analyze'],
				])
			} finally {
				await project.close()
			}
		})

		it('Should report the progress of both phases in order', async () => {
			const { project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
				'/root/c.spyglasstest': 'foo',
			})
			try {
				const progress: [number, number, string][] = []
				await project.analyzeProject({
					onProgress: (done, total, phase) => {
						progress.push([done, total, phase])
					},
				})

				assert.deepEqual(progress, [
					[1, 3, 'prepare'],
					[2, 3, 'prepare'],
					[3, 3, 'prepare'],
					[1, 3, 'analyze'],
					[2, 3, 'analyze'],
					[3, 3, 'analyze'],
				])
			} finally {
				await project.close()
			}
		})

		it('Should bind all files before publishing any diagnostics', async () => {
			const boundUris: string[] = []
			const { project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
				'/root/c.spyglasstest': 'foo',
			}, ({ meta }) => {
				meta.registerBinder<LiteralNode>('literal', (_node, ctx) => {
					boundUris.push(ctx.doc.uri)
				})
			})
			try {
				boundUris.length = 0
				const publishedUris: string[] = []
				let boundAtFirstPublish: string[] | undefined
				project.on('documentErrored', async ({ uri }) => {
					boundAtFirstPublish ??= [...boundUris]
					publishedUris.push(uri)
					// A slow listener lets a following file's diagnostics overtake this
					// one's unless the analysis awaits every publish.
					await new Promise((resolve) => setTimeout(resolve, 1))
				})

				await project.analyzeProject()

				assert.deepEqual(
					new Set(boundAtFirstPublish),
					new Set([
						`${ProjectRoot}a.spyglasstest`,
						`${ProjectRoot}b.spyglasstest`,
						`${ProjectRoot}c.spyglasstest`,
					]),
				)
				assert.deepEqual(publishedUris, [
					`${ProjectRoot}a.spyglasstest`,
					`${ProjectRoot}b.spyglasstest`,
					`${ProjectRoot}c.spyglasstest`,
				])
			} finally {
				await project.close()
			}
		})

		it('Should publish the empty diagnostics of an unreadable file from the second pass', async () => {
			const uriA = `${ProjectRoot}a.spyglasstest`
			const uriB = `${ProjectRoot}b.spyglasstest`
			const { fs, project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
			})
			try {
				// The initial scan bound it, so its diagnostics still have to be replaced, and the
				// `prepare` pass can no longer read it, so replacing them is all there is to do.
				fs.unlinkSync('/root/b.spyglasstest')
				const events: string[] = []
				project.on('documentErrored', ({ uri }) => {
					events.push(`publish ${uri}`)
				})

				await project.analyzeProject({
					onProgress: (done, _total, phase) => {
						events.push(`${phase} ${done}`)
					},
				})

				// Diagnostics with no errors in them are still a publish: a listener acts on them
				// and `CacheService` records them. Emitting one from the `prepare` pass would let
				// the run reach the outside world before every file is bound.
				assert.deepEqual(events, [
					'prepare 1',
					'prepare 2',
					`publish ${uriA}`,
					'analyze 1',
					`publish ${uriB}`,
					'analyze 2',
				])
			} finally {
				await project.close()
			}
		})

		it('Should read the current content of a file that changed without a watcher event', async () => {
			const checkedTexts: string[] = []
			const { fs, project } = await setup({ '/root/a.spyglasstest': 'foo' }, ({ meta }) => {
				meta.registerChecker<LiteralNode>('literal', (_node, ctx) => {
					checkedTexts.push(ctx.doc.getText())
				})
			})
			try {
				fs.writeFileSync('/root/a.spyglasstest', 'bar')
				checkedTexts.length = 0

				const result = await project.analyzeProject()

				assert.deepEqual(result, { analyzedFiles: 1, cancelled: false, totalFiles: 1 })
				assert.deepEqual(checkedTexts, ['bar'])
			} finally {
				await project.close()
			}
		})

		it('Should re-analyze a client-managed file that was already checked', async () => {
			const uriA = `${ProjectRoot}a.spyglasstest`
			const checkedUris: string[] = []
			const { errors, project } = await setup({ '/root/a.spyglasstest': 'foo' }, ({ meta }) => {
				meta.registerChecker<LiteralNode>('literal', (node, ctx) => {
					checkedUris.push(ctx.doc.uri)
					ctx.err.report(TestCheckerMessage, node)
				})
			})
			try {
				await project.onDidOpen(uriA, 'spyglasstest', 1, 'foo')
				// Opening the document already produced checker results, which every
				// stage returns early on until the analysis drops them.
				assert.ok(project.getClientManaged(uriA)?.node.checkerErrors)
				checkedUris.length = 0
				errors.clear()

				const result = await project.analyzeProject()

				assert.deepEqual(result, { analyzedFiles: 1, cancelled: false, totalFiles: 1 })
				assert.deepEqual(checkedUris, [uriA])
				assert.deepEqual(
					errors.get(uriA)?.map((e) => e.message),
					[TestCheckerMessage],
				)
			} finally {
				await project.close()
			}
		})

		it('Should count only the files that made it through the checker', async () => {
			const { fs, project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
			})
			try {
				// Still watched, so it stays in the file list the analysis walks, but the
				// `prepare` pass can no longer read it and therefore never binds it.
				fs.unlinkSync('/root/b.spyglasstest')
				const progress: [number, number, string][] = []

				const result = await project.analyzeProject({
					onProgress: (done, total, phase) => {
						progress.push([done, total, phase])
					},
				})

				assert.deepEqual(result, { analyzedFiles: 1, cancelled: false, totalFiles: 2 })
				// The `analyze` pass reports against the same total as the `prepare` pass, so a
				// file it has nothing to do for still advances the count to it.
				assert.deepEqual(progress, [
					[1, 2, 'prepare'],
					[2, 2, 'prepare'],
					[1, 2, 'analyze'],
					[2, 2, 'analyze'],
				])
			} finally {
				await project.close()
			}
		})

		it('Should neither count nor trust a file whose checker threw', async () => {
			const uriA = `${ProjectRoot}a.spyglasstest`
			const uriB = `${ProjectRoot}b.spyglasstest`
			const { errors, project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
			}, ({ meta }) => {
				meta.registerChecker<LiteralNode>('literal', (node, ctx) => {
					if (ctx.doc.uri === uriB) {
						throw new Error('Test checker failure')
					}
					ctx.err.report(TestCheckerMessage, node)
				})
			})
			// The set the run hands to the cache is what turns a processed file into one whose
			// recorded hashes are believed instead of re-read, so it is asserted on directly.
			const trustedUris: string[][] = []
			const cacheService = project.cacheService
			const originalSave = cacheService.save.bind(cacheService)
			cacheService.save = (options) => {
				trustedUris.push([...(options?.trustRecordedHashesFor ?? [])])
				return originalSave(options)
			}
			try {
				errors.clear()

				const result = await project.analyzeProject()

				assert.deepEqual(result, { analyzedFiles: 1, cancelled: false, totalFiles: 2 })
				assert.deepEqual(trustedUris, [[uriA]])
				// The failed file is still published: the partial result replaces whatever this
				// URI showed before, which beats leaving stale diagnostics behind.
				assert.deepEqual(
					errors.get(uriA)?.map((e) => e.message),
					[TestCheckerMessage],
				)
				assert.deepEqual(errors.get(uriB), [])
			} finally {
				await project.close()
			}
		})

		it('Should report a cancellation that arrived during the last file', async () => {
			const { project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
			})
			try {
				const controller = new AbortController()

				const result = await project.analyzeProject({
					onProgress: (done, total, phase) => {
						// No loop boundary follows the last file, so only the re-read after both
						// passes can notice this — and the final cache save is skipped on that
						// same re-read, so a run reported as complete here would claim results
						// that were never persisted.
						if (phase === 'analyze' && done === total) {
							controller.abort()
						}
					},
					signal: controller.signal,
				})

				assert.deepEqual(result, { analyzedFiles: 2, cancelled: true, totalFiles: 2 })
			} finally {
				await project.close()
			}
		})

		it('Should hold a watcher update until the analysis it cancelled has stopped', async () => {
			const releaseCheck = Promise.withResolvers<void>()
			const analysisCheckStarted = Promise.withResolvers<string>()
			let shouldBlock = false
			let checkCount = 0
			const { errors, project, watcher } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
			}, ({ meta }) => {
				meta.registerChecker<LiteralNode>('literal', async (node, ctx) => {
					checkCount += 1
					// The message says which pass produced the diagnostics that ended up
					// published, which is exactly what a stale publish gets wrong.
					ctx.err.report(`check ${checkCount}`, node)
					if (shouldBlock) {
						shouldBlock = false
						analysisCheckStarted.resolve(ctx.doc.uri)
						await releaseCheck.promise
					}
				})
			})
			try {
				shouldBlock = true
				const analysis = project.analyzeProject()
				const uri = await analysisCheckStarted.promise

				// The event invalidates the very document the analysis is checking, and the
				// analysis is holding the node it read before the event.
				watcher.emit('change', uri)
				await runPendingTurns()
				assert.deepEqual(
					errors.get(uri)?.map((e) => e.message),
					[],
					'the queued re-check ran while the analysis was still inside the checker',
				)

				releaseCheck.resolve()
				await analysis
				await drainLifecycle(project)

				// The analysis published its own, older result when it resumed. The watcher path
				// runs after it, so the fresher result is the one left on screen.
				assert.deepEqual(errors.get(uri)?.map((e) => e.message), ['check 2'])
			} finally {
				releaseCheck.resolve()
				await project.close()
			}
		})

		it('Should hold an editor change until the analysis it cancelled has stopped', async () => {
			const uriA = `${ProjectRoot}a.spyglasstest`
			const releaseCheck = Promise.withResolvers<void>()
			const analysisCheckStarted = Promise.withResolvers<void>()
			let shouldBlock = false
			let checkCount = 0
			const { errors, project } = await setup({ '/root/a.spyglasstest': 'foo' }, ({ meta }) => {
				meta.registerChecker<LiteralNode>('literal', async (node, ctx) => {
					checkCount += 1
					ctx.err.report(`check ${checkCount}`, node)
					if (shouldBlock) {
						shouldBlock = false
						analysisCheckStarted.resolve()
						await releaseCheck.promise
					}
				})
			})
			try {
				// `check 1`. The analysis redoes the open document as `check 2` and blocks there.
				await project.onDidOpen(uriA, 'spyglasstest', 1, 'foo')
				shouldBlock = true
				const analysis = project.analyzeProject()
				await analysisCheckStarted.promise

				const change = project.onDidChange(uriA, [{ text: 'foo' }], 2)
				await runPendingTurns()
				assert.equal(
					checkCount,
					2,
					'the editor change ran its check while the analysis was still inside one',
				)

				releaseCheck.resolve()
				await analysis
				await change

				// Both passes publish the same object, so the analysis resuming after the edit
				// would put the pre-edit diagnostics back.
				assert.deepEqual(errors.get(uriA)?.map((e) => e.message), ['check 3'])
			} finally {
				releaseCheck.resolve()
				await project.close()
			}
		})

		it('Should hold an editor open until the analysis it cancelled has stopped', async () => {
			const uriB = `${ProjectRoot}b.spyglasstest`
			const releaseBind = Promise.withResolvers<void>()
			const analysisBindStarted = Promise.withResolvers<void>()
			let shouldBlock = false
			const boundUris: string[] = []
			const { project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
			}, ({ meta }) => {
				meta.registerBinder<LiteralNode>(
					'literal',
					AsyncBinder.create(async (_node, ctx) => {
						boundUris.push(ctx.doc.uri)
						if (shouldBlock) {
							shouldBlock = false
							analysisBindStarted.resolve()
							await releaseBind.promise
						}
					}),
				)
			})
			try {
				shouldBlock = true
				const analysis = project.analyzeProject()
				await analysisBindStarted.promise
				boundUris.length = 0

				// Opening a document binds it, and a bind empties the symbols of its URI before
				// registering them again — with an await boundary in between, for an async binder.
				// A pass that reads the symbol table in that window reports symbols as undeclared
				// that are merely halfway through being registered.
				const open = project.onDidOpen(uriB, 'spyglasstest', 1, 'foo')
				await runPendingTurns()
				assert.deepEqual(
					boundUris,
					[],
					'the editor open bound while the analysis was still inside a bind',
				)

				releaseBind.resolve()
				await analysis
				await open

				assert.deepEqual(boundUris, [uriB])
			} finally {
				releaseBind.resolve()
				await project.close()
			}
		})

		it('Should keep analyzing while an `archive:` URI is opened and closed', async () => {
			// A file inside a dependency archive: watched, never client-managed, and outside every
			// project root, so nothing an editor does to it changes what the analysis walks.
			const archiveUri = 'archive://dependency.zip/data/test/function/foo.spyglasstest'
			const releaseCheck = Promise.withResolvers<void>()
			const analysisCheckStarted = Promise.withResolvers<void>()
			let shouldBlock = false
			const { project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
			}, ({ meta }) => {
				meta.registerChecker<LiteralNode>('literal', async (node, ctx) => {
					ctx.err.report(TestCheckerMessage, node)
					if (shouldBlock) {
						shouldBlock = false
						analysisCheckStarted.resolve()
						await releaseCheck.promise
					}
				})
			})
			try {
				shouldBlock = true
				const analysis = project.analyzeProject()
				await analysisCheckStarted.promise

				// Not awaited before the analysis is released: a notification that cancelled would
				// also wait for the very check that is blocked here, and browsing a dependency
				// would then take a run of minutes down with it.
				const change = project.onDidChange(archiveUri, [{ text: 'foo' }], 2)
				const close = project.onDidClose(archiveUri)
				await runPendingTurns()

				releaseCheck.resolve()
				const result = await analysis
				await change
				await close

				assert.deepEqual(result, { analyzedFiles: 2, cancelled: false, totalFiles: 2 })
			} finally {
				releaseCheck.resolve()
				await project.close()
			}
		})

		it('Should keep analyzing while an excluded file is opened, changed, and closed', async () => {
			// Both halves of `shouldExclude`, both under the project root: a supported language
			// inside a `.`-prefixed directory, which the default `env.exclude` covers, and a file
			// whose extension has no language registered for it. The analysis leaves both out of
			// its file list, and every handler returns before it registers either document, so an
			// editor session spent in them must not cost the run anything.
			const excludedUri = `${ProjectRoot}.hidden/c.spyglasstest`
			const unsupportedUri = `${ProjectRoot}notes.txt`
			const releaseCheck = Promise.withResolvers<void>()
			const analysisCheckStarted = Promise.withResolvers<void>()
			let shouldBlock = false
			const { project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
				'/root/.hidden/c.spyglasstest': 'foo',
				'/root/notes.txt': 'foo',
			}, ({ meta }) => {
				meta.registerChecker<LiteralNode>('literal', async (node, ctx) => {
					ctx.err.report(TestCheckerMessage, node)
					if (shouldBlock) {
						shouldBlock = false
						analysisCheckStarted.resolve()
						await releaseCheck.promise
					}
				})
			})
			try {
				shouldBlock = true
				const analysis = project.analyzeProject()
				await analysisCheckStarted.promise

				// Not awaited before the analysis is released: a notification that cancelled would
				// also wait for the very check that is blocked here, and awaiting one here would
				// therefore turn a regression into a hang instead of the failure below.
				const notifications = [
					project.onDidOpen(excludedUri, 'spyglasstest', 1, 'foo'),
					project.onDidChange(excludedUri, [{ text: 'foo' }], 2),
					project.onDidClose(excludedUri),
					project.onDidOpen(unsupportedUri, 'plaintext', 1, 'foo'),
					project.onDidChange(unsupportedUri, [{ text: 'foo' }], 2),
					project.onDidClose(unsupportedUri),
				]
				await runPendingTurns()

				releaseCheck.resolve()
				const result = await analysis
				await Promise.all(notifications)

				assert.deepEqual(result, { analyzedFiles: 2, cancelled: false, totalFiles: 2 })
			} finally {
				releaseCheck.resolve()
				await project.close()
			}
		})

		it('Should wait for a running analysis before closing', async () => {
			const releaseCheck = Promise.withResolvers<void>()
			const analysisCheckStarted = Promise.withResolvers<void>()
			let shouldBlock = false
			const { project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
			}, ({ meta }) => {
				meta.registerChecker<LiteralNode>('literal', async (node, ctx) => {
					ctx.err.report(TestCheckerMessage, node)
					if (shouldBlock) {
						shouldBlock = false
						analysisCheckStarted.resolve()
						await releaseCheck.promise
					}
				})
			})
			try {
				shouldBlock = true
				const analysis = project.analyzeProject()
				await analysisCheckStarted.promise

				// An analysis works outside the lifecycle queue, so draining that queue does not
				// wait for it. Left unawaited, its checker and its publish would keep running
				// against a project that has already been torn down.
				let closed = false
				const close = project.close().then(() => {
					closed = true
				})
				await runPendingTurns()
				assert.equal(closed, false, 'close() settled while a file was still being checked')

				releaseCheck.resolve()
				await close
				await analysis
			} finally {
				releaseCheck.resolve()
			}
		})

		it('Should settle a later reset after an analysis threw while listing its files', async () => {
			let shouldThrow = false
			const { project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
			}, ({ meta }) => {
				// The analysis registers itself, then lists and sorts its files. A throw in
				// between leaves nothing but the guard around the whole run to release the
				// operations waiting for it.
				meta.setUriSorter((a, b, next) => {
					if (shouldThrow) {
						throw new Error('Test URI sorter failure')
					}
					return next(a, b)
				})
			})
			let resetSettled = false
			let timeoutId: ReturnType<typeof setTimeout> | undefined
			try {
				shouldThrow = true
				await assert.rejects(project.analyzeProject(), /Test URI sorter failure/)
				// The rebuild the reset runs sorts the same list.
				shouldThrow = false

				await Promise.race([
					project.reset().then(() => {
						resetSettled = true
					}),
					// A reset that waits on the dead analysis never settles, and this suite runs
					// in a single process, so failing here beats hanging the whole run.
					new Promise((_resolve, reject) => {
						timeoutId = setTimeout(
							() => reject(new Error('The reset never settled')),
							10_000,
						)
					}),
				])
			} finally {
				clearTimeout(timeoutId)
				// Closing drains the lifecycle queue, so a reset stuck inside it would take
				// `close` down with it.
				if (resetSettled) {
					await project.close()
				}
			}
		})

		it('Should not publish through `ensureBindingStarted` while an analysis is running', async () => {
			const uriA = `${ProjectRoot}a.spyglasstest`
			// Outside every project root and not watched, so nothing but the binder below reaches
			// it — the shape of an mcdoc module a path reference resolves to.
			const referencedUri = 'file:///referenced/module.spyglasstest'
			let shouldResolveReference = false
			const { project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/referenced/module.spyglasstest': 'foo',
			}, ({ meta }) => {
				meta.registerBinder<LiteralNode>(
					'literal',
					AsyncBinder.create(async (_node, ctx) => {
						if (shouldResolveReference && ctx.doc.uri === uriA) {
							await ctx.ensureBindingStarted(referencedUri)
						}
					}),
				)
			})
			try {
				// Armed only now: the initial scan already bound `a`, and a URI that is bound
				// once is skipped on every later call.
				shouldResolveReference = true
				const published: string[] = []
				project.on('documentErrored', ({ uri }) => {
					published.push(uri)
				})

				await project.analyzeProject()

				// A bind-only publish from inside the `prepare` pass would cross the two-pass
				// barrier, and the queued lints that come with it would outlive the run.
				assert.deepEqual(published, [uriA])
			} finally {
				await project.close()
			}
		})

		it('Should keep publishing through `ensureBindingStarted` outside an analysis', async () => {
			const uriA = `${ProjectRoot}a.spyglasstest`
			const referencedUri = 'file:///referenced/module.spyglasstest'
			let shouldResolveReference = false
			const { project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/referenced/module.spyglasstest': 'foo',
			}, ({ meta }) => {
				meta.registerBinder<LiteralNode>(
					'literal',
					AsyncBinder.create(async (_node, ctx) => {
						if (shouldResolveReference && ctx.doc.uri === uriA) {
							await ctx.ensureBindingStarted(referencedUri)
						}
					}),
				)
			})
			try {
				shouldResolveReference = true
				const published: string[] = []
				project.on('documentErrored', ({ uri }) => {
					published.push(uri)
				})

				await project.onDidOpen(uriA, 'spyglasstest', 1, 'foo')

				assert.ok(
					published.includes(referencedUri),
					'the editor path still publishes the document it bound on the way',
				)
			} finally {
				await project.close()
			}
		})
	})

	describe('withClientFeatureAccess()', () => {
		it('Should refuse a request made while the `prepare` pass is binding', async () => {
			const uriA = `${ProjectRoot}a.spyglasstest`
			const releaseBind = Promise.withResolvers<void>()
			const analysisBindStarted = Promise.withResolvers<void>()
			let shouldBlock = false
			const checkedUris: string[] = []
			const { project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
			}, ({ meta }) => {
				meta.registerBinder<LiteralNode>(
					'literal',
					AsyncBinder.create(async () => {
						if (shouldBlock) {
							shouldBlock = false
							analysisBindStarted.resolve()
							await releaseBind.promise
						}
					}),
				)
				meta.registerChecker<LiteralNode>('literal', (node, ctx) => {
					checkedUris.push(ctx.doc.uri)
					ctx.err.report(TestCheckerMessage, node)
				})
			})
			try {
				await project.onDidOpen(uriA, 'spyglasstest', 1, 'foo')
				shouldBlock = true
				const analysis = project.analyzeProject()
				await analysisBindStarted.promise

				checkedUris.length = 0
				const published: string[] = []
				project.on('documentErrored', ({ uri }) => {
					published.push(uri)
				})

				// Not awaited: a request that queues behind the analysis is answered only once the
				// whole corpus has been walked, so awaiting it here would hang the suite instead of
				// failing the assertion below.
				let answer: string | undefined
				const request = project
					.withClientFeatureAccess(
						uriA,
						(access) => access.kind === 'checked' ? 'checked' : access.reason,
					)
					.then((result) => {
						answer = result
					})
				await runPendingTurns()

				assert.equal(
					answer,
					'analysis-running',
					'the request did not settle while the `prepare` pass held a bind',
				)
				assert.deepEqual(checkedUris, [], 'the request checked a document mid-analysis')
				assert.deepEqual(published, [], 'the request published mid-analysis')

				releaseBind.resolve()
				await request
				await analysis
			} finally {
				releaseBind.resolve()
				await project.close()
			}
		})

		it('Should leave a queued lint undrained when it refuses a request', async () => {
			const uriA = `${ProjectRoot}a.spyglasstest`
			const uriB = `${ProjectRoot}b.spyglasstest`
			// Outside every project root and not watched, so the initial scan never bound it and
			// `ensureBindingStarted` is what runs its clearer: a bind that propagates and that
			// nothing on its path flushes afterwards, which is how `b` ends up queued and stays so.
			const referencedUri = 'file:///referenced/module.spyglasstest'
			const releaseCheck = Promise.withResolvers<void>()
			const analysisCheckStarted = Promise.withResolvers<void>()
			let shouldBlock = false
			const checkedUris: string[] = []
			const { project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
				'/referenced/module.spyglasstest': 'foo',
			}, ({ meta }) => {
				meta.registerUriSymbolClearer((uri, ctx) => {
					if (uri === referencedUri) {
						ctx.queueLint?.(uriB)
					}
				})
				meta.registerChecker<LiteralNode>('literal', async (node, ctx) => {
					checkedUris.push(ctx.doc.uri)
					ctx.err.report(TestCheckerMessage, node)
					if (shouldBlock) {
						shouldBlock = false
						analysisCheckStarted.resolve()
						await releaseCheck.promise
					}
				})
			})
			try {
				await project.onDidOpen(uriA, 'spyglasstest', 1, 'foo')
				await project.ensureBindingStarted(referencedUri)

				shouldBlock = true
				const analysis = project.analyzeProject()
				await analysisCheckStarted.promise

				checkedUris.length = 0
				const published: string[] = []
				project.on('documentErrored', ({ uri }) => {
					published.push(uri)
				})

				let answer: string | undefined
				const request = project
					.withClientFeatureAccess(
						uriA,
						(access) => access.kind === 'checked' ? 'checked' : access.reason,
					)
					.then((result) => {
						answer = result
					})
				await runPendingTurns()

				assert.equal(
					answer,
					'analysis-running',
					'the request did not settle while the `analyze` pass held a check',
				)
				// The drain reads, binds, checks and republishes every queued document. Started
				// from a feature request it does so on top of a run that is still publishing, and
				// on a symbol table that run is still walking.
				assert.deepEqual(checkedUris, [], 'the request ran checks mid-analysis')
				assert.deepEqual(published, [], 'the request drained the queued lint mid-analysis')

				releaseCheck.resolve()
				await request
				await analysis
			} finally {
				releaseCheck.resolve()
				await project.close()
			}
		})

		it('Should leave the analysis it refused running', async () => {
			const uriA = `${ProjectRoot}a.spyglasstest`
			const releaseCheck = Promise.withResolvers<void>()
			const analysisCheckStarted = Promise.withResolvers<void>()
			let shouldBlock = false
			const { project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
			}, ({ meta }) => {
				meta.registerChecker<LiteralNode>('literal', async (node, ctx) => {
					ctx.err.report(TestCheckerMessage, node)
					if (shouldBlock) {
						shouldBlock = false
						analysisCheckStarted.resolve()
						await releaseCheck.promise
					}
				})
			})
			try {
				await project.onDidOpen(uriA, 'spyglasstest', 1, 'foo')
				shouldBlock = true
				const analysis = project.analyzeProject()
				await analysisCheckStarted.promise

				await project.withClientFeatureAccess(uriA, (access) => access.kind)

				releaseCheck.resolve()
				const result = await analysis

				// A feature request arrives on every keystroke. Cancelling for one would mean a run
				// that never finishes as long as the user has the editor open.
				assert.deepEqual(result, { analyzedFiles: 2, cancelled: false, totalFiles: 2 })
			} finally {
				releaseCheck.resolve()
				await project.close()
			}
		})

		it('Should hold an analysis until the request it raced has finished', async () => {
			const uriA = `${ProjectRoot}a.spyglasstest`
			const releaseCallback = Promise.withResolvers<void>()
			const callbackStarted = Promise.withResolvers<void>()
			const { project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
			})
			try {
				await project.onDidOpen(uriA, 'spyglasstest', 1, 'foo')

				const request = project.withClientFeatureAccess(uriA, async (access) => {
					callbackStarted.resolve()
					await releaseCallback.promise
					return access.kind
				})
				await callbackStarted.promise

				// The race in the other direction: the callback is reading the state an analysis
				// starting now would rebuild underneath it.
				const progress: string[] = []
				const analysis = project.analyzeProject({
					onProgress: (done, _total, phase) => {
						progress.push(`${phase} ${done}`)
					},
				})
				await runPendingTurns()
				assert.deepEqual(
					progress,
					[],
					'the analysis started binding while the callback was still reading',
				)

				releaseCallback.resolve()
				assert.equal(await request, 'checked')
				const result = await analysis

				assert.deepEqual(result, { analyzedFiles: 2, cancelled: false, totalFiles: 2 })
				assert.ok(progress.length > 0, 'the analysis never ran once the callback finished')
			} finally {
				releaseCallback.resolve()
				await project.close()
			}
		})

		it('Should bind, check and publish for a request outside an analysis', async () => {
			const uriA = `${ProjectRoot}a.spyglasstest`
			const checkedUris: string[] = []
			const { project } = await setup({ '/root/a.spyglasstest': 'foo' }, ({ meta }) => {
				meta.registerChecker<LiteralNode>('literal', (node, ctx) => {
					checkedUris.push(ctx.doc.uri)
					ctx.err.report(TestCheckerMessage, node)
				})
			})
			try {
				await project.onDidOpen(uriA, 'spyglasstest', 1, 'foo')
				const clientManaged = project.getClientManaged(uriA)
				assert.ok(clientManaged)
				// Opening the document already produced checker results, and every stage returns
				// early once its own results are on the node. Dropping them is what leaves a check
				// for the request below to run.
				delete clientManaged.node.checkerErrors
				delete clientManaged.node.linterErrors
				checkedUris.length = 0
				const published: string[] = []
				project.on('documentErrored', ({ uri }) => {
					published.push(uri)
				})

				let access: ClientFeatureAccess | undefined
				const kind = await project.withClientFeatureAccess(uriA, (result) => {
					access = result
					return result.kind
				})

				assert.equal(kind, 'checked')
				assert.equal(access?.kind === 'checked' ? access.doc : undefined, clientManaged.doc)
				// Other code paths hold this very object, so a copy of it would leave them looking
				// at a node the request never updated.
				assert.equal(access?.kind === 'checked' ? access.node : undefined, clientManaged.node)
				assert.deepEqual(checkedUris, [uriA])
				assert.deepEqual(published, [uriA])
			} finally {
				await project.close()
			}
		})

		it('Should gate a document-less symbol read on the same analysis', async () => {
			const releaseCheck = Promise.withResolvers<void>()
			const analysisCheckStarted = Promise.withResolvers<void>()
			let shouldBlock = false
			const { project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
			}, ({ meta }) => {
				meta.registerChecker<LiteralNode>('literal', async (node, ctx) => {
					ctx.err.report(TestCheckerMessage, node)
					if (shouldBlock) {
						shouldBlock = false
						analysisCheckStarted.resolve()
						await releaseCheck.promise
					}
				})
			})
			try {
				shouldBlock = true
				const analysis = project.analyzeProject()
				await analysisCheckStarted.promise

				// A workspace symbol query names no document, so it cannot go through the document
				// gate — and it reads the one table the two-pass split exists to protect.
				let answer: string | undefined
				const request = project
					.withGlobalSymbolAccess(
						(access) => access.kind === 'readable' ? 'readable' : access.reason,
					)
					.then((result) => {
						answer = result
					})
				await runPendingTurns()
				assert.equal(
					answer,
					'analysis-running',
					'the symbol read did not settle while the analysis held a check',
				)

				releaseCheck.resolve()
				await request
				await analysis

				let sawLiveTable = false
				const kind = await project.withGlobalSymbolAccess((access) => {
					sawLiveTable = access.kind === 'readable'
						&& access.symbols === project.symbols.global
					return access.kind === 'readable' ? 'readable' : access.reason
				})

				assert.equal(kind, 'readable')
				assert.ok(sawLiveTable, 'the read was handed something other than the live table')
			} finally {
				releaseCheck.resolve()
				await project.close()
			}
		})
	})

	describe('check completion state', () => {
		it('Should mark a document whose editor check threw', async () => {
			const uri = `${ProjectRoot}a.spyglasstest`
			const { outcomes, project } = await setup(
				{ '/root/a.spyglasstest': 'foo' },
				({ meta }) => registerThrowingChecker(meta, () => true),
			)
			try {
				await project.onDidOpen(uri, 'spyglasstest', 1, 'foo')

				assert.equal(outcomes.get(uri), 'failed')
				const node = project.getClientManaged(uri)?.node
				assert.equal(node?.checkerFailed, true)
				assert.equal(node?.checkerErrors, undefined)
			} finally {
				await project.close()
			}
		})

		it('Should mark a document whose analysis check threw', async () => {
			const uriA = `${ProjectRoot}a.spyglasstest`
			const uriB = `${ProjectRoot}b.spyglasstest`
			const { outcomes, project } = await setup(
				{ '/root/a.spyglasstest': 'foo', '/root/b.spyglasstest': 'foo' },
				({ meta }) => registerThrowingChecker(meta, (uri) => uri === uriB),
			)
			try {
				const result = await project.analyzeProject()

				assert.deepEqual(result, { analyzedFiles: 1, cancelled: false, totalFiles: 2 })
				assert.equal(outcomes.get(uriA), 'complete')
				assert.equal(outcomes.get(uriB), 'failed')
			} finally {
				await project.close()
			}
		})

		it('Should mark a document whose implicit lint check threw', async () => {
			const uriA = `${ProjectRoot}a.spyglasstest`
			const uriB = `${ProjectRoot}b.spyglasstest`
			let shouldQueue = false
			const { outcomes, project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
			}, ({ meta }) => {
				meta.registerUriSymbolClearer((uri, ctx) => {
					if (shouldQueue && uri === uriA) {
						ctx.queueLint?.(uriB)
					}
				})
				registerThrowingChecker(meta, (uri) => uri === uriB)
			})
			try {
				// Armed after the initial scan so that the drain under test is the one the editor
				// path starts, on a document the editor never opened.
				shouldQueue = true
				await project.onDidOpen(uriA, 'spyglasstest', 1, 'foo')

				assert.equal(outcomes.get(uriA), 'complete')
				assert.equal(outcomes.get(uriB), 'failed')
			} finally {
				await project.close()
			}
		})

		it('Should clear the mark once a check completes', async () => {
			const uri = `${ProjectRoot}a.spyglasstest`
			let shouldThrow = true
			const { outcomes, project } = await setup(
				{ '/root/a.spyglasstest': 'foo' },
				({ meta }) => registerThrowingChecker(meta, () => shouldThrow),
			)
			try {
				await project.onDidOpen(uri, 'spyglasstest', 1, 'foo')
				assert.equal(outcomes.get(uri), 'failed')

				shouldThrow = false
				await project.onDidChange(uri, [{ text: 'foo' }], 2)

				assert.equal(outcomes.get(uri), 'complete')
				const node = project.getClientManaged(uri)?.node
				assert.equal(node?.checkerFailed, undefined)
				assert.deepEqual(node?.checkerErrors?.map((e) => e.message), [TestCheckerMessage])
			} finally {
				await project.close()
			}
		})

		it('Should drop the symbols a checker registered before it threw', async () => {
			const uri = `${ProjectRoot}a.spyglasstest`
			let shouldThrow = true
			const { project } = await setup({ '/root/a.spyglasstest': 'foo' }, ({ meta }) => {
				meta.registerChecker<LiteralNode>('literal', (_node, ctx) => {
					ctx.symbols.query(ctx.doc, TestSymbolCategory, 'declared-before-the-throw')
						.enter({ usage: { type: 'definition' } })
					if (shouldThrow) {
						throw new Error('Test checker failure')
					}
				})
			})
			try {
				await project.analyzeProject()

				// Nothing rolls a contributor's writes back when its callback throws, so the half
				// of the checker's work that did run would otherwise stay in the table — and, on a
				// closed file, be saved as part of a symbol table nothing else contradicts.
				assert.equal(
					project.symbols.query(uri, TestSymbolCategory, 'declared-before-the-throw').symbol,
					undefined,
				)

				shouldThrow = false
				await project.analyzeProject()

				// The same registration survives a check that completes, which is what makes the
				// assertion above about the failure rather than about the query.
				assert.ok(
					project.symbols.query(uri, TestSymbolCategory, 'declared-before-the-throw').symbol,
				)
			} finally {
				await project.close()
			}
		})

		it('Should not record a failure when a stage after the checker throws', async () => {
			const uri = `${ProjectRoot}a.spyglasstest`
			const { outcomes, project } = await setup(
				{ '/root/a.spyglasstest': 'foo' },
				({ meta }) => {
					meta.registerChecker<LiteralNode>('literal', (node, ctx) => {
						ctx.symbols.query(ctx.doc, TestSymbolCategory, 'declared-by-the-checker')
							.enter({ usage: { type: 'definition' } })
						ctx.err.report(TestCheckerMessage, node)
					})
				},
				{ profilers: new ThrowingLintProfilerFactory() },
			)
			try {
				await project.onDidOpen(uri, 'spyglasstest', 1, 'foo')

				// The checker ran to completion, so nothing about it failed: its diagnostics are
				// the file's real ones, its symbols are whole, and the document has no reason to
				// be checked again. Recording a failure here would also leave the node holding
				// both markers, and the early return of a later check would then read the results
				// as a success and drop the marker without a checker ever running again.
				const node = project.getClientManaged(uri)?.node
				assert.deepEqual(node?.checkerErrors?.map((e) => e.message), [TestCheckerMessage])
				assert.equal(node?.checkerFailed, undefined)
				assert.equal(outcomes.get(uri), 'complete')
				assert.deepEqual(project.getFailedCheckUris(), new Set())
				assert.ok(
					project.symbols.query(uri, TestSymbolCategory, 'declared-by-the-checker').symbol,
				)
			} finally {
				await project.close()
			}
		})

		it('Should report a document nothing checked as not run', async () => {
			const uri = `${ProjectRoot}a.spyglasstest`
			const { outcomes, project } = await setup({ '/root/a.spyglasstest': 'foo' })
			try {
				// The initial scan publishes bind-only diagnostics for every project file. Those
				// are a subset of the file's diagnostics by design, which is the state that must
				// not be mistaken for a checker that threw.
				assert.equal(outcomes.get(uri), 'not-run')

				await project.analyzeProject()

				assert.equal(outcomes.get(uri), 'complete')
			} finally {
				await project.close()
			}
		})

		it('Should restore the failure state a rolled-back rebuild changed', async () => {
			const uriA = `${ProjectRoot}a.spyglasstest`
			const uriB = `${ProjectRoot}b.spyglasstest`
			// `a` starts out failing and `b` starts out passing; the rebuild below inverts both,
			// so the rollback has to undo a removal and an addition at once.
			let failingUri = uriA
			const { outcomes, project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
			}, ({ meta }) => registerThrowingChecker(meta, (uri) => uri === failingUri))
			try {
				await project.onDidOpen(uriA, 'spyglasstest', 1, 'foo')
				await project.onDidOpen(uriB, 'spyglasstest', 1, 'foo')
				assert.equal(outcomes.get(uriA), 'failed')
				assert.equal(outcomes.get(uriB), 'complete')
				assert.deepEqual(project.getFailedCheckUris(), new Set([uriA]))

				// A rebuild rechecks the open documents with processor errors propagating, so a
				// checker that throws there fails the whole rebuild and rolls it back.
				failingUri = uriB
				await assert.rejects(project.reset())

				// Both directions: the entry the rebuild's successful check removed is back, and
				// the one its failing check added is gone.
				assert.deepEqual(project.getFailedCheckUris(), new Set([uriA]))
				assert.equal(project.getClientManaged(uriB)?.node.checkerFailed, undefined)
			} finally {
				await project.close()
			}
		})
	})

	describe('failed check persistence', () => {
		const uriA = `${ProjectRoot}a.spyglasstest`
		const uriB = `${ProjectRoot}b.spyglasstest`
		const files = { '/root/a.spyglasstest': 'foo', '/root/b.spyglasstest': 'foo' }

		/**
		 * Reported by `b`'s binder, so that the file a check fails for has diagnostics of its own
		 * rather than none: a cache that leaves an empty entry out looks exactly like one that
		 * excludes a failed check, and only the non-empty case tells the two apart.
		 */
		const partialMessage = 'Test binder partial error'

		/** Analyze a two-file project whose checker throws for `b`, then save and close. */
		async function analyzeAndClose(shouldThrow: () => boolean): Promise<SetupResult> {
			const result = await setup(files, ({ meta }) => {
				meta.registerBinder<LiteralNode>('literal', (node, ctx) => {
					if (ctx.doc.uri === uriB) {
						ctx.err.report(partialMessage, node)
					}
				})
				registerThrowingChecker(meta, (uri) => shouldThrow() && uri === uriB)
			})
			try {
				await result.project.analyzeProject()
			} finally {
				// Saves the cache, which is what every warm start below reads.
				await result.project.close()
			}
			return result
		}

		it('Should keep the diagnostics of a file whose checker threw out of the cache', async () => {
			const { errors, fs, project } = await analyzeAndClose(() => true)

			// What the failed check did publish, and what the live registry still holds so that a
			// reset can retract it. Its absence from the cache below is therefore an exclusion,
			// not an empty entry that would have been written as an empty one anyway.
			assert.deepEqual(errors.get(uriB)?.map((e) => e.message), [partialMessage])
			assert.deepEqual(
				project.cacheService.errors[uriB]?.map((e) => e.message),
				[partialMessage],
			)

			const cache = readCacheFile(fs)
			assert.deepEqual(cache.failedChecks, [uriB])
			assert.deepEqual(
				Object.keys(cache.errors),
				[uriA],
				'the partial diagnostics of the failed file must not be persisted',
			)
			// The hashes describe the content, which the failure says nothing about. They are also
			// what keeps the file recognizable as unchanged, so that the retry stays a retry
			// rather than a file the next session treats as new.
			assert.ok(cache.checksums.fileContents[uriB])
			assert.ok(cache.checksums.files[uriB])
		})

		it('Should keep saving with a failed check on record', async () => {
			const { fs, project } = await setup(
				files,
				({ meta }) => registerThrowingChecker(meta, (uri) => uri === uriB),
			)
			try {
				await project.analyzeProject()

				// `createVerifiedChecksums` refuses to publish a cache in which a tracked file has
				// an error entry but no recorded state hash, and returning `false` here is how
				// that refusal shows. Excluding the diagnostics of a failed check while keeping
				// its checksums stays clear of that condition; dropping the checksums instead
				// would walk straight into it, and every save from then on would return `false`.
				assert.equal(await project.cacheService.save(), true)
				assert.equal(await project.cacheService.save(), true)

				const cache = readCacheFile(fs)
				for (const uri of cache.failedChecks ?? []) {
					assert.ok(
						cache.checksums.fileContents[uri],
						`${uri} is on record as failed without a state hash`,
					)
				}
			} finally {
				await project.close()
			}
		})

		it('Should send a file whose checker threw back through processing on the next start', async () => {
			const first = await analyzeAndClose(() => true)
			// The retry itself belongs to a later stage; this session only has to prove the file
			// is no longer treated as settled.
			const second = createSetup(first.fs)
			try {
				await second.project.init()

				assert.deepEqual(second.project.getFailedCheckUris(), new Set([uriB]))
				assert.ok(second.project.cacheService.errors[uriA])
				assert.equal(
					second.project.cacheService.errors[uriB],
					undefined,
					'nothing may restore the diagnostics of a check that threw',
				)

				let changedFiles: string[] | undefined
				let unchangedFiles: string[] | undefined
				const cacheService = second.project.cacheService
				const validate = cacheService.validate.bind(cacheService)
				cacheService.validate = async () => {
					const result = await validate()
					changedFiles = result.changedFiles
					unchangedFiles = result.unchangedFiles
					return result
				}
				await second.project.ready({ projectRootsWatcher: second.watcher })

				assert.deepEqual(changedFiles, [uriB])
				assert.deepEqual(unchangedFiles, [uriA])
			} finally {
				await second.project.close()
			}
		})

		it('Should treat a cache without a failed check list as having none', async () => {
			const first = await analyzeAndClose(() => true)
			const cache = readCacheFile(first.fs)
			assert.deepEqual(cache.failedChecks, [uriB])
			// What a cache saved before the field existed looks like.
			delete cache.failedChecks
			writeCacheFile(first.fs, cache)

			const second = createSetup(first.fs)
			try {
				await second.project.init()

				assert.deepEqual(second.project.getFailedCheckUris(), new Set())

				let unchangedFiles: string[] | undefined
				const cacheService = second.project.cacheService
				const validate = cacheService.validate.bind(cacheService)
				cacheService.validate = async () => {
					const result = await validate()
					unchangedFiles = result.unchangedFiles
					return result
				}
				await second.project.ready({ projectRootsWatcher: second.watcher })

				assert.deepEqual(unchangedFiles?.sort(), [uriA, uriB])
			} finally {
				await second.project.close()
			}
		})

		it('Should accept a cache carrying a field it does not know', async () => {
			// The forward-compatibility half of the same property: `failedChecks` is an unknown
			// field to a build that predates it, and the schema check accepts a cache regardless
			// of what else it carries — so no version bump is needed in either direction.
			const first = await analyzeAndClose(() => false)
			const cache = readCacheFile(first.fs)
			cache['fieldFromALaterVersion'] = { anything: true }
			writeCacheFile(first.fs, cache)

			const second = createSetup(first.fs)
			try {
				await second.project.init()

				assert.ok(
					second.project.cacheService.errors[uriB],
					'a cache with an unknown field was rejected instead of adopted',
				)
			} finally {
				await second.project.close()
			}
		})
	})

	describe('failed check retry', () => {
		const uriA = `${ProjectRoot}a.spyglasstest`
		const uriB = `${ProjectRoot}b.spyglasstest`
		const files = { '/root/a.spyglasstest': 'foo', '/root/b.spyglasstest': 'foo' }

		/**
		 * Run a session that analyzes the whole project and save its cache. The returned file
		 * system is what the warm start after it reads.
		 */
		async function analyzeAndClose(
			extraInitializer: ProjectInitializer,
			extraFiles: Record<string, string> = {},
		): Promise<SetupResult> {
			const result = await setup({ ...files, ...extraFiles }, extraInitializer)
			try {
				await result.project.analyzeProject()
			} finally {
				await result.project.close()
			}
			return result
		}

		it('Should re-check a file whose checker threw on the next start', async () => {
			let shouldThrow = true
			const checkedUris: string[] = []
			const initializer: ProjectInitializer = ({ meta }) =>
				registerThrowingChecker(meta, (uri) => shouldThrow && uri === uriB, checkedUris)
			const first = await analyzeAndClose(initializer)

			shouldThrow = false
			checkedUris.length = 0
			const second = createSetup(first.fs, initializer)
			try {
				await second.project.init()
				await second.project.ready({ projectRootsWatcher: second.watcher })

				// Nothing else is rechecked: a scan binds closed files and leaves the checking to
				// an analysis, and this file is here only because its own check never finished.
				assert.deepEqual(checkedUris, [uriB])
				assert.equal(second.outcomes.get(uriB), 'complete')
				assert.deepEqual(
					second.errors.get(uriB)?.map((e) => e.message),
					[TestCheckerMessage],
				)
				assert.deepEqual(second.project.getFailedCheckUris(), new Set())
			} finally {
				await second.project.close()
			}
		})

		it('Should retry without pulling other documents into the pass', async () => {
			const uriC = `${ProjectRoot}c.spyglasstest`
			let shouldThrow = true
			let shouldQueue = false
			const checkedUris: string[] = []
			const initializer: ProjectInitializer = ({ meta }) => {
				meta.registerUriSymbolClearer((uri, ctx) => {
					if (shouldQueue && uri === uriB) {
						ctx.queueLint?.(uriC)
					}
				})
				registerThrowingChecker(meta, (uri) => shouldThrow && uri === uriB, checkedUris)
			}
			const first = await analyzeAndClose(initializer, { '/root/c.spyglasstest': 'foo' })

			shouldThrow = false
			// Armed only for the warm start, so that the queueing below can only come from the
			// retry's own rebind of `b`.
			shouldQueue = true
			checkedUris.length = 0
			const second = createSetup(first.fs, initializer)
			try {
				await second.project.init()
				await second.project.ready({ projectRootsWatcher: second.watcher })

				// The retry rebinds `b` and runs the clearer, but propagates nothing, so the
				// clearer has no way to queue `c`. One file's failed check must not turn into a
				// pass over everything that refers to it.
				assert.deepEqual(checkedUris, [uriB])
				assert.equal(
					second.outcomes.get(uriC),
					'not-run',
					'`c` was dragged into the retry instead of keeping its restored diagnostics',
				)
			} finally {
				await second.project.close()
			}
		})

		it('Should keep the marker of a closed file across a reset', async () => {
			const partialMessage = 'Test binder partial error'
			const { errors, fs, project } = await setup(files, ({ meta }) => {
				meta.registerBinder<LiteralNode>('literal', (node, ctx) => {
					if (ctx.doc.uri === uriB) {
						ctx.err.report(partialMessage, node)
					}
				})
				registerThrowingChecker(meta, (uri) => uri === uriB)
			})
			try {
				await project.analyzeProject()
				assert.deepEqual(project.getFailedCheckUris(), new Set([uriB]))
				assert.deepEqual(
					errors.get(uriB)?.map((e) => e.message),
					[partialMessage],
					'the incomplete diagnostics still reach the editor',
				)

				await project.reset()

				// A reset discards the cache; the ledger lives on the project side precisely so
				// that it does not go with it, since a failed check is a fact about processing
				// rather than about anything the cache held.
				assert.deepEqual(project.getFailedCheckUris(), new Set([uriB]))
				// The incomplete diagnostics are retracted like every other cached entry, and the
				// surviving marker is what still keeps them out of the next cache.
				assert.deepEqual(errors.get(uriB), [])
				assert.equal(await project.cacheService.save(), true)
				assert.deepEqual(readCacheFile(fs).failedChecks, [uriB])
			} finally {
				await project.close()
			}
		})

		it('Should leave nothing behind in the cache after a successful retry', async () => {
			let shouldThrow = true
			const initializer: ProjectInitializer = ({ meta }) =>
				registerThrowingChecker(meta, (uri) => shouldThrow && uri === uriB)
			const first = await analyzeAndClose(initializer)
			assert.deepEqual(readCacheFile(first.fs).failedChecks, [uriB])
			assert.equal(readCacheFile(first.fs).errors[uriB], undefined)

			shouldThrow = false
			const second = createSetup(first.fs, initializer)
			try {
				await second.project.init()
				await second.project.ready({ projectRootsWatcher: second.watcher })
			} finally {
				await second.project.close()
			}

			// End of the round trip: the retry completed, so the next cache carries the file's
			// real diagnostics and no longer names it as failed.
			const cache = readCacheFile(first.fs)
			assert.deepEqual(cache.failedChecks, [])
			assert.deepEqual(cache.errors[uriB]?.map((e) => e.message), [TestCheckerMessage])
		})

		it('Should keep the marker when a lint change invalidates the cache', async () => {
			let shouldThrow = true
			const checkedUris: string[] = []
			const initializer: ProjectInitializer = ({ meta }) =>
				registerThrowingChecker(meta, (uri) => shouldThrow && uri === uriB, checkedUris)
			const first = await analyzeAndClose(initializer)

			shouldThrow = false
			checkedUris.length = 0
			// A rule this build has no linter for: it moves the lint fingerprint the cache is
			// compared against without changing what any pass produces.
			const second = createSetup(first.fs, initializer, {
				config: { lint: { spyglasstestUnknownRule: true } },
			})
			try {
				await second.project.init()

				// Lint configuration has no say in whether a checker threw, and the invalidation
				// that follows a lint change is not a substitute for the retry: it sends every
				// cached file back through binding, and binding never checks anything.
				assert.deepEqual(second.project.getFailedCheckUris(), new Set([uriB]))

				await second.project.ready({ projectRootsWatcher: second.watcher })

				assert.deepEqual(checkedUris, [uriB])
				assert.equal(second.outcomes.get(uriB), 'complete')
				assert.deepEqual(second.project.getFailedCheckUris(), new Set())
			} finally {
				await second.project.close()
			}
		})

		it('Should keep the marker of a deleted file that is still open', async () => {
			const uri = `${ProjectRoot}a.spyglasstest`
			const { project } = await setup(
				files,
				({ meta }) => registerThrowingChecker(meta, (checked) => checked === uri),
			)
			try {
				await project.onDidOpen(uri, 'spyglasstest', 1, 'foo')
				assert.deepEqual(project.getFailedCheckUris(), new Set([uri]))

				// What the watcher reports when the file leaves the disk or the project's file
				// set. The editor still holds the buffer, so the document survives and its
				// diagnostics are not retracted — and every later edit checks it again.
				project.emit('fileDeleted', { uri })
				await drainLifecycle(project)

				assert.ok(project.getClientManaged(uri))
				assert.deepEqual(project.getFailedCheckUris(), new Set([uri]))
			} finally {
				await project.close()
			}
		})

		it('Should drop the marker of a closed document the project does not track', async () => {
			// Outside every root and not watched, so closing it is what ends the project's
			// relationship with the URI.
			const uri = 'file:///outside/a.spyglasstest'
			const { project } = await setup(
				files,
				({ meta }) => registerThrowingChecker(meta, (checked) => checked === uri),
			)
			try {
				await project.onDidOpen(uri, 'spyglasstest', 1, 'foo')
				assert.deepEqual(project.getFailedCheckUris(), new Set([uri]))

				await project.onDidClose(uri)

				// The document is removed and its diagnostics retracted in the same step, so the
				// marker goes with them rather than queueing a document nobody holds.
				assert.equal(project.getClientManaged(uri), undefined)
				assert.deepEqual(project.getFailedCheckUris(), new Set())
			} finally {
				await project.close()
			}
		})

		it('Should drop the marker of a file that is gone on the next start', async () => {
			const first = await analyzeAndClose(({ meta }) =>
				registerThrowingChecker(meta, (uri) => uri === uriB)
			)
			assert.deepEqual(readCacheFile(first.fs).failedChecks, [uriB])
			first.fs.unlinkSync('/root/b.spyglasstest')

			const second = createSetup(first.fs)
			try {
				await second.project.init()
				assert.deepEqual(second.project.getFailedCheckUris(), new Set([uriB]))

				await second.project.ready({ projectRootsWatcher: second.watcher })

				// A file that is gone is never going to be checked again, so its marker would
				// otherwise be queued and saved for every session from here on.
				assert.deepEqual(second.project.getFailedCheckUris(), new Set())
				assert.deepEqual(second.errors.get(uriA)?.map((e) => e.message), [TestCheckerMessage])
			} finally {
				await second.project.close()
			}
			assert.deepEqual(readCacheFile(first.fs).failedChecks, [])
		})
	})
})
