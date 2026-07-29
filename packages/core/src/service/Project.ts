import picomatch from 'picomatch'
import type { TextDocumentContentChangeEvent } from 'vscode-languageserver-textdocument'
import { TextDocument } from 'vscode-languageserver-textdocument'
import type { Externals, IntervalId } from '../common/index.js'
import {
	bufferToString,
	EventDispatcher,
	Logger,
	normalizeUri,
	SingletonPromise,
	StateProxy,
	TwoWayMap,
	UriStore,
} from '../common/index.js'
import type { AstNode } from '../node/index.js'
import { FileNode } from '../node/index.js'
import { file } from '../parser/index.js'
import { traversePreOrder } from '../processor/index.js'
import type { PosRangeLanguageError } from '../source/index.js'
import { LanguageError, Range, Source } from '../source/index.js'
import { SymbolUtil } from '../symbol/index.js'
import type { PreparedCacheContext } from './CacheService.js'
import { CacheService } from './CacheService.js'
import type { Config, PartialConfig } from './Config.js'
import { ConfigService, LinterConfigValue } from './Config.js'
import {
	BinderContext,
	CheckerContext,
	LinterContext,
	ParserContext,
	UriBinderContext,
	UriPredicateContext,
} from './Context.js'
import type { Dependency } from './Dependency.js'
import { DependencyKey } from './Dependency.js'
import { LinterErrorReporter } from './ErrorReporter.js'
import { ArchiveUriSupporter, FileService, FileUriSupporter } from './FileService.js'
import type { RootUriString } from './fileUtil.js'
import { fileUtil } from './fileUtil.js'
import type { FileWatcher } from './FileWatcher.js'
import { MetaRegistry } from './MetaRegistry.js'
import type { Profiler } from './Profiler.js'
import { ProfilerFactory } from './Profiler.js'
import type {
	ProjectChangePredicate,
	ProjectInitializer,
	ProjectInitializerContext,
} from './ProjectInitializer.js'

export type {
	AsyncProjectInitializer,
	ProjectChangePredicate,
	ProjectInitializer,
	ProjectInitializerContext,
	SyncProjectInitializer,
} from './ProjectInitializer.js'

const CacheAutoSaveInterval = 600_000 // 10 Minutes.

export interface ProjectOptions {
	cacheRoot: RootUriString
	defaultConfig?: Config
	externals: Externals
	fs?: FileService
	initializers?: readonly ProjectInitializer[]
	isDebugging?: boolean
	logger?: Logger
	profilers?: ProfilerFactory
	/**
	 * File URIs to the roots of this project.
	 */
	projectRoots: RootUriString[]
	symbols?: SymbolUtil
}

export interface ProjectReadyOptions {
	projectRootsWatcher?: FileWatcher
}

export interface AnalyzeProjectOptions {
	/**
	 * Called after each file has been processed by the current phase of the analysis.
	 *
	 * @param done The amount of files the current phase has processed so far.
	 * @param total The total amount of files to analyze.
	 * @param phase `prepare` reads and binds the file; `analyze` checks and publishes it. Both
	 * phases walk the same file list, so `done` restarts at one when `analyze` begins.
	 */
	onProgress?: (
		this: void,
		done: number,
		total: number,
		phase: 'prepare' | 'analyze',
	) => void
	/**
	 * A signal that can be used to cancel the analysis between two files. Files that have already
	 * been analyzed keep their diagnostics.
	 */
	signal?: AbortSignal
}

export interface AnalyzeProjectResult {
	/**
	 * The amount of files that made it through the checker and had their diagnostics published.
	 * Equal to `totalFiles` unless the analysis was cancelled, or a file turned out not to be
	 * readable, or processing one of them threw. A file whose checker threw does not count even
	 * though its partial diagnostics were published: what reached the editor is not the result
	 * the file should have produced.
	 */
	analyzedFiles: number
	cancelled: boolean
	totalFiles: number
}

export interface DocAndNode {
	doc: TextDocument
	node: FileNode<AstNode>
}

interface DocumentEvent extends DocAndNode {}
interface DocumentErrorEvent {
	/**
	 * How far the check stage got for the document these `errors` come from:
	 *
	 * - `complete`: a checker ran to completion, so the errors are everything the document reports
	 *   under the current config.
	 * - `failed`: a checker threw, so the errors are a subset of that — see
	 *   {@link FileNode.checkerFailed}.
	 * - `not-run`: nothing checked the document. Its errors are a subset by design, not by
	 *   failure: a bind-only publish from an initial scan, the empty diagnostics that retract a
	 *   removed or unreadable document, or entries restored from the cache.
	 */
	checkOutcome: 'complete' | 'failed' | 'not-run'
	errors: readonly PosRangeLanguageError[]
	uri: string
	version?: number
}
export interface ConfigChangeEvent {
	oldConfig: Config
	newConfig: Config
}
interface FileEvent {
	uri: string
}
interface EmptyEvent {}
interface RootsEvent {
	roots: readonly RootUriString[]
}
interface ReinitializedEvent {
	contextChanged: boolean
}
interface InitializerResult {
	ctx: Record<string, string>
	meta: MetaRegistry
	reinitializationPredicates: Set<ProjectChangePredicate>
}
interface ProjectRebuildTransaction {
	commit(): void
	rollback(): void
}
/**
 * A run of {@link Project.analyzeProject} that is in flight. The run registers itself through the
 * lifecycle queue and then works outside of it, so lifecycle operations that replace the symbol
 * table have to stop it through this handle before they start rebuilding.
 */
interface RunningAnalysis {
	controller: AbortController
	/** Settled once the run stopped reading and writing document state. */
	stopped: PromiseWithResolvers<void>
}
type ProjectDiagnosticsEvent = { data: DocumentErrorEvent; name: 'documentErrored' }
interface SymbolRegistrarEvent {
	id: string
	checksum: string | undefined
}

/**
 * How far a bind or lint pass may schedule implicit lints for other documents.
 *
 * - `full`: URI clearers queue every dependent document and cross-document
 *   linters redirect to their canonical owner. Editor-driven binds use this.
 * - `owner-only`: URI clearers stay silent while cross-document linters may
 *   still redirect to their canonical owner. The implicit lint drain uses this
 *   to stop reverse-reference traversal without suppressing owner redirects.
 * - `none`: nothing is queued. Passes that already walk every document they could
 *   redirect to — a project rebuild and {@link Project.analyzeProject} — use this.
 */
export type LintPropagation = 'full' | 'owner-only' | 'none'

export type ProjectData = Pick<
	Project,
	| 'cacheRoot'
	| 'config'
	| 'ensureBindingStarted'
	| 'externals'
	| 'fs'
	| 'isDebugging'
	| 'logger'
	| 'meta'
	| 'profilers'
	| 'projectRoots'
	| 'roots'
	| 'symbols'
	| 'ctx'
>

/* istanbul ignore next */
/**
 * Manage all tracked documents and errors.
 *
 * The four stages of processing a document:
 * 1. `read` - read the file from the external file system as a `TextDocument`.
 * 2. `parse` - Parse the `TextDocument` into an `AstNode`.
 * 3. `bind` - Bind the `AstNode` and populate both the global symbol table and the local symbol tables on the nodes.
 * 4. `check` (includes `lint`) - Check the `AstNode` with information from the symbol tables.
 *
 * **Caching**
 *
 * The global symbol table along with a list of file URIs and checksums is cached in memory and is periodically saved to disk.
 *
 * The `TextDocument`s and file `AstNode`s (including their local symbol tables) managed by the client are stored in memory until the client sends a `didClose` notification.
 *
 * Some `TextDocument`s may be cached to avoid excessive reading from the file system.
 *
 * **INIT and READY**
 *
 * When a new instance of the {@link Project} class is constructed, its INIT and READY processes are immediately started in serial.
 *
 * During the INIT process of the project, the config and language feature initialization are processed.
 * The Promise returned by the {@link init} function resolves when the INIT process is complete.
 *
 * During the READY process of the project, the whole project is scanned to populate the global symbol table.
 * The Promise returned by the {@link ready} function resolves when the READY process is complete.
 *
 * The following generally happens during the READY process:
 * 1. A list of file URIs under the project is obtained.
 * 2. The global symbol cache, if available, is loaded and validated against the know list of files.
 *    A list of files that need to be (re)processed is returned in this step.
 * 3. For each files in the new list, the file is read, parsed, and bound. Only the documents the
 *    client has open are also checked: checking the rest costs minutes on a large project and
 *    produces diagnostics nobody is looking at yet, so it belongs to {@link analyzeProject},
 *    which the user starts on demand.
 *
 * **EDITING**
 *
 * After the READY process is complete, editing text documents as signaled by the client or the file watcher results in the file being re-processed.
 */
