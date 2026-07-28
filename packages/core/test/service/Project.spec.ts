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

	await project.init()
	await project.ready({
		projectRootsWatcher: new TestFileWatcher(externals, [ProjectRoot]),
	})

	return { errors, fs, project }
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
	})
})
