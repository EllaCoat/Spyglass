import { memfs } from 'memfs'
import assert from 'node:assert/strict'
import type fsp from 'node:fs/promises'
import { describe, it } from 'node:test'
import type {
	Externals,
	FileWatcher,
	FileWatcherEventMap,
	LiteralNode,
	PosRangeLanguageError,
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
	Project,
	UriStore,
	VanillaConfig,
} from '../../lib/index.js'
import { getNodeJsExternals } from '../../lib/nodejs.js'

const CacheRoot: RootUriString = 'file:///cache/'
const ProjectRoot: RootUriString = 'file:///root/'
const TestCheckerMessage = 'Test checker error'

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

interface SetupResult {
	errors: Map<string, readonly PosRangeLanguageError[]>
	fs: ReturnType<typeof memfs>['fs']
	project: Project
	watcher: TestFileWatcher
}

async function setup(
	files: Record<string, string>,
	/** Runs after {@link testLanguageInitializer} and may therefore override its processors. */
	extraInitializer?: ProjectInitializer,
): Promise<SetupResult> {
	const { fs } = memfs(files, '/')
	const externals = getNodeJsExternals({
		cacheRoot: CacheRoot,
		logger: Logger.noop(),
		nodeFsp: fs.promises as unknown as typeof fsp,
	})

	const project = new Project({
		cacheRoot: CacheRoot,
		defaultConfig: ConfigService.merge(VanillaConfig, { env: { dependencies: [] } }),
		externals,
		initializers: extraInitializer
			? [testLanguageInitializer, extraInitializer]
			: [testLanguageInitializer],
		logger: Logger.noop(),
		projectRoots: [ProjectRoot],
	})
	const errors = new Map<string, readonly PosRangeLanguageError[]>()
	project.on('documentErrored', ({ uri, errors: documentErrors }) => {
		errors.set(uri, documentErrors)
	})

	const watcher = new TestFileWatcher(externals, [ProjectRoot])
	await project.init()
	await project.ready({ projectRootsWatcher: watcher })

	return { errors, fs, project, watcher }
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
})