export class Project extends EventDispatcher<{
	documentErrored: DocumentErrorEvent
	documentUpdated: DocumentEvent
	documentRemoved: FileEvent
	fileCreated: FileEvent
	fileModified: FileEvent
	fileDeleted: FileEvent
	ready: EmptyEvent
	reinitialized: ReinitializedEvent
	rootsUpdated: RootsEvent
	symbolRegistrarExecuted: SymbolRegistrarEvent
	configChanged: ConfigChangeEvent
}> {
	private static readonly RootSuffix = '/pack.mcmeta'

	/** Prevent circular binding. */
	readonly #bindingInProgressUris = new Set<string>()
	/** Number of documents currently being bound. */
	get bindingInProgressCount(): number {
		return this.#bindingInProgressUris.size
	}
	readonly #cacheSaverIntervalId: IntervalId
	readonly cacheService: CacheService
	/** URI of files that are currently managed by the language client. */
	readonly #clientManagedUris = new Set<string>()
	readonly #clientManagedDocAndNodes = new Map<string, DocAndNode>()
	/** Logical project URI to the URI used by the language client, and vice versa. */
	readonly #clientManagedUriMap = new TwoWayMap<string, string>()
	readonly #configService: ConfigService
	readonly #symbolUpToDateUris = new Set<string>()
	/**
	 * URI of files whose last check threw. Kept next to the other per-URI project state rather
	 * than in `CacheService` so that a cache reset does not silently drop it: the failure is a
	 * fact about this session's processing, not about the cached content.
	 */
	readonly #failedCheckUris = new Set<string>()
	readonly #queuedLintUris = new Set<string>()
	#queuedLintFlushPromise: Promise<void> | undefined
	/** File-deletion events whose core cleanup is run inline by `#ready`. */
	readonly #inlineFileDeletedUris = new Set<string>()
	/** File-deletion URIs processed inline by the active `#ready` generation. */
	#readyFileDeletedUris: Set<string> | undefined
	readonly #initializers: readonly ProjectInitializer[]
	#reinitializationPredicates = new Set<ProjectChangePredicate>()
	#reinitializationGeneration = 0
	#processedReinitializationGeneration = 0
	#reinitializationPromise: Promise<boolean> | undefined
	#resetGeneration = 0
	#processedResetGeneration = 0
	#resetPromise: Promise<void> | undefined
	#watcher: FileWatcher | undefined
	#registeredWatcher: FileWatcher | undefined
	#lifecyclePromise: Promise<void> = Promise.resolve()
	#configUpdatePromise: Promise<void> = Promise.resolve()
	/** The {@link analyzeProject} run that is currently working outside the lifecycle queue. */
	#activeAnalysis: RunningAnalysis | undefined
	get watchedFiles() {
		return this.#watcher?.watchedFiles ?? new UriStore()
	}

	#initPromise: Promise<this> | undefined
	#readyPromise: Promise<this> | undefined
	#isInitialized = false
	#isReady = false
	get isReady(): boolean {
		return this.#isReady
	}

	config!: Config
	readonly externals: Externals
	readonly fs: FileService
	readonly isDebugging: boolean
	readonly logger: Logger
	#meta = new MetaRegistry()
	get meta(): MetaRegistry {
		return this.#meta
	}
	readonly profilers: ProfilerFactory
	readonly projectRoots: RootUriString[]
	symbols: SymbolUtil

	#dependencyRoots: Set<RootUriString> | undefined
	#dependencyFiles: Set<string> | undefined

	#roots: readonly RootUriString[] = []
	/**
	 * All tracked root URIs. Each URI in this array is guaranteed to end with a slash (`/`).
	 *
	 * Includes the roots of all dependencies, the project root, and all data pack roots identified
	 * by `pack.mcmeta` files.
	 *
	 * Some URIs in the array may overlap with each other. In such cases, the deeper ones are guaranteed to come
	 * before the shallower ones (e.g. `file:///foo/bar/` will come before `file:///foo/`).
	 */
	get roots(): readonly RootUriString[] {
		return this.#roots
	}

	#ctx!: Record<string, string>
	/**
	 * Arbitrary information that will be included in the `project` property of all `Context`s.
	 */
	get ctx() {
		return this.#ctx
	}

	readonly #cacheRoot: RootUriString
	/**
	 * File URI to a directory where all cache files of Spyglass should be stored.
	 */
	get cacheRoot(): RootUriString {
		return this.#cacheRoot
	}

	private updateRoots(): void {
		const rawRoots = [...this.#dependencyRoots ?? [], ...this.projectRoots]
		const ans = new Set(rawRoots)
		// Identify roots indicated by `pack.mcmeta`.
		for (const file of this.getTrackedFiles()) {
			if (file.endsWith(Project.RootSuffix) && rawRoots.some((r) => file.startsWith(r))) {
				ans.add(file.slice(0, 1 - Project.RootSuffix.length) as RootUriString)
			}
		}
		this.#roots = [...ans].sort((a, b) => b.length - a.length)
		this.emit('rootsUpdated', { roots: this.#roots })
	}

	/**
	 * Get all files that are tracked and supported.
	 *
	 * Files in cached archives may not show up in the result as those files
	 * are not loaded into the memory.
	 */
	getTrackedFiles(): string[] {
		const supportedFiles = [...this.#dependencyFiles ?? [], ...this.watchedFiles]
		this.logger.info(
			`[Project#getTrackedFiles] Listed ${supportedFiles.length} supported files`,
		)
		return supportedFiles
	}

	constructor(
		{
			cacheRoot,
			defaultConfig,
			externals,
			fs = FileService.create(externals, cacheRoot),
			initializers = [],
			isDebugging = false,
			logger = Logger.create(),
			profilers = ProfilerFactory.noop(),
			projectRoots,
		}: ProjectOptions,
	) {
		super()
		this.#cacheRoot = fileUtil.ensureEndingSlash(normalizeUri(cacheRoot))
		this.externals = externals
		this.fs = fs
		this.#initializers = initializers
		this.isDebugging = isDebugging
		this.logger = logger
		this.profilers = profilers
		// `Set` keeps insertion order, so canonically-equal duplicates (e.g. `file:///C:/root/`
		// and `file:///c:/root/`) collapse into the first occurrence, preventing Config from
		// loading the same config file twice.
		this.projectRoots = Array.from(
			new Set(projectRoots.map((r) => fileUtil.ensureEndingSlash(normalizeUri(r)))),
		)

		this.cacheService = new CacheService(this.#cacheRoot, this)
		this.#configService = new ConfigService(this, defaultConfig)
		this.symbols = new SymbolUtil({})

		this.#ctx = {}

		this.logger.info(`[Project] [init] cacheRoot = ${this.#cacheRoot}`)
		this.logger.info(`[Project] [init] projectRoots = ${projectRoots.join(' ')}`)

		// Config updates do not go through the `#resetGeneration` barrier: `applyConfigUpdate`
		// calls `resetOnce` directly and never coalesces with manual `reset()` calls. Both
		// still run serially in `enqueueLifecycle` (FIFO) order, so a config update and a
		// manual reset cannot interleave.
		this.#configService.on('changed', ({ config }) => {
			// Even an update that keeps the cache context fingerprint intact swaps the lint config
			// the analysis reports against, so its remaining files would be judged by other rules
			// than the ones already published.
			this.cancelActiveAnalysis('Project#applyConfigUpdate')
			this.#configUpdatePromise = this.enqueueLifecycle(() => this.applyConfigUpdate(config))
				.catch(e => this.logger.error('[Project] [Config] Failed applying update', e))
		}).on(
			'error',
			({ error, uri }) => this.logger.error(`[Project] [Config] Failed loading ${uri}`, error),
		)

		this.#cacheSaverIntervalId = setInterval(
			() => {
				void this.cacheService.save().catch(e =>
					this.logger.error('[Project#cache-autosave]', e)
				)
			},
			CacheAutoSaveInterval,
		)
		// Unref the autosave interval on Node.js so that a `Project` never keeps the process
		// alive on its own. `unref` does not exist on browser interval IDs (numbers).
		this.#cacheSaverIntervalId.unref?.()

		this.on('documentUpdated', async ({ doc, node }) => {
			// if (!this.#isReady) {
			// 	return
			// }
			await this.emitAsync('documentErrored', this.createDocumentErrorEvent(doc, node))
		}).on('documentRemoved', ({ uri }) => {
			this.emit('documentErrored', { checkOutcome: 'not-run', errors: [], uri })
		}).on('fileCreated', ({ uri }) => {
			this.cancelActiveAnalysis(`[Project#fileCreated] ${uri}`)
			this.cacheService.markFileChange(uri)
			const process = async () => {
				// Waited for at the front of the queued work instead of in the handler itself, so
				// the watcher event still returns synchronously and only the processing below is
				// held back. Signalling alone would let the analysis publish the AST it already
				// holds after this file event republished the current one.
				await this.settleActiveAnalysis(`[Project#fileCreated] ${uri}`)
				if (uri.endsWith(Project.RootSuffix)) {
					this.updateRoots()
				}
				this.bindUri(uri)
				await this.ensureBindingStarted(uri)
				if (this.isOnlyWatched(uri)) {
					// `ensureBindingStarted` publishes a bind-only node, so the new file would
					// keep parser and binder errors only. Requeue it so the drain below adds the
					// checker and linter diagnostics.
					this.queueLint(uri)
				}
				await this.flushQueuedLints()
			}
			if (this.shouldReinitializeFor(uri)) {
				this.requestReinitialization(uri, process)
				return
			}
			this.requestLifecycle(process, `[Project#fileCreated] ${uri}`)
		}).on('fileModified', ({ uri }) => {
			this.cancelActiveAnalysis(`[Project#fileModified] ${uri}`)
			this.cacheService.markFileChange(uri)
			const process = async () => {
				// See `fileCreated`: the wait belongs inside the queued work, not in the handler.
				await this.settleActiveAnalysis(`[Project#fileModified] ${uri}`)
				this.#symbolUpToDateUris.delete(uri)
				this.removeCachedTextDocument(uri)
				if (this.isOnlyWatched(uri)) {
					await this.ensureBindingStarted(uri)
					// `ensureBindingStarted` publishes a bind-only node, which replaces
					// whatever the last analysis published for this document. Requeue it
					// so the drain below restores the checker and linter diagnostics.
					this.queueLint(uri)
				}
				await this.flushQueuedLints()
			}
			if (this.shouldReinitializeFor(uri)) {
				this.requestReinitialization(uri, process)
				return
			}
			this.requestLifecycle(process, `[Project#fileModified] ${uri}`)
		}).on('fileDeleted', ({ uri }) => {
			// The three watcher events change the very file set the analysis walks, so its result
			// would describe a mixture of the corpus before and after the change while claiming to
			// have covered all of it.
			this.cancelActiveAnalysis(`[Project#fileDeleted] ${uri}`)
			this.cacheService.markFileChange(uri)
			const readyFileDeletedUris = this.#readyFileDeletedUris
			const process = async () => {
				if (readyFileDeletedUris?.has(uri)) {
					return
				}
				// See `fileCreated`: the wait belongs inside the queued work, not in the handler.
				await this.settleActiveAnalysis(`[Project#fileDeleted] ${uri}`)
				await this.processFileDeleted(uri)
			}
			if (this.#inlineFileDeletedUris.has(uri)) {
				// `#ready` has already taken responsibility for the cleanup, but a
				// removed pack/config file must retain its reinitialization trigger.
				if (this.shouldReinitializeFor(uri)) {
					this.requestReinitialization(uri, () => {})
				}
				return
			}
			if (this.shouldReinitializeFor(uri)) {
				this.requestReinitialization(uri, process)
				return
			}
			this.requestLifecycle(process, `[Project#fileDeleted] ${uri}`)
		})
	}

	private async processFileDeleted(uri: string, forceDocumentRemoval = false): Promise<void> {
		if (uri.endsWith(Project.RootSuffix)) {
			this.updateRoots()
		}
		this.#symbolUpToDateUris.delete(uri)
		this.cacheService.clearFileChange(uri)
		this.clearUriSymbolLocations(uri)
		if (forceDocumentRemoval) {
			this.removeCachedTextDocument(uri)
			this.emit('documentRemoved', { uri })
		} else {
			this.tryClearingCache(uri)
		}
		await this.flushQueuedLints()
	}

	/**
	 * Load the config file and initialize parsers and processors.
	 */
	async init(): Promise<this> {
		return (this.#initPromise ??= this.#init())
	}

	async #init(): Promise<this> {
		this.#isInitialized = false

		const __profiler = this.profilers.get('project#init')

		await this.cacheService.loadMetadata()
		__profiler.task('Load Cache Metadata')

		this.config = await this.#configService.load()
		__profiler.task('Load Config')

		this.commitInitializers(await this.runInitializers(false))
		__profiler.task('Initialize')

		const { symbols } = await this.cacheService.activate({
			initializerContext: this.#ctx,
			lint: this.config.lint,
		})
		this.symbols = new SymbolUtil(symbols)
		this.symbols.buildCache()
		__profiler.task('Activate Cache').finalize()

		this.#isInitialized = true

		return this
	}

	private async runInitializers(failOnError: boolean): Promise<InitializerResult> {
		const meta = new MetaRegistry()
		const reinitializationPredicates = new Set<ProjectChangePredicate>()
		const initCtx: ProjectInitializerContext = {
			cacheRoot: this.cacheRoot,
			config: this.config,
			externals: this.externals,
			isDebugging: this.isDebugging,
			logger: this.logger,
			meta,
			profilers: this.profilers,
			projectRoots: this.projectRoots,
			reinitializeOnChange: (predicate) => reinitializationPredicates.add(predicate),
		}
		const results = await Promise.allSettled(this.#initializers.map((init) => init(initCtx)))
		let ctx: Record<string, string> = {}
		const errors: unknown[] = []
		results.forEach((result, i) => {
			if (result.status === 'rejected') {
				errors.push(result.reason)
				this.logger.error(
					`[Project] [runInitializers] [${i}] “${this.#initializers[i].name}”`,
					result.reason,
				)
			} else if (result.value) {
				ctx = { ...ctx, ...result.value }
			}
		})
		if (failOnError && errors.length > 0) {
			throw new AggregateError(errors, 'One or more project initializers failed')
		}
		return { ctx, meta, reinitializationPredicates }
	}

	private commitInitializers(result: InitializerResult): void {
		this.#meta = result.meta
		this.#reinitializationPredicates = result.reinitializationPredicates
		this.#ctx = result.ctx
	}

	/**
	 * Snapshot all project and cache state that a rebuild mutates. Reinitialization and manual
	 * cache resets share this boundary so neither operation can expose a failed partial rebuild.
	 */
	private beginProjectRebuildTransaction(): ProjectRebuildTransaction {
		const snapshot = {
			bindingInProgressUris: new Set(this.#bindingInProgressUris),
			clientManagedDocAndNodes: new Map(this.#clientManagedDocAndNodes),
			ctx: this.#ctx,
			dependencyFiles: this.#dependencyFiles,
			dependencyRoots: this.#dependencyRoots,
			failedCheckUris: new Set(this.#failedCheckUris),
			isReady: this.#isReady,
			meta: this.#meta,
			queuedLintUris: new Set(this.#queuedLintUris),
			readyPromise: this.#readyPromise,
			reinitializationPredicates: this.#reinitializationPredicates,
			roots: this.#roots,
			symbols: this.symbols,
			symbolUpToDateUris: new Set(this.#symbolUpToDateUris),
		}
		const cacheTransaction = this.cacheService.beginTransaction()
		let settled = false
		const settle = () => {
			if (settled) {
				throw new Error('Project rebuild transaction has already settled')
			}
			settled = true
		}
		return {
			commit: () => {
				settle()
				cacheTransaction.commit()
			},
			rollback: () => {
				settle()
				cacheTransaction.rollback()
				this.#bindingInProgressUris.clear()
				snapshot.bindingInProgressUris.forEach(uri => this.#bindingInProgressUris.add(uri))
				this.#clientManagedDocAndNodes.clear()
				snapshot.clientManagedDocAndNodes.forEach((value, uri) =>
					this.#clientManagedDocAndNodes.set(uri, value)
				)
				this.#ctx = snapshot.ctx
				this.#dependencyFiles = snapshot.dependencyFiles
				this.#dependencyRoots = snapshot.dependencyRoots
				this.#failedCheckUris.clear()
				snapshot.failedCheckUris.forEach(uri => this.#failedCheckUris.add(uri))
				this.#isReady = snapshot.isReady
				this.#meta = snapshot.meta
				this.#queuedLintUris.clear()
				snapshot.queuedLintUris.forEach(uri => this.#queuedLintUris.add(uri))
				this.#readyPromise = snapshot.readyPromise
				this.#reinitializationPredicates = snapshot.reinitializationPredicates
				this.#roots = snapshot.roots
				this.symbols = snapshot.symbols
				this.#symbolUpToDateUris.clear()
				snapshot.symbolUpToDateUris.forEach(uri => this.#symbolUpToDateUris.add(uri))
			},
		}
	}

	/**
	 * Run project initializers again and rebuild the project when their cache
	 * context changed.
	 */
	async reinitialize(): Promise<this> {
		await this.scheduleReinitialization()
		return this
	}

	private scheduleReinitialization(): Promise<boolean> {
		// A reinitialization commits a new `MetaRegistry` and initializer context even when it does
		// not rebuild, so the parsers, binders, and checkers an analysis is running would change
		// under it either way.
		this.cancelActiveAnalysis('Project#reinitialize')
		this.#reinitializationGeneration += 1
		if (!this.#reinitializationPromise) {
			const operation = this.enqueueLifecycle(() => this.drainReinitializations())
			const tracked = operation.finally(() => {
				if (this.#reinitializationPromise === tracked) {
					this.#reinitializationPromise = undefined
				}
			})
			this.#reinitializationPromise = tracked
		}
		return this.#reinitializationPromise
	}

	/**
	 * Coalescing loop behind {@link scheduleReinitialization}, mirroring {@link drainResets} but
	 * on the independent `#reinitializationGeneration` barrier: reinitializations only coalesce
	 * with each other, never with resets, and the two kinds serialize solely via
	 * `enqueueLifecycle` (FIFO) order. Unlike `drainResets` it returns whether the last pass
	 * changed the cache context, which is why the two drains stay separate implementations.
	 */
	private async drainReinitializations(): Promise<boolean> {
		// See `drainResets`: no analysis can slip in between two iterations of the loop below.
		await this.settleActiveAnalysis('Project#reinitialize')
		let lastError: unknown
		let contextChanged = false
		while (
			this.#processedReinitializationGeneration < this.#reinitializationGeneration
		) {
			const generation = this.#reinitializationGeneration
			try {
				contextChanged = await this.reinitializeOnce()
				lastError = undefined
			} catch (e) {
				lastError = e
			}
			this.#processedReinitializationGeneration = generation
		}
		if (lastError !== undefined) {
			throw lastError
		}
		return contextChanged
	}

	private async reinitializeOnce(): Promise<boolean> {
		if (!this.#isInitialized) {
			return false
		}

		this.logger.info('[Project#reinitialize] Initiated...')
		const staged = await this.runInitializers(true)
		const preparedContext = await this.cacheService.prepareContext({
			initializerContext: staged.ctx,
			lint: this.config.lint,
		})
		if (!preparedContext.changed) {
			this.commitInitializers(staged)
			this.emit('reinitialized', { contextChanged: false })
			return false
		}

		const transaction = this.beginProjectRebuildTransaction()
		let diagnostics: ProjectDiagnosticsEvent[]
		try {
			this.commitInitializers(staged)
			diagnostics = await this.rebuildProjectFromEmptyCache()
			this.cacheService.commitContext(preparedContext)
			transaction.commit()
		} catch (e) {
			transaction.rollback()
			throw e
		}
		await this.publishRebuildEvents(diagnostics, false)
		this.emit('reinitialized', { contextChanged: true })
		return true
	}

	private shouldReinitializeFor(uri: string): boolean {
		for (const predicate of this.#reinitializationPredicates) {
			try {
				if (predicate(uri)) {
					return true
				}
			} catch (e) {
				this.logger.error('[Project#shouldReinitializeFor]', e)
			}
		}
		return false
	}

	private enqueueLifecycle<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = this.#lifecyclePromise.then(operation)
		this.#lifecyclePromise = result.then(() => undefined, () => undefined)
		return result
	}

	private requestLifecycle(operation: () => Promise<void> | void, label: string): void {
		this.enqueueLifecycle(operation).catch(e => this.logger.error(label, e))
	}

	/**
	 * Ask the analysis working outside the lifecycle queue, if any, to stop at its next file
	 * boundary. Raising the flag is synchronous, which is why callers that are about to enqueue a
	 * lifecycle operation signal here first: the analysis then winds down while the operations
	 * already queued ahead of them run, instead of only once their own reaches the front.
	 *
	 * Signalling on its own is never enough. Every path that then mutates the state the analysis
	 * reads has to await {@link settleActiveAnalysis} before it does so.
	 *
	 * @param reason The lifecycle path that invalidated the analysis, e.g. `Project#reset`.
	 */
	private cancelActiveAnalysis(reason: string): void {
		const analysis = this.#activeAnalysis
		if (!analysis || analysis.controller.signal.aborted) {
			return
		}
		this.logger.info(`[Project#analyzeProject] Cancelling for ${reason}`)
		analysis.controller.abort()
	}

	/**
	 * Cancel the running analysis and wait until it finished the file it is on. Two kinds of
	 * operation go through this first. One replaces the symbol table: emptying it while a file is
	 * halfway through its check publishes diagnostics derived from a table that no longer exists,
	 * which is the very race the two-pass split in {@link analyzeProject} exists to avoid. The
	 * other replaces the content of a single document — a watcher event or an editor notification.
	 * There the analysis still holds the pre-change AST, and a publish it completes afterwards
	 * puts the diagnostics of that older content back on top of the fresh ones.
	 *
	 * Await this from inside the lifecycle queue, or from {@link close}, which drains that queue
	 * rather than entering it. An analysis enters the queue exactly once, to register itself, and
	 * never re-enters it afterwards, so a queued operation waiting for the analysis cannot
	 * deadlock against it.
	 */
	private async settleActiveAnalysis(reason: string): Promise<void> {
		const analysis = this.#activeAnalysis
		this.cancelActiveAnalysis(reason)
		await analysis?.stopped.promise
	}

	private requestReinitialization(
		uri: string,
		processFileEvent: () => Promise<void> | void,
	): void {
		this.scheduleReinitialization()
			.then((contextChanged) => {
				if (!contextChanged) {
					return this.enqueueLifecycle(processFileEvent)
				}
				return undefined
			}, (e) => {
				this.logger.error(`[Project#reinitialize] Failed after change to ${uri}`, e)
				return this.enqueueLifecycle(processFileEvent)
			})
			.catch(e => this.logger.error(`[Project#fileEvent] Failed processing ${uri}`, e))
	}

	/**
	 * Finish the initial run of parsing and binding the entire project. Only the documents the
	 * client has open are checked as well; see {@link analyzeProject} for the rest of the corpus.
	 */
	async ready(options: ProjectReadyOptions = {}): Promise<this> {
		return (this.#readyPromise ??= this.enqueueLifecycle(() => this.runReady(options)))
	}

	private async runReady(
		options: ProjectReadyOptions = {},
		diagnostics?: ProjectDiagnosticsEvent[],
		propagateProcessorErrors = false,
	): Promise<this> {
		const readyFileDeletedUris = new Set<string>()
		this.#readyFileDeletedUris = readyFileDeletedUris
		try {
			return await this.#ready(
				options,
				diagnostics,
				propagateProcessorErrors,
				readyFileDeletedUris,
			)
		} finally {
			if (this.#readyFileDeletedUris === readyFileDeletedUris) {
				this.#readyFileDeletedUris = undefined
			}
		}
	}

	async #ready(
		{ projectRootsWatcher }: ProjectReadyOptions = {},
		diagnostics?: ProjectDiagnosticsEvent[],
		propagateProcessorErrors = false,
		readyFileDeletedUris = new Set<string>(),
	): Promise<this> {
		if (!this.#isInitialized) {
			throw new Error('Project.ready() must be called after Project.init() resolves')
		}

		this.#isReady = false
		const stagedDiagnostics = diagnostics ?? []
		const shouldPublishEvents = diagnostics === undefined

		if (projectRootsWatcher !== undefined) {
			this.#watcher = projectRootsWatcher
		}

		const getDependencies = async () => {
			const dependencies: Dependency[] = []
			for (const input of this.config.env.dependencies) {
				try {
					if (DependencyKey.is(input)) {
						const provider = this.meta.getDependencyProvider(input)
						if (!provider) {
							throw new Error(`No provider for ${input}`)
						}

						dependencies.push(await provider())
						this.logger.info(
							`[Project] [getDependencies] Executed provider “${input}”`,
						)
					} else {
						const stats = await this.externals.fs.stat(input)
						if (stats.isDirectory()) {
							dependencies.push({ type: 'directory', uri: input })
						} else if (stats.isFile()) {
							dependencies.push({ type: 'tarball-file', uri: input })
						} else {
							throw new Error('Unsupported file entry type')
						}
					}
				} catch (e) {
					this.logger.error(`[Project] [getDependencies] Bad dependency “${input}”`, e)
				}
			}
			return dependencies
		}
		const listDependencyFiles = async () => {
			const dependencies = await getDependencies()
			const fileUriSupporter = await FileUriSupporter.create(
				dependencies,
				this.externals,
				this.logger,
			)
			const archiveUriSupporter = await ArchiveUriSupporter.create(
				dependencies,
				this.externals,
				this.logger,
			)
			this.fs.register('file:', fileUriSupporter, true)
			this.fs.register(ArchiveUriSupporter.Protocol, archiveUriSupporter, true)
		}
		const listProjectFiles = async () => {
			if (!this.#watcher) {
				return
			}

			if (this.#registeredWatcher !== this.#watcher) {
				this.#watcher
					.on('add', (uri) => {
						if (this.shouldExclude(uri)) {
							return
						}
						this.emit('fileCreated', { uri })
					})
					.on('change', (uri) => {
						if (this.shouldExclude(uri)) {
							return
						}
						this.emit('fileModified', { uri })
					})
					.on('unlink', (uri) => {
						// No `this.shouldExclude(uri)` check here as `unlink` events may be sent for
						// hot-reload file exclusions. We want to be able to clean up the symbols for these
						// excluded files.
						this.emit('fileDeleted', { uri })
					})
					.on('error', (e) => {
						this.logger.error('[Project#watcher]', e)
					})
				this.#registeredWatcher = this.#watcher
				await this.#watcher.ready()
			}
		}

		const __profiler = this.profilers.get('project#ready')

		await Promise.all([listDependencyFiles(), listProjectFiles()])

		this.#dependencyFiles = new Set([...this.fs.listFiles()]
			.filter((uri) => !this.shouldExclude(uri)))
		this.#dependencyRoots = new Set(this.fs.listRoots())

		this.updateRoots()
		__profiler.task('List URIs')

		for (const [id, { checksum, registrar }] of this.meta.symbolRegistrars) {
			const cacheChecksum = this.cacheService.checksums.symbolRegistrars[id]
			if (cacheChecksum === undefined || checksum !== cacheChecksum) {
				this.symbols.clear({ contributor: `symbol_registrar/${id}` })
				this.symbols.contributeAs(`symbol_registrar/${id}`, () => {
					registrar(this.symbols, { logger: this.logger })
				})
				this.emit('symbolRegistrarExecuted', { id, checksum })
			} else {
				this.logger.info(`[SymbolRegistrar] Skipped “${id}” thanks to cache ${checksum}`)
			}
		}
		__profiler.task('Register Symbols')

		for (const [uri, values] of Object.entries(this.cacheService.errors)) {
			stagedDiagnostics.push({
				// Restored, not produced: nothing checked these documents in this session, and the
				// cache does not record how the session that produced them ended.
				data: { checkOutcome: 'not-run', errors: values, uri },
				name: 'documentErrored',
			})
		}
		__profiler.task('Pop Errors')

		const { addedFiles, changedFiles, removedFiles } = await this.cacheService.validate()
		this.logger.info(
			`[Project#ready] Files added/changed/removed: ${addedFiles.length}/${changedFiles.length}/${removedFiles.length}`,
		)
		const freshlyPublishedUris = new Set<string>()
		for (const uri of removedFiles) {
			// A queued fileDeleted lifecycle task would run only after the current
			// ready operation. Perform the same cleanup now so READY cannot expose
			// deleted symbols or cached diagnostics; still dispatch the public event
			// for cache/config listeners while suppressing only our queued duplicate.
			this.#inlineFileDeletedUris.add(uri)
			try {
				this.emit('fileDeleted', { uri })
			} finally {
				this.#inlineFileDeletedUris.delete(uri)
			}
			await this.processFileDeleted(uri, true)
			readyFileDeletedUris.add(uri)
			freshlyPublishedUris.add(uri)
		}
		__profiler.task('Validate Cache')

		if (addedFiles.length > 0) {
			this.bindUri(addedFiles)
		}
		__profiler.task('Bind URIs')

		const files = [...addedFiles, ...changedFiles].sort(this.meta.uriSorter)
		__profiler.task('Sort URIs')

		const fileCountByExtension = new Map<string, number>()
		for (const file of files) {
			const ext = fileUtil.extname(file)?.replace(/^\./, '')
			if (ext) {
				fileCountByExtension.set(ext, (fileCountByExtension.get(ext) ?? 0) + 1)
			}
		}
		this.logger.info(`[Project#ready] == Files to bind ==`)
		for (const [ext, count] of fileCountByExtension.entries()) {
			this.logger.info(`[Project#ready] File extension ${ext}: ${count}`)
		}

		// Only the reset path (`restartForRebuild`) passes `diagnostics` in. That path stages
		// instead of streaming, and it publishes nothing for the files it binds: whole-corpus
		// checker/linter results belong to `analyzeProject`, and a bind-only diagnostic published
		// here would be a subset of them that no later pass replaces.
		const __parseProfiler = this.profilers.get('project#ready#parse', 'top-n', 50)
		const __bindProfiler = this.profilers.get('project#ready#bind', 'top-n', 50)
		for (const uri of files) {
			await this.#parseAndBindForReady(
				uri,
				__parseProfiler,
				__bindProfiler,
				shouldPublishEvents,
				propagateProcessorErrors,
				freshlyPublishedUris,
			)
		}
		__parseProfiler.finalize()
		__bindProfiler.finalize()
		__profiler.task('Bind Files')

		await this.rebindAndCheckClientManaged(propagateProcessorErrors)
		this.#isReady = true
		__profiler.finalize()
		// `publishRebuildEvents` publishes the staged (possibly stale) cache
		// diagnostics, drains the lints the scan above queued on top of them, and
		// only then emits READY. On the staged path the caller runs it after this
		// method settles, and passes `false` for the drain — see its JSDoc.
		// Re-scanned files already published fresh diagnostics during the scan, so
		// their pre-scan staged entries are dropped here: republishing them would
		// roll the fresh results back to stale ones.
		if (shouldPublishEvents) {
			const staged = stagedDiagnostics.filter(event => !freshlyPublishedUris.has(event.data.uri))
			await this.publishRebuildEvents(staged, true)
		}

		return this
	}

	/**
	 * Behavior of the `Project` instance is undefined after this function has settled.
	 */
	async close(): Promise<void> {
		clearInterval(this.#cacheSaverIntervalId)
		// An analysis runs outside the lifecycle queue, so the drain below never waits for it. Left
		// alone it would keep reading and publishing into a project that is being torn down.
		// Signalled here so that it winds down while the watcher and the queue are still closing.
		this.cancelActiveAnalysis('Project#close')
		await this.#watcher?.close()
		for (;;) {
			const lifecycle = this.#lifecyclePromise
			await lifecycle
			if (lifecycle === this.#lifecyclePromise) {
				break
			}
		}
		// Awaited after the drain rather than before it: an `analyzeProject` call that was still
		// waiting to register itself when `close` started registers during the drain, and only a
		// wait placed here covers that case too. Without it a binder, a checker, or a publish
		// would still be running once `close` settled, and its cache save would race the one
		// below.
		await this.settleActiveAnalysis('Project#close')
		try {
			await this.cacheService.save()
		} catch (e) {
			this.logger.error('[Project#close] Failed saving cache', e)
		}
	}

	/**
	 * Run the initial scan again on the watcher this project already holds: relist the dependency
	 * and project files, drop the binding state, validate the cache and bind what it reports as
	 * added or changed, recheck the documents the client has open, then publish the staged
	 * diagnostics and READY the way {@link ready} does. The cache itself is kept, which is what
	 * separates this from {@link reset}: a reset discards it and rebuilds the symbol table and the
	 * recorded hashes from nothing.
	 *
	 * Unlike {@link reset}, this neither enters the lifecycle queue nor cancels and awaits a
	 * running analysis, so nothing makes it exclusive with the operations that read the state it
	 * mutates. Run alongside {@link analyzeProject} it removes and re-registers symbols while the
	 * passes walk them, which is the race the two-pass split of that method exists to prevent; run
	 * alongside a reset, a config update, or a watcher event, two rebuilds interleave on one symbol
	 * table and one `#readyPromise`.
	 *
	 * The caller therefore owns the exclusion: invoke it only when no analysis and no other
	 * lifecycle operation is in flight. Use {@link reset} where those guarantees are needed.
	 */
	async restart(): Promise<void> {
		this.#bindingInProgressUris.clear()
		this.#symbolUpToDateUris.clear()
		const readyPromise = this.runReady({ projectRootsWatcher: this.#watcher })
		this.#readyPromise = readyPromise
		await readyPromise
	}

	private async restartForRebuild(diagnostics: ProjectDiagnosticsEvent[]): Promise<void> {
		this.#bindingInProgressUris.clear()
		this.#symbolUpToDateUris.clear()
		const readyPromise = this.runReady(
			{ projectRootsWatcher: this.#watcher },
			diagnostics,
			true,
		)
		this.#readyPromise = readyPromise
		await readyPromise
	}

	/**
	 * Schedule a complete project cache reset behind other project lifecycle operations.
	 *
	 * A reset rebuilds the cache, the symbol table, and the recorded file hashes, binds every
	 * tracked file, and rechecks the documents the client has open. It does not check closed
	 * documents: their diagnostics are {@link analyzeProject}'s result, and a reset discards the
	 * cache entry that held them, so they stay absent until the next analysis.
	 *
	 * Concurrent calls coalesce through the `#resetGeneration` counter: each call bumps the
	 * generation and awaits the single in-flight {@link drainResets} pass instead of enqueueing
	 * another lifecycle operation. Resets requested while a drain is already rebuilding are
	 * absorbed by the next loop iteration, which jumps straight to the latest generation.
	 */
	async reset(): Promise<void> {
		// Signalled before the drain is queued so that a running analysis winds down while the
		// operations ahead of the reset are still executing, instead of only once the drain runs.
		this.cancelActiveAnalysis('Project#reset')
		this.#resetGeneration += 1
		if (!this.#resetPromise) {
			const operation = this.enqueueLifecycle(() => this.drainResets())
			const tracked = operation.finally(() => {
				if (this.#resetPromise === tracked) {
					this.#resetPromise = undefined
				}
			})
			this.#resetPromise = tracked
		}
		await this.#resetPromise
	}

	/** Kept as the public cache-reset API while callers migrate to {@link reset}. */
	async resetCache(): Promise<void> {
		await this.reset()
	}

	/**
	 * Coalescing loop behind {@link reset}: snapshot `#resetGeneration`, run one full rebuild,
	 * then mark the snapshot as processed. Resets requested mid-rebuild raise the generation and
	 * cost exactly one extra iteration against the latest state. This counter only serializes
	 * reset barriers; it is unrelated to `CacheService`'s `#hashUpdateGeneration`, which guards
	 * save atomicity.
	 */
	private async drainResets(): Promise<void> {
		// Once here, no analysis can register behind us: `analyzeProject` registers through this
		// same queue, so a request that arrives mid-drain waits for the whole drain. One wait
		// therefore covers every iteration of the loop below.
		await this.settleActiveAnalysis('Project#reset')
		let lastError: unknown
		for (;;) {
			while (this.#processedResetGeneration < this.#resetGeneration) {
				const generation = this.#resetGeneration
				try {
					await this.resetOnce()
					lastError = undefined
				} catch (e) {
					lastError = e
				}
				this.#processedResetGeneration = generation
			}
			if (lastError !== undefined) {
				throw lastError
			}
			await this.saveCacheAfterRebuild('Project#drainResets')
			// A reset requested during the potentially long save still has to pass through a
			// rebuild before its promise settles, so recheck the generation after every save.
			if (this.#processedResetGeneration >= this.#resetGeneration) {
				break
			}
		}
	}

	/**
	 * Persist the cache before a settled rebuild returns to its caller. Otherwise the symbol table
	 * and the file hashes the rebuild produced live only in memory until the 10-minute autosave
	 * or `close()`, and a crash in that window loses them. Keeping this best-effort save in the
	 * lifecycle queue serializes it with resets and config updates, and every caller runs it once
	 * per settled rebuild batch rather than once per {@link resetOnce} pass — `CacheService#save`
	 * costs seconds on a large corpus, so a coalescing loop must not repeat it per iteration.
	 * Editor-driven bind/check mutations do not use that queue: if one changes the cache generation
	 * during this save, `CacheService#save` reports the skip by returning false — outside the narrow
	 * window it leaves unguarded between its last snapshot check and the rename — and the next
	 * autosave or `close()` can persist the state instead. Both the skip and a failed save are
	 * logged and swallowed; callers continue as if the rebuild succeeded.
	 *
	 * Because the rebuild just bound every tracked file, this path saves with
	 * `trustRecordedHashes` so that `CacheService` reuses the checksums binding recorded rather
	 * than reading the whole corpus a second time. The autosave interval and `close()` run
	 * arbitrarily long after a rebuild and keep the full verification.
	 *
	 * @param origin Identifies the calling path in the logs, e.g. `Project#drainResets`.
	 */
	private async saveCacheAfterRebuild(origin: string): Promise<void> {
		try {
			const saved = await this.cacheService.save({ trustRecordedHashes: true })
			if (!saved) {
				this.logger.warn(`[${origin}] Finished rebuild without saving cache`)
			}
		} catch (e) {
			this.logger.error(`[${origin}] Failed saving cache`, e)
		}
	}

	private async resetOnce(preparedContext?: PreparedCacheContext): Promise<void> {
		const transaction = this.beginProjectRebuildTransaction()
		let diagnostics: ProjectDiagnosticsEvent[]
		try {
			diagnostics = await this.rebuildProjectFromEmptyCache()
			if (preparedContext) {
				this.cacheService.commitContext(preparedContext)
			}
			transaction.commit()
		} catch (e) {
			transaction.rollback()
			throw e
		}
		await this.publishRebuildEvents(diagnostics, false)
	}

	private async rebuildProjectFromEmptyCache(): Promise<ProjectDiagnosticsEvent[]> {
		this.logger.info('[Project#resetCache] Initiated...')
		this.#isReady = false
		this.reparseClientManaged()
		// Lints queued against the discarded symbol table would otherwise drain at the first
		// `check` after the rebuild and republish diagnostics derived from it.
		this.#queuedLintUris.clear()
		const diagnostics: ProjectDiagnosticsEvent[] = []

		// Retract the diagnostics the discarded cache restored. Only closed documents need this:
		// an open one is republished from its fresh check by `publishRebuildEvents`, so clearing
		// it first would only make its diagnostics blink. Entries that are already empty describe
		// a document that has nothing to retract.
		for (const [uri, errors] of Object.entries(this.cacheService.errors)) {
			if (errors.length === 0 || this.#clientManagedDocAndNodes.has(uri)) {
				continue
			}
			diagnostics.push({
				data: { checkOutcome: 'not-run', errors: [], uri },
				name: 'documentErrored',
			})
		}

		// Reset cache.
		const { symbols } = this.cacheService.reset()
		this.symbols = new SymbolUtil(symbols)
		this.symbols.buildCache()

		await this.restartForRebuild(diagnostics)
		return diagnostics
	}

	/**
	 * Apply a changed config, rebuilding the project when the cache context fingerprint changed.
	 *
	 * The prepared context reports `changedHashKinds`, but it is intentionally unused here:
	 * when the cache context fingerprint changes, we always go through a full {@link resetOnce}
	 * to keep initializer state consistent and avoid partial-invalidation corner cases (config
	 * changes that leave the fingerprint unchanged do not trigger a rebuild at all). Narrowing
	 * lint-only changes to `CacheService#invalidatePartial` is tracked separately on the
	 * project board ("[fork] cache transaction ..." item).
	 *
	 * This path does not bump `#resetGeneration`, so it never coalesces with manual
	 * {@link reset} calls; the two are serialized only by `enqueueLifecycle` (FIFO) order.
	 */
	private async applyConfigUpdate(config: Config): Promise<void> {
		// Waited for before the config is swapped, not only before the rebuild below: the analysis
		// reads `this.config` per file.
		await this.settleActiveAnalysis('Project#applyConfigUpdate')
		const oldConfig = this.config
		this.config = config
		this.logger.info('[Project] [Config] Changed')
		this.emit('configChanged', { oldConfig, newConfig: config })

		if (this.#isInitialized) {
			const preparedContext = await this.cacheService.prepareContext({
				initializerContext: this.#ctx,
				lint: config.lint,
			})
			if (preparedContext.changed) {
				await this.resetOnce(preparedContext)
				await this.saveCacheAfterRebuild('Project#applyConfigUpdate')
			}
		}
	}

	/**
	 * Recheck the documents the client has open, once every tracked file is bound. They are the
	 * only documents a rebuild checks: the whole corpus belongs to {@link analyzeProject}.
	 *
	 * Nothing is queued here (`'none'`), and no queued lint is flushed either. Every open document
	 * is already scheduled below, and a redirect to a closed one would publish exactly the
	 * half-corpus result this pass stopped producing. See {@link publishRebuildEvents}.
	 */
	private async rebindAndCheckClientManaged(
		propagateProcessorErrors: boolean,
	): Promise<void> {
		const entries = [...this.#clientManagedDocAndNodes.entries()]
		// Rebuild all bindings first, then complete every check before publishing any diagnostics.
		for (const [, { doc, node }] of entries) {
			await this.bind(doc, node, propagateProcessorErrors, 'none')
		}
		await Promise.all(
			entries.map(([, { doc, node }]) =>
				this.checkWithoutLintFlush(doc, node, propagateProcessorErrors, 'none')
			),
		)
	}

	/**
	 * @param drainQueuedLints Whether to drain the implicit lint queue between the staged
	 * diagnostics and READY. An initial scan binds documents other documents depend on, and its
	 * clearers queue those dependents; draining them after the staged (possibly stale) entries —
	 * flushing first would let the staged entries roll the fresh results back — and before READY
	 * is what keeps a `ready` listener from observing the stale ones. A rebuild passes `false`:
	 * it queues nothing, because every bind and check it runs uses `'none'` propagation and
	 * `rebuildProjectFromEmptyCache` empties the queue up front, and a drain publishes closed
	 * documents, which is {@link analyzeProject}'s job.
	 */
	private async publishRebuildEvents(
		diagnostics: ProjectDiagnosticsEvent[],
		drainQueuedLints: boolean,
	): Promise<void> {
		// Diagnostics listeners (including the LSP publisher) must settle before READY is visible.
		for (const event of diagnostics) {
			await this.emitAsync(event.name, event.data)
		}
		// Client-managed ASTs are retained by design. Resolve them only after commit so queued editor
		// mutations cannot be overwritten by rollback and no rebuild staging array owns an AST.
		for (const value of this.#clientManagedDocAndNodes.values()) {
			await this.emitAsync('documentUpdated', value)
		}
		if (drainQueuedLints) {
			await this.flushQueuedLints()
		}
		await this.emitAsync('ready', {})
	}

	/**
	 * The completion state travels on the node the diagnostics were collected from, so every
	 * publish reports the state of the very pass that produced them without threading a flag
	 * through the calls in between. A node carries at most one of the two markers: a check that
	 * completes replaces the failure marker with its results, and a check that throws leaves
	 * `checkerErrors` unset — with the failure marker winning if a stage after the checker ever
	 * throws, since then the diagnostics are incomplete regardless of what the checker produced.
	 */
	private createDocumentErrorEvent(
		doc: TextDocument,
		node: FileNode<AstNode>,
	): DocumentErrorEvent {
		return {
			checkOutcome: node.checkerFailed ? 'failed' : node.checkerErrors ? 'complete' : 'not-run',
			errors: FileNode.getErrors(node).map((e) => LanguageError.withPosRange(e, doc)),
			uri: doc.uri,
			version: doc.version,
		}
	}

	private reparseClientManaged(): void {
		for (const [uri, { doc }] of this.#clientManagedDocAndNodes) {
			this.#clientManagedDocAndNodes.set(uri, { doc, node: this.parse(doc) })
		}
	}

	normalizeUri(uri: string): string {
		return this.fs.mapFromDisk(normalizeUri(uri))
	}

	private isCacheUri(uri: string): boolean {
		return normalizeUri(uri).startsWith(normalizeUri(this.#cacheRoot))
	}

	private static readonly TextDocumentCacheMaxLength = 268435456
	readonly #textDocumentCache = new Map<string, Promise<TextDocument | undefined> | TextDocument>()
	#textDocumentCacheLength = 0
	private removeCachedTextDocument(uri: string): void {
		const doc = this.#textDocumentCache.get(uri)
		if (doc && !(doc instanceof Promise)) {
			this.#textDocumentCacheLength -= doc.getText().length
		}
		this.#textDocumentCache.delete(uri)
	}
	private async read(uri: string): Promise<TextDocument | undefined> {
		const createTextDocument = async (uri: string): Promise<TextDocument | undefined> => {
			const languageId = this.guessLanguageID(uri)
			if (!this.isSupportedLanguage(uri, languageId)) {
				return undefined
			}

			try {
				const content = bufferToString(await this.fs.readFile(uri))
				return TextDocument.create(uri, languageId, -1, content)
			} catch (e) {
				this.logger.warn(`[Project] [read] Failed creating TextDocument for ${uri}`, e)
				return undefined
			}
		}
		const trimCache = (): void => {
			const iterator = this.#textDocumentCache.keys()
			while (this.#textDocumentCacheLength > Project.TextDocumentCacheMaxLength) {
				const result = iterator.next()
				if (result.done) {
					throw new Error(
						`[Project] [read] Cache is too large with length ${this.#textDocumentCacheLength} even though it's empty; make sure to call 'removeCachedTextDocument()' instead of 'this.#textDocumentCache.delete()'`,
					)
				}
				this.removeCachedTextDocument(result.value)
			}
		}
		const getCacheHandlingPromise = async (uri: string): Promise<TextDocument | undefined> => {
			if (this.#textDocumentCache.has(uri)) {
				const ans = this.#textDocumentCache.get(uri)!
				// Move the entry to the end of the cache.
				// The goal is that more-frequently-used entries are preferably not trimmed.
				this.#textDocumentCache.delete(uri)
				this.#textDocumentCache.set(uri, ans)
				return ans
			} else {
				const promise = createTextDocument(uri)
				this.#textDocumentCache.set(uri, promise)

				// We replace the Promise in the cache with the TextDocument after it resolves,
				// or removes it from the cache if it resolves to undefined.
				const doc = await promise
				if (this.#textDocumentCache.get(uri) === promise) {
					// The Promise in the cache is the same as the one we created earlier.
					// This check is to make sure we don't set a wrong TextDocument to the cache in case the cache was modified elsewhere.
					if (doc) {
						this.#textDocumentCache.set(uri, doc)
						this.#textDocumentCacheLength += doc.getText().length
						trimCache()
					} else {
						this.#textDocumentCache.delete(uri)
					}
				}
				return doc
			}
		}

		uri = this.normalizeUri(uri)
		if (this.#clientManagedUris.has(uri)) {
			const result = this.#clientManagedDocAndNodes.get(uri)
			if (result) {
				return result.doc
			}
			throw new Error(
				`[Project] [read] Client-managed URI ${uri} does not have a TextDocument in the cache`,
			)
		}
		return getCacheHandlingPromise(uri)
	}

	private parse(doc: TextDocument): FileNode<AstNode> {
		const ctx = ParserContext.create(this, { doc })
		const parser = ctx.meta.getParserForLanguageId<AstNode>(ctx.doc.languageId)
		if (!parser) {
			return {
				type: 'file',
				range: Range.create(0),
				children: [],
				locals: Object.create(null),
				parserErrors: [],
			}
		}
		const src = new Source(doc.getText())
		return file(parser)(src, ctx)
	}

	@SingletonPromise()
	private async bind(
		doc: TextDocument,
		node: FileNode<AstNode>,
		propagateErrors = false,
		propagation: LintPropagation = 'full',
	): Promise<void> {
		if (node.binderErrors) {
			return
		}
		this.#bindingInProgressUris.add(doc.uri)
		const endCacheMutation = this.cacheService.beginStateMutation()
		try {
			const binder = this.meta.getBinder(node.type)
			const ctx = BinderContext.create(this, { doc })
			this.clearUriSymbolLocations(doc.uri, 'binder', propagation)
			await ctx.symbols.contributeAsAsync('binder', async () => {
				const proxy = StateProxy.create(node)
				await binder(proxy, ctx)
				node.binderErrors = ctx.err.dump()
			})
			this.#symbolUpToDateUris.add(doc.uri)
		} catch (e) {
			this.logger.error(`[Project] [bind] Failed for ${doc.uri} # ${doc.version}`, e)
			if (propagateErrors) {
				throw e
			}
		} finally {
			this.#bindingInProgressUris.delete(doc.uri)
			endCacheMutation()
		}
	}

	@SingletonPromise()
	private async check(
		doc: TextDocument,
		node: FileNode<AstNode>,
		propagateErrors = false,
	): Promise<void> {
		await this.checkWithoutLintFlush(doc, node, propagateErrors)
		try {
			await this.flushQueuedLints()
		} catch (e) {
			this.logger.error(`[Project] [check] Failed for ${doc.uri} # ${doc.version}`, e)
			if (propagateErrors) {
				throw e
			}
		}
	}

	/**
	 * Checker + linter stages without the trailing queued-lint flush. The
	 * implicit lint drain calls this directly: flushing there would await the
	 * drain's own promise and deadlock. {@link check} wraps this and flushes.
	 *
	 * Either outcome is recorded twice: on the node as {@link FileNode.checkerFailed}, which is
	 * what a publish reports as its {@link DocumentErrorEvent.checkOutcome}, and per URI in
	 * `#failedCheckUris`, which outlives the node. A failure is recorded before this method
	 * returns and therefore before its caller publishes, so no listener sees partial diagnostics
	 * described as anything else; a success clears both only once the fresh results are on the
	 * node, so the reverse pairing — old partial diagnostics next to a cleared marker — cannot
	 * happen either.
	 *
	 * @returns Whether the node ends up holding a complete checker result. `false` means the
	 * checker threw and `propagateErrors` swallowed it, which leaves the document's diagnostics a
	 * subset of what it should report. A caller that records a document as processed — see
	 * {@link analyzeProject}, which then lets the cache trust its recorded hashes — has to keep
	 * such a document out of its results; a caller that only publishes can ignore this.
	 */
	private async checkWithoutLintFlush(
		doc: TextDocument,
		node: FileNode<AstNode>,
		propagateErrors = false,
		propagation: LintPropagation = 'full',
	): Promise<boolean> {
		if (node.checkerErrors) {
			// The results are already on the node, put there by a checker that ran to completion.
			// Clearing here as well keeps the markers from outliving the failure they describe:
			// this URI holds a complete result, whatever an earlier attempt on it did.
			delete node.checkerFailed
			this.#failedCheckUris.delete(doc.uri)
			return true
		}
		const endCacheMutation = this.cacheService.beginStateMutation()
		const __checkProfiler = this.profilers.get('project#check', 'top-n', 50)
		const __lintProfiler = this.profilers.get('project#lint', 'top-n', 50)
		// Created out here so that the failure path can reach the symbol table this run wrote to.
		const ctx = CheckerContext.create(this, { doc })
		try {
			const checker = this.meta.getChecker(node.type)
			ctx.symbols.clear({ contributor: 'checker', uri: doc.uri })
			await ctx.symbols.contributeAsAsync('checker', async () => {
				await checker(StateProxy.create(node), ctx)
				node.checkerErrors = ctx.err.dump()
				delete node.checkerFailed
				this.#failedCheckUris.delete(doc.uri)
				__checkProfiler.task(doc.uri)
				this.lint(doc, node, propagation)
				__lintProfiler.task(doc.uri)
			})
			return true
		} catch (e) {
			this.logger.error(`[Project] [check] Failed for ${doc.uri} # ${doc.version}`, e)
			// `contributeAsAsync` restores the previous contributor name when its callback throws
			// and nothing else: every symbol location the checker registered before it threw stays
			// in the table. This is not a repeat of the clear above — that one dropped the
			// locations of an earlier run, this one drops the partial ones this run just wrote.
			ctx.symbols.clear({ contributor: 'checker', uri: doc.uri })
			node.checkerFailed = true
			this.#failedCheckUris.add(doc.uri)
			if (propagateErrors) {
				throw e
			}
			return false
		} finally {
			endCacheMutation()
			__checkProfiler.finalize()
			__lintProfiler.finalize()
		}
	}

	private lint(
		doc: TextDocument,
		node: FileNode<AstNode>,
		propagation: LintPropagation = 'full',
	): void {
		if (node.linterErrors) {
			return
		}

		node.linterErrors = []
		for (const [ruleName, rawValue] of Object.entries(this.config.lint)) {
			// Each rule is isolated: a rule that throws loses only its own results, and the remaining
			// rules still contribute their diagnostics.
			try {
				const result = LinterConfigValue.destruct(rawValue)
				if (!result) {
					// Rule is disabled (i.e. set to `null`) in the config.
					continue
				}

				const { ruleSeverity, ruleValue } = result
				const { configValidator, linter, nodePredicate } = this.meta.getLinter(ruleName)
				if (!configValidator(ruleName, ruleValue, this.logger)) {
					// Config value is invalid.
					continue
				}

				const ctx = LinterContext.create(this, {
					doc,
					err: new LinterErrorReporter(ruleName, ruleSeverity, this.ctx['errorSource']),
					// Cross-document rules keep redirecting to their canonical owner
					// under `owner-only`; only `none` silences them entirely.
					queueLint: propagation === 'none' ? undefined : uri => this.queueLint(uri),
					ruleName,
					ruleValue,
				})

				traversePreOrder(node, () => true, () => true, (node) => {
					if (nodePredicate(node)) {
						const proxy = StateProxy.create(node)
						linter(proxy, ctx)
					}
				})
				;(node.linterErrors as LanguageError[]).push(...ctx.err.dump())
			} catch (e) {
				this.logger.error(
					`[Project] [lint] Rule “${ruleName}” failed for ${doc.uri} # ${doc.version}`,
					e,
				)
			}
		}
	}

	/** Queue a non-client-managed document for a post-processing lint pass. */
	private queueLint(uri: string): void {
		this.#queuedLintUris.add(this.normalizeUri(uri))
	}

	/**
	 * Lint documents requested by processors without retaining them as
	 * client-managed editor documents. A single drain deduplicates cycles among
	 * cross-document lint rules and republishes the target's diagnostics.
	 *
	 * Every pass inside the drain runs with `owner-only` propagation. URI
	 * clearers of the redrained documents stay silent, so clearer-driven reverse
	 * reference propagation stops after the first queued generation instead of
	 * walking the dependency graph. Cross-document linters are different: they
	 * may still queue canonical owners from inside the drain, and those
	 * intentional redirects are drained as well. Whole-corpus diagnostics are
	 * {@link analyzeProject}'s job, not the editor path's: a reset only rebinds
	 * the corpus and rechecks the open documents.
	 */
	private async flushQueuedLints(): Promise<void> {
		if (!this.#isReady || this.#queuedLintUris.size === 0) {
			return
		}
		if (this.#queuedLintFlushPromise) {
			await this.#queuedLintFlushPromise
			return
		}

		const drain = async () => {
			const processed = new Set<string>()
			while (this.#queuedLintUris.size > 0) {
				const uris = [...this.#queuedLintUris]
				this.#queuedLintUris.clear()
				for (const uri of uris) {
					if (processed.has(uri)) {
						continue
					}
					processed.add(uri)

					const clientManaged = this.#clientManagedDocAndNodes.get(uri)
					if (clientManaged) {
						delete clientManaged.node.linterErrors
						this.lint(clientManaged.doc, clientManaged.node, 'owner-only')
						await this.emitAsync('documentUpdated', clientManaged)
						continue
					}

					const doc = await this.read(uri)
					if (!doc) {
						await this.emitAsync('documentErrored', {
							checkOutcome: 'not-run',
							errors: [],
							uri,
						})
						continue
					}
					const node = this.parse(doc)
					// Republishing replaces this URI's diagnostics wholesale, so bind
					// before checking: `analyzeProject` publishes checker diagnostics
					// for every project file, so implicit lint must always reproduce
					// that superset. Since publishDiagnostics replaces all diagnostics
					// for a URI, a lint-only pass would drop its checker diagnostics.
					// Use the flush-free check path because flushing here would await
					// this drain from inside itself.
					await this.bind(doc, node, false, 'owner-only')
					await this.checkWithoutLintFlush(doc, node, false, 'owner-only')
					await this.emitAsync('documentUpdated', { doc, node })
				}
			}
		}
		const promise = drain()
		this.#queuedLintFlushPromise = promise
		try {
			await promise
		} finally {
			if (this.#queuedLintFlushPromise === promise) {
				this.#queuedLintFlushPromise = undefined
			}
		}
	}

	// @SingletonPromise()
	async ensureBindingStarted(uri: string): Promise<void> {
		uri = this.normalizeUri(uri)
		if (this.#symbolUpToDateUris.has(uri) || this.#bindingInProgressUris.has(uri)) {
			return
		}

		this.#bindingInProgressUris.add(uri)
		try {
			const doc = await this.read(uri)
			if (!doc || !(await this.cacheService.hasFileChangedSinceCache(doc))) {
				return
			}

			const node = this.parse(doc)
			// A binder that {@link analyzeProject} is running reaches this method too — mcdoc
			// resolves module references through it — and both the default `'full'` propagation
			// and the publish below would cross the two-pass barrier that method is built on.
			// The queued lints outlive the run and drain on top of its results, and the bind-only
			// node replaces a document's checker/linter result with a subset of itself: during
			// `prepare` because nothing publishes yet, during `analyze` because the pass already
			// published or is about to. Staying silent loses nothing, since the analysis walks
			// every project file itself. With no analysis in flight this is the editor path and
			// behaves as before.
			const isAnalyzing = this.#activeAnalysis !== undefined
			await this.bind(doc, node, false, isAnalyzing ? 'none' : 'full')
			if (!isAnalyzing) {
				this.emit('documentUpdated', { doc, node })
			}
		} finally {
			this.#bindingInProgressUris.delete(uri)
		}
	}

	/**
	 * @param publishDiagnostics Whether this pass streams its bind-only result per file. Initial
	 * scans do; a rebuild does not, because a bind-only diagnostic for a closed document would
	 * replace the checker/linter result {@link analyzeProject} published for it with a subset of
	 * itself, and nothing in the rebuild restores the difference.
	 */
	async #parseAndBindForReady(
		uri: string,
		parseProfiler: Profiler,
		bindProfiler: Profiler,
		publishDiagnostics: boolean,
		propagateProcessorErrors: boolean,
		publishedUris: Set<string>,
	): Promise<void> {
		uri = this.normalizeUri(uri)
		if (this.#symbolUpToDateUris.has(uri) || this.#bindingInProgressUris.has(uri)) {
			return
		}

		this.#bindingInProgressUris.add(uri)
		try {
			const doc = await this.read(uri)
			if (!doc || !(await this.cacheService.hasFileChangedSinceCache(doc))) {
				return
			}

			const node = this.parse(doc)
			parseProfiler.task(uri)
			// A rebuild binds every tracked file exactly once, so a queued lint could only redo
			// work this loop does anyway, and `publishRebuildEvents` no longer drains one.
			await this.bind(
				doc,
				node,
				propagateProcessorErrors,
				publishDiagnostics ? 'full' : 'none',
			)
			bindProfiler.task(uri)
			if (publishDiagnostics) {
				// Initial scans have no rollback boundary, so preserve per-file streaming and let the
				// document/AST become collectible before processing the next file.
				await this.emitAsync('documentUpdated', { doc, node })
				publishedUris.add(uri)
			} else {
				// Recorded even though nothing is published: `saveCacheAfterRebuild` trusts these
				// hashes instead of reading the whole corpus again, and the publish that would
				// otherwise record them through `CacheService` never happens on this path.
				this.cacheService.trackDocumentUpdate(doc)
			}
		} finally {
			this.#bindingInProgressUris.delete(uri)
		}
	}

	private bindUri(param: string | string[]): void {
		const ctx = UriBinderContext.create(this)
		const uris = Array.isArray(param) ? param : [param]
		const endCacheMutation = this.cacheService.beginStateMutation()
		try {
			for (const uri of uris) {
				ctx.symbols.clear({ contributor: 'uri_binder', uri })
			}
			ctx.symbols.contributeAs('uri_binder', () => {
				for (const binder of this.meta.uriBinders) {
					binder(uris, ctx)
				}
			})
		} finally {
			endCacheMutation()
		}
	}

	/**
	 * Clear core locations for one URI and first give plugins a chance to remove
	 * metadata that is keyed by that URI rather than represented as a location.
	 * Checker contributions are intentionally excluded: they are cleared after
	 * every check and must not invalidate binder-owned metadata.
	 *
	 * Clearers only queue dependent documents under `full` propagation. Anything
	 * else leaves `queueLint` unset, which the clearers treat as a no-op.
	 */
	private clearUriSymbolLocations(
		uri: string,
		contributor: 'binder' | undefined = undefined,
		propagation: LintPropagation = 'full',
	): void {
		const ctx = UriBinderContext.create(this, {
			queueLint: propagation === 'full' ? target => this.queueLint(target) : undefined,
		})
		for (const clearer of this.meta.uriSymbolClearers) {
			clearer(uri, ctx)
		}
		this.symbols.clear({ contributor, uri })
	}

	private static readonly AnalysisYieldInterval = 100

	/**
	 * Replace the diagnostics of a URI that turned out to be unreadable during an analysis, but
	 * only if a bind ever registered that URI.
	 *
	 * A URI that was never bound was never readable to begin with (`read` also returns `undefined`
	 * for unsupported languages, e.g. `pack.mcmeta` in a project without a JSON language).
	 * Publishing for those would register an error key that has no file-content checksum, which
	 * makes `CacheService#createVerifiedChecksums` abort every later save.
	 */
	async #publishEmptyDiagnosticsIfBound(uri: string): Promise<void> {
		if (this.#symbolUpToDateUris.has(uri)) {
			await this.emitAsync('documentErrored', { checkOutcome: 'not-run', errors: [], uri })
		}
	}

	/**
	 * Run all four stages of document processing (`read`, `parse`, `bind`, and `check`, which
	 * includes `lint`) on every supported file under {@link projectRoots} and emit the results as
	 * `documentUpdated`/`documentErrored` events, regardless of whether the files are currently
	 * managed by the client.
	 *
	 * The work is split into two passes over the same file list. The `prepare` pass reads and binds
	 * every file; the `analyze` pass checks and publishes them. Checking a document while other
	 * documents are still unbound makes the checker and the linter report symbols that merely have
	 * not been registered yet, and those errors are stored on the node, where no later pass removes
	 * them. Every publish the run makes therefore belongs to the second pass, down to the empty
	 * diagnostics of a file that turned out to be unreadable.
	 *
	 * Neither pass queues implicit lints (`'none'`): every file is scheduled already, so a queued
	 * lint could only redo work this method does anyway — and each redo binds again, which queues
	 * further documents.
	 *
	 * The analysis only starts after the READY process is complete, which guarantees that the
	 * global symbol table is fully populated before any file is checked. It also starts behind
	 * everything the lifecycle queue already holds, so a reset or a config rebuild that was
	 * requested first finishes before the first file is read.
	 *
	 * The analysis itself runs outside that queue: it takes minutes on a large project, and the
	 * same queue carries every editor-driven update. What keeps it consistent instead is that
	 * lifecycle operations invalidating the state it reads stop it at its next file boundary — see
	 * {@link cancelActiveAnalysis} and {@link settleActiveAnalysis}. Such a run reports
	 * `cancelled`, exactly like one the caller aborted through {@link AnalyzeProjectOptions.signal}.
	 *
	 * Every publish here is awaited, so that the diagnostics of one URI cannot overtake each other
	 * when a listener is slow. A `documentUpdated` or `documentErrored` listener therefore must not
	 * await a lifecycle operation of this project — `reset`, `close`, or this method — from inside
	 * the publish. Those operations wait for the run to reach its next file boundary, and the run
	 * cannot reach one until the publish it is sitting in returns: neither side would ever settle.
	 * A listener that needs one has to start it without awaiting it.
	 *
	 * Dependency files are not analyzed.
	 *
	 * A run that completes persists the cache on its way out. The diagnostics it published for the
	 * whole corpus live only in memory until the 10-minute autosave or `close()` otherwise, and a
	 * crash in that window throws away the minutes the run cost. That save is best-effort: a
	 * failure or a skip is logged and the analysis still reports success. A cancelled run skips it.
	 *
	 * If an analysis is already in progress, the Promise of that analysis is returned instead and
	 * the passed-in `options` are ignored.
	 */
	@SingletonPromise(() => 'analyzeProject')
	async analyzeProject(options: AnalyzeProjectOptions = {}): Promise<AnalyzeProjectResult> {
		await this.ready()

		const analysis: RunningAnalysis = {
			controller: new AbortController(),
			stopped: Promise.withResolvers<void>(),
		}
		// Registering through the lifecycle queue is the entire interaction with it: operations
		// queued before this point run to completion first, and from here on lifecycle operations
		// find the analysis through `#activeAnalysis` instead of by holding the queue.
		await this.enqueueLifecycle(() => {
			this.#activeAnalysis = analysis
		})

		/**
		 * Let every lifecycle operation waiting on this run proceed. Running it a second time is a
		 * no-op, which is what lets the passes below release early while the `finally` around them
		 * still guarantees a release on every other exit.
		 */
		const release = () => {
			if (this.#activeAnalysis === analysis) {
				this.#activeAnalysis = undefined
			}
			analysis.stopped.resolve()
		}

		/** Whether the caller or a lifecycle operation asked this run to stop. */
		const isCancelled = () =>
			analysis.controller.signal.aborted || options.signal?.aborted === true

		try {
			// Listed after the barrier: an operation that ran ahead of it may have changed the
			// roots or the set of tracked files.
			const files = [...new Set(this.getTrackedFiles().map((uri) => this.normalizeUri(uri)))]
				.filter((uri) =>
					this.projectRoots.some((root) => fileUtil.isSubUriOf(uri, root))
					&& !this.shouldExclude(uri)
				)
				.sort(this.meta.uriSorter)
			this.logger.info(`[Project#analyzeProject] Analyzing ${files.length} files`)

			const __profiler = this.profilers.get('project#analyzeProject')
			let cancelled = false

			/** URIs the `prepare` pass bound. The `analyze` pass processes exactly these. */
			const boundUris = new Set<string>()
			/**
			 * URIs the `prepare` pass could not read, carried over so that the `analyze` pass is
			 * the one publishing their empty diagnostics.
			 */
			const unreadableUris = new Set<string>()
			/**
			 * URIs whose checker completed and whose diagnostics the `analyze` pass then
			 * published. That is what `analyzedFiles` reports, and what recorded the checksums the
			 * final save reuses. Anything this run skipped, failed on, or never reached stays out
			 * and is verified against disk instead — including a file that was published after
			 * its checker threw, since those diagnostics are a subset of its real ones.
			 */
			const analyzedUris = new Set<string>()
			let prepared = 0
			let analyzed = 0

			for (const uri of files) {
				if (isCancelled()) {
					cancelled = true
					this.logger.info(
						`[Project#analyzeProject] Cancelled while preparing ${prepared}/${files.length} files`,
					)
					break
				}

				try {
					const clientManaged = this.#clientManagedDocAndNodes.get(uri)
					if (clientManaged) {
						// The editor holds the authoritative content of this document, so its
						// node is reused instead of a disk read. That node still carries the
						// results of the last editor pass, and every stage returns early once
						// its own results are present. This command means “redo everything
						// with the current config”, so those results must not survive it.
						delete clientManaged.node.binderErrors
						delete clientManaged.node.checkerErrors
						delete clientManaged.node.linterErrors
						await this.bind(clientManaged.doc, clientManaged.node, false, 'none')
						boundUris.add(uri)
					} else {
						// This command is also how a user recovers from a stale cache, so the
						// text cache is dropped to force a read from disk.
						this.removeCachedTextDocument(uri)
						const doc = await this.read(uri)
						if (doc) {
							await this.bind(doc, this.parse(doc), false, 'none')
							boundUris.add(uri)
						} else {
							// Only remembered here. Publishing from this pass — even a diagnostic
							// with no errors in it — reaches the listeners and the cache before
							// the other files are bound, which is the barrier the split exists
							// to hold.
							unreadableUris.add(uri)
						}
					}
				} catch (e) {
					this.logger.error(`[Project#analyzeProject] Failed to prepare ${uri}`, e)
				}

				prepared += 1
				options.onProgress?.(prepared, files.length, 'prepare')
				if (prepared % Project.AnalysisYieldInterval === 0) {
					await new Promise((resolve) => setTimeout(resolve, 0))
				}
			}
			__profiler.task('Prepare Files')

			// A cancellation during the pass above stays raised, so this pass stops on its first
			// file without a separate guard. It walks the whole file list rather than the bound
			// subset so that a file the `prepare` pass could not bind still advances its progress:
			// both passes report against the same total, and a run that skipped one would
			// otherwise stop short of it while claiming to have finished.
			for (const uri of files) {
				if (isCancelled()) {
					cancelled = true
					this.logger.info(
						`[Project#analyzeProject] Cancelled after ${analyzed}/${files.length} files`,
					)
					break
				}

				try {
					if (boundUris.has(uri)) {
						const clientManaged = this.#clientManagedDocAndNodes.get(uri)
						if (clientManaged) {
							delete clientManaged.node.checkerErrors
							delete clientManaged.node.linterErrors
							const checked = await this.checkWithoutLintFlush(
								clientManaged.doc,
								clientManaged.node,
								false,
								'none',
							)
							// Other code paths hold this very object; publishing a copy of it
							// would leave them looking at a node nobody updates.
							await this.emitAsync('documentUpdated', clientManaged)
							// A file whose checker threw is still published — partial diagnostics
							// beat none, and they replace whatever this URI showed before — but it
							// is not recorded: `analyzedFiles` would count a file the checker
							// never finished, and the save would skip reading a file whose
							// diagnostics are incomplete. Left out, it is verified against disk
							// like any file this run did not reach. That verification is all this
							// buys: the hashes recorded while publishing still match the file, so
							// the cache keeps the partial diagnostics and the next start does not
							// recheck it. Making a failed checker retry needs the cache to
							// represent the failure, which it has no way to express today.
							if (checked) {
								analyzedUris.add(uri)
							}
						} else {
							const doc = await this.read(uri)
							if (doc) {
								// The `prepare` pass released its AST to keep memory flat, and a
								// freshly parsed node carries no symbol, which linter rules such
								// as `undeclaredSymbol` read from the node. Hence the second
								// bind. It is not deduplicated against the first one: `bind` is
								// keyed on the document and drops the key once its Promise
								// settles, which the `prepare` pass awaited.
								const node = this.parse(doc)
								await this.bind(doc, node, false, 'none')
								// `check` would flush the queued lints, which is the very
								// self-feeding pass this two-pass split exists to avoid.
								const checked = await this.checkWithoutLintFlush(
									doc,
									node,
									false,
									'none',
								)
								// Awaiting the publish keeps one URI's diagnostics from
								// overtaking each other when a listener is slow.
								await this.emitAsync('documentUpdated', { doc, node })
								// See the client-managed branch: a checker that threw publishes
								// but does not count and is not trusted.
								if (checked) {
									analyzedUris.add(uri)
								}
							} else {
								await this.#publishEmptyDiagnosticsIfBound(uri)
							}
						}
					} else if (unreadableUris.has(uri)) {
						// Deferred from the `prepare` pass so that this pass owns every publish
						// this run makes. The condition is unchanged: only a URI a bind once
						// registered gets the empty diagnostics, and it is read here rather than
						// there because that is where the publish now happens.
						await this.#publishEmptyDiagnosticsIfBound(uri)
					}
				} catch (e) {
					this.logger.error(`[Project#analyzeProject] Failed for ${uri}`, e)
				}

				analyzed += 1
				options.onProgress?.(analyzed, files.length, 'analyze')
				if (analyzed % Project.AnalysisYieldInterval === 0) {
					await new Promise((resolve) => setTimeout(resolve, 0))
				}
			}
			__profiler.task('Analyze Files')

			// Waiters are released here rather than after the save below: the save only reads
			// project state, and `CacheService` already drops one whose snapshot a concurrent
			// rebuild invalidated, so making a reset wait for it would only delay the rebuild.
			release()

			// Read again rather than trusting the loops alone: a cancellation that arrived while
			// the last file was still being processed never reached a loop boundary, and the run
			// would report itself as complete while skipping the save below. What lands after
			// `release` cleared `#activeAnalysis` can no longer reach this signal, and for that
			// remainder `CacheService#save` reports the skip itself.
			cancelled ||= isCancelled()

			// A cancelled run persists nothing. It published a subset of the corpus, and an
			// internal abort means a reset, a config rebuild or a reinitialization is already
			// waiting to discard the state a save would write out; its partial diagnostics reach
			// the caller right away instead, and the autosave interval or `close()` covers
			// whatever survives.
			if (!cancelled) {
				try {
					// Only the URIs this run published are trusted, so the dependency files it
					// never analyzed — and the project files it failed on — stay on the read path.
					// See `CacheService#createVerifiedChecksums`.
					const saved = await this.cacheService.save({
						trustRecordedHashesFor: analyzedUris,
					})
					if (!saved) {
						this.logger.warn(
							'[Project#analyzeProject] Finished analysis without saving cache',
						)
					}
				} catch (e) {
					// The analysis itself succeeded and its diagnostics are already published, so
					// a failed save is reported to the log alone, exactly as
					// `saveCacheAfterRebuild` treats one.
					this.logger.error('[Project#analyzeProject] Failed saving cache', e)
				}
			}
			__profiler.task('Save Cache').finalize()

			return { analyzedFiles: analyzedUris.size, cancelled, totalFiles: files.length }
		} finally {
			// Listing the files, sorting them, and building the profiler all run before the passes
			// reach their own release above, and any of them can throw. A `stopped` left
			// unresolved would make the next reset, config rebuild or reinitialization wait for
			// this run forever.
			release()
		}
	}

	/**
	 * Whether an editor notification for this URI can reach anything a running analysis reads.
	 *
	 * The notification handlers below return without touching a thing for two kinds of URI. A
	 * direct `archive:` one cannot be client-managed at all. An excluded one is not either: the
	 * language has no support registered, or the user's `exclude` config covers the path. Both are
	 * ordinary things to have open — a vanilla mcdoc file browsed out of a dependency, the README
	 * of the datapack — and cancelling for them would abort a run that takes minutes, one
	 * keystroke at a time.
	 *
	 * The handlers repeat these checks rather than sharing this one, because they run inside the
	 * lifecycle queue, where the config may have been reloaded since the notification arrived. A
	 * verdict this method gets wrong there costs nothing beyond timing: it is only the early
	 * signal, and the wait that actually protects the analysis sits behind the handler's own
	 * checks.
	 *
	 * @param languageID What the client called the document. Only `didOpen` carries one; `didChange`
	 * and `didClose` pass `undefined` and are answered from the document `didOpen` registered,
	 * whose absence is the early return those two handlers take.
	 */
	private canBeClientManaged(uri: string, languageID: string | undefined): boolean {
		const clientUri = normalizeUri(uri)
		const projectUri = this.normalizeUri(clientUri)
		if (!this.isCacheUri(clientUri) && projectUri.startsWith(ArchiveUriSupporter.Protocol)) {
			return false
		}
		languageID ??= this.#clientManagedDocAndNodes.get(projectUri)?.doc.languageId
		return languageID !== undefined && !this.shouldExclude(projectUri, languageID)
	}

	/**
	 * Notify that a new document was opened in the editor.
	 */
	async onDidOpen(
		uri: string,
		languageID: string,
		version: number,
		content: string,
	): Promise<void> {
		if (this.canBeClientManaged(uri, languageID)) {
			this.cancelActiveAnalysis(`[Project#onDidOpen] ${uri}`)
		}
		await this.enqueueLifecycle(() => this.onDidOpenOnce(uri, languageID, version, content))
	}

	private async onDidOpenOnce(
		uri: string,
		languageID: string,
		version: number,
		content: string,
	): Promise<void> {
		const clientUri = normalizeUri(uri)
		const isCacheUri = this.isCacheUri(clientUri)
		uri = this.normalizeUri(clientUri)
		if (!isCacheUri && uri.startsWith(ArchiveUriSupporter.Protocol)) {
			return // Direct `archive:` URIs cannot be client-managed.
		}
		if (this.shouldExclude(uri, languageID)) {
			return
		}
		// The buffer of a freshly opened file still holds what is on disk, so the two passes of an
		// analysis do agree on its content. What they cannot survive is the bind below: it clears
		// the symbols of this URI before registering them again, and an async binder puts an await
		// boundary in the middle of that, where a checker running in the analysis would read a
		// symbol table missing entries it is about to report on. Placed after every early return
		// above, so that a URI the notification handler found no reason to cancel for is not
		// cancelled here either. See `onDidChangeOnce` for why the wait sits inside the queued work.
		await this.settleActiveAnalysis(`[Project#onDidOpen] ${uri}`)
		const doc = TextDocument.create(uri, languageID, version, content)
		const node = this.parse(doc)
		this.#clientManagedUris.add(uri)
		this.#clientManagedDocAndNodes.set(uri, { doc, node })
		this.#clientManagedUriMap.delete(uri)
		this.#clientManagedUriMap.set(uri, clientUri)
		if (this.#isReady) {
			await this.bind(doc, node)
			await this.check(doc, node)
			this.emit('documentUpdated', { doc, node })
		}
	}

	/**
	 * Notify that an existing document was changed in the editor.
	 * @throws If there is no `TextDocument` corresponding to the URI.
	 */
	async onDidChange(
		uri: string,
		changes: TextDocumentContentChangeEvent[],
		version: number,
	): Promise<void> {
		if (this.canBeClientManaged(uri, undefined)) {
			this.cancelActiveAnalysis(`[Project#onDidChange] ${uri}`)
		}
		await this.enqueueLifecycle(() => this.onDidChangeOnce(uri, changes, version))
	}

	private async onDidChangeOnce(
		uri: string,
		changes: TextDocumentContentChangeEvent[],
		version: number,
	): Promise<void> {
		const clientUri = normalizeUri(uri)
		const isCacheUri = this.isCacheUri(clientUri)
		uri = this.normalizeUri(clientUri)
		this.#symbolUpToDateUris.delete(uri)
		if (!isCacheUri && uri.startsWith(ArchiveUriSupporter.Protocol)) {
			return // Direct `archive:` URIs cannot be client-managed.
		}
		const doc = this.#clientManagedDocAndNodes.get(uri)?.doc
		if (!doc || this.shouldExclude(uri, doc.languageId)) {
			// If doc is undefined, it means the document was previously excluded by onDidOpen()
			// based on the language ID supplied by the client, in which case we should return early.
			// Otherwise, we perform the shouldExclude() check with the URI and the saved language ID
			// as usual.
			return
		}
		// An analysis may be holding this very document, in which case it is holding the content
		// from before this edit. Waiting inside the queued work rather than in the notification
		// handler keeps the abort signal — raised in `onDidChange` — and this wait one file apart
		// at most, and the alternative is letting the pre-edit diagnostics land after the fresh
		// ones the check below publishes. Placed after every early return above, so that a URI the
		// notification handler found no reason to cancel for is not cancelled here either.
		await this.settleActiveAnalysis(`[Project#onDidChange] ${uri}`)
		TextDocument.update(doc, changes, version)
		const node = this.parse(doc)
		this.#clientManagedDocAndNodes.set(uri, { doc, node })
		if (this.#isReady) {
			await this.bind(doc, node)
			await this.check(doc, node)
			this.emit('documentUpdated', { doc, node })
		}
	}

	/**
	 * Notify that an existing document was closed in the editor.
	 */
	async onDidClose(uri: string): Promise<void> {
		if (this.canBeClientManaged(uri, undefined)) {
			this.cancelActiveAnalysis(`[Project#onDidClose] ${uri}`)
		}
		await this.enqueueLifecycle(() => this.onDidCloseOnce(uri))
	}

	private async onDidCloseOnce(uri: string): Promise<void> {
		const clientUri = normalizeUri(uri)
		const isCacheUri = this.isCacheUri(clientUri)
		uri = this.normalizeUri(clientUri)
		if (!isCacheUri && uri.startsWith(ArchiveUriSupporter.Protocol)) {
			return // Direct `archive:` URIs cannot be client-managed.
		}
		const wasClientManaged = this.#clientManagedUris.has(uri)
		if (wasClientManaged) {
			// Closing moves which content of this URI counts as authoritative back to the disk one,
			// so an analysis that read the editor buffer is now holding a document nobody else has.
			// A URI the editor never had registered — one `onDidOpenOnce` excluded — leaves every
			// write below a no-op, and the cache cleanup at the end only ever fires for a URI
			// neither the watcher nor a dependency tracks, which is never one an analysis walks.
			// See `onDidChangeOnce` for why the wait sits inside the queued work and behind the
			// early returns.
			await this.settleActiveAnalysis(`[Project#onDidClose] ${uri}`)
		}
		this.#clientManagedUris.delete(uri)
		this.#clientManagedDocAndNodes.delete(uri)

		let restored: DocAndNode | undefined
		if (isCacheUri && wasClientManaged && this.#isReady) {
			this.#symbolUpToDateUris.delete(uri)
			this.removeCachedTextDocument(uri)
			const doc = await this.read(uri)
			if (doc) {
				const node = this.parse(doc)
				await this.bind(doc, node)
				await this.check(doc, node)
				restored = { doc, node }
			} else {
				// Reading the archive source failed; stale client contributions must not survive.
				this.clearUriSymbolLocations(uri)
			}
		}

		this.#clientManagedUriMap.delete(uri)
		if (restored) {
			this.emit('documentUpdated', restored)
		}
		this.tryClearingCache(uri)
		await this.flushQueuedLints()
	}

	@SingletonPromise()
	async ensureClientManagedChecked(uri: string): Promise<DocAndNode | undefined> {
		uri = this.normalizeUri(uri)
		const result = this.#clientManagedDocAndNodes.get(uri)
		if (result) {
			const { doc, node } = result
			if (this.#isReady) {
				await this.bind(doc, node)
				await this.check(doc, node)
				this.emit('documentUpdated', result)
			}
			return result
		}
		return undefined
	}

	getClientManaged(uri: string): DocAndNode | undefined {
		uri = this.normalizeUri(uri)
		return this.#clientManagedDocAndNodes.get(uri)
	}

	/**
	 * Return the URI by which the language client manages a logical project URI.
	 */
	getClientManagedUri(uri: string): string | undefined {
		return this.#clientManagedUriMap.get(this.normalizeUri(uri))
	}

	async showCacheRoot(): Promise<void> {
		if (!this.#cacheRoot) {
			return
		}

		try {
			await fileUtil.ensureDir(this.externals, this.#cacheRoot)
			await this.externals.fs.showFile(this.#cacheRoot)
		} catch (e) {
			this.logger.error('[Service#showCacheRoot]', e)
		}
	}

	/**
	 * Returns true iff the URI should be excluded from all Spyglass language support.
	 *
	 * @param language Optional. If ommitted, a language will be derived from the URI according to
	 *                 its file extension.
	 */
	public shouldExclude(uri: string, language?: string): boolean {
		return (!this.isSupportedLanguage(uri, language) && !ConfigService.isConfigFile(uri))
			|| this.isUserExcluded(uri)
	}

	private isSupportedLanguage(uri: string, language?: string): boolean {
		language ??= this.guessLanguageID(uri)

		const languageOptions = this.meta.getLanguageOptions(language)
		if (!languageOptions) {
			// Unsupported language.
			return false
		}

		const { uriPredicate } = languageOptions
		return uriPredicate?.(uri, UriPredicateContext.create(this)) ?? true
	}

	/**
	 * Guess a language ID from a URI. The guessed language ID may or may not actually be supported.
	 */
	private guessLanguageID(uri: string): string {
		const ext = fileUtil.extname(uri) ?? '.spyglassmc-unknown'
		return this.meta.getLanguageID(ext) ?? ext.slice(1)
	}

	private isUserExcluded(uri: string): boolean {
		if (this.config.env.exclude.length === 0) {
			return false
		}
		for (const rel of fileUtil.getRels(uri, this.projectRoots)) {
			if (picomatch(this.config.env.exclude, { dot: true, posixSlashes: false })(rel)) {
				return true
			}
		}
		return false
	}

	private tryClearingCache(uri: string): void {
		if (this.shouldRemove(uri)) {
			this.removeCachedTextDocument(uri)
			this.emit('documentRemoved', { uri })
		}
	}

	private shouldRemove(uri: string): boolean {
		return (!this.#clientManagedUris.has(uri)
			&& !this.#dependencyFiles?.has(uri)
			&& !this.watchedFiles.has(uri))
	}

	private isOnlyWatched(uri: string): boolean {
		return (this.watchedFiles.has(uri)
			&& !this.#clientManagedUris.has(uri)
			&& !this.#dependencyFiles?.has(uri))
	}

	public async onEditorConfigurationUpdate(editorConfiguration: PartialConfig) {
		await this.#configService.onEditorConfigurationUpdate(editorConfiguration)
		await this.#configUpdatePromise
	}
}
