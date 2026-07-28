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

export interface DocAndNode {
	doc: TextDocument
	node: FileNode<AstNode>
}

interface DocumentEvent extends DocAndNode {}
interface DocumentErrorEvent {
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
 * - `none`: nothing is queued. The reset full pass uses this because it already
 *   schedules every document.
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
 * During the READY process of the project, the whole project is analyzed mainly to populate the global symbol table.
 * The Promise returned by the {@link ready} function resolves when the READY process is complete.
 *
 * The following generally happens during the READY process:
 * 1. A list of file URIs under the project is obtained.
 * 2. The global symbol cache, if available, is loaded and validated against the know list of files.
 *    A list of files that need to be (re)processed is returned in this step.
 * 3. For each files in the new list, the file is read, parsed, bound, and checked.
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
			this.emit('documentErrored', { errors: [], uri })
		}).on('fileCreated', ({ uri }) => {
			const process = async () => {
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
			const process = async () => {
				this.#symbolUpToDateUris.delete(uri)
				this.removeCachedTextDocument(uri)
				if (this.isOnlyWatched(uri)) {
					await this.ensureBindingStarted(uri)
					// `ensureBindingStarted` publishes a bind-only node, which replaces
					// whatever the reset pass published for this document. Requeue it so
					// the drain below restores the checker and linter diagnostics.
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
			const readyFileDeletedUris = this.#readyFileDeletedUris
			const process = () =>
				readyFileDeletedUris?.has(uri)
					? undefined
					: this.processFileDeleted(uri)
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
		await this.publishRebuildEvents(diagnostics)
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
	 * Finish the initial run of parsing, binding, and checking the entire project.
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
				data: { errors: values, uri },
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

		// Only the reset path (`restartForRebuild`) passes `diagnostics` in, and it
		// is the path that owns whole-corpus diagnostics, so it is the one that
		// runs the second checker/linter pass below.
		const shouldRunFullPass = !shouldPublishEvents
		const __parseProfiler = this.profilers.get('project#ready#parse', 'top-n', 50)
		const __bindProfiler = this.profilers.get('project#ready#bind', 'top-n', 50)
		for (const uri of files) {
			await this.#parseAndBindForReady(
				uri,
				__parseProfiler,
				__bindProfiler,
				shouldPublishEvents ? undefined : stagedDiagnostics,
				// The full pass restages every URI it covers, so only the URIs it
				// skips still need the bind-only diagnostics from this pass.
				!shouldRunFullPass || !this.#isFullCheckTarget(uri),
				propagateProcessorErrors,
				freshlyPublishedUris,
			)
		}
		__parseProfiler.finalize()
		__bindProfiler.finalize()
		__profiler.task('Bind Files')

		if (shouldRunFullPass) {
			await this.#checkAllForReady(files, stagedDiagnostics, propagateProcessorErrors)
			__profiler.task('Full Check Pass')
		}

		await this.rebindAndCheckClientManaged(propagateProcessorErrors)
		this.#isReady = true
		__profiler.finalize()
		// `publishRebuildEvents` publishes the staged (possibly stale) cache
		// diagnostics, drains the queued lints on top of them, and only then
		// emits READY. On the staged path the caller runs it after this method
		// settles. Re-scanned files already published fresh diagnostics during
		// the scan above, so their pre-scan staged entries are dropped here:
		// republishing them would roll the fresh results back to stale ones.
		if (shouldPublishEvents) {
			const staged = stagedDiagnostics.filter(event => !freshlyPublishedUris.has(event.data.uri))
			await this.publishRebuildEvents(staged)
		}

		return this
	}

	/**
	 * Behavior of the `Project` instance is undefined after this function has settled.
	 */
	async close(): Promise<void> {
		clearInterval(this.#cacheSaverIntervalId)
		await this.#watcher?.close()
		for (;;) {
			const lifecycle = this.#lifecyclePromise
			await lifecycle
			if (lifecycle === this.#lifecyclePromise) {
				break
			}
		}
		try {
			await this.cacheService.save()
		} catch (e) {
			this.logger.error('[Project#close] Failed saving cache', e)
		}
	}

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
	 * Concurrent calls coalesce through the `#resetGeneration` counter: each call bumps the
	 * generation and awaits the single in-flight {@link drainResets} pass instead of enqueueing
	 * another lifecycle operation. Resets requested while a drain is already rebuilding are
	 * absorbed by the next loop iteration, which jumps straight to the latest generation.
	 */
	async reset(): Promise<void> {
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
	 * Persist the cache before a settled rebuild returns to its caller. Otherwise the diagnostics
	 * the full pass produced for the whole corpus live only in memory until the 10-minute autosave
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
	 * @param origin Identifies the calling path in the logs, e.g. `Project#drainResets`.
	 */
	private async saveCacheAfterRebuild(origin: string): Promise<void> {
		try {
			const saved = await this.cacheService.save()
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
		await this.publishRebuildEvents(diagnostics)
	}

	private async rebuildProjectFromEmptyCache(): Promise<ProjectDiagnosticsEvent[]> {
		this.logger.info('[Project#resetCache] Initiated...')
		this.#isReady = false
		this.reparseClientManaged()
		// Lints queued against the discarded symbol table would otherwise drain
		// after the full pass and republish diagnostics derived from it.
		this.#queuedLintUris.clear()
		const diagnostics: ProjectDiagnosticsEvent[] = []

		// Clear existing errors.
		for (const uri of Object.keys(this.cacheService.errors)) {
			diagnostics.push({ data: { errors: [], uri }, name: 'documentErrored' })
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

	private async rebindAndCheckClientManaged(
		propagateProcessorErrors: boolean,
	): Promise<void> {
		const entries = [...this.#clientManagedDocAndNodes.entries()]
		// Rebuild all bindings first, then complete every check before publishing any diagnostics.
		for (const [, { doc, node }] of entries) {
			await this.bind(doc, node, propagateProcessorErrors)
		}
		await Promise.all(
			entries.map(([, { doc, node }]) => this.check(doc, node, propagateProcessorErrors)),
		)
	}

	private async publishRebuildEvents(diagnostics: ProjectDiagnosticsEvent[]): Promise<void> {
		// Diagnostics listeners (including the LSP publisher) must settle before READY is visible.
		for (const event of diagnostics) {
			await this.emitAsync(event.name, event.data)
		}
		// Client-managed ASTs are retained by design. Resolve them only after commit so queued editor
		// mutations cannot be overwritten by rollback and no rebuild staging array owns an AST.
		for (const value of this.#clientManagedDocAndNodes.values()) {
			await this.emitAsync('documentUpdated', value)
		}
		// Queued lints republish per-URI diagnostics, so they must drain after the
		// staged (possibly stale) diagnostics above — flushing first would let the
		// old staged entries roll the fresh results back — and before READY is
		// emitted, so `ready` listeners never observe stale staged diagnostics.
		await this.flushQueuedLints()
		await this.emitAsync('ready', {})
	}

	private createDocumentErrorEvent(
		doc: TextDocument,
		node: FileNode<AstNode>,
	): DocumentErrorEvent {
		return {
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
	 */
	private async checkWithoutLintFlush(
		doc: TextDocument,
		node: FileNode<AstNode>,
		propagateErrors = false,
		propagation: LintPropagation = 'full',
	): Promise<void> {
		if (node.checkerErrors) {
			return
		}
		const endCacheMutation = this.cacheService.beginStateMutation()
		const __checkProfiler = this.profilers.get('project#check', 'top-n', 50)
		const __lintProfiler = this.profilers.get('project#lint', 'top-n', 50)
		try {
			const checker = this.meta.getChecker(node.type)
			const ctx = CheckerContext.create(this, { doc })
			ctx.symbols.clear({ contributor: 'checker', uri: doc.uri })
			await ctx.symbols.contributeAsAsync('checker', async () => {
				await checker(StateProxy.create(node), ctx)
				node.checkerErrors = ctx.err.dump()
				__checkProfiler.task(doc.uri)
				this.lint(doc, node, propagation)
				__lintProfiler.task(doc.uri)
			})
		} catch (e) {
			this.logger.error(`[Project] [check] Failed for ${doc.uri} # ${doc.version}`, e)
			if (propagateErrors) {
				throw e
			}
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
	 * the reset pass's job, not the editor path's.
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
						await this.emitAsync('documentErrored', { errors: [], uri })
						continue
					}
					const node = this.parse(doc)
					// Republishing replaces this URI's diagnostics wholesale, so bind
					// before checking: the reset pass publishes checker diagnostics for
					// every project file, so implicit lint must always reproduce that
					// superset. Since publishDiagnostics replaces all diagnostics for a
					// URI, a lint-only pass would drop its checker diagnostics. Use the
					// flush-free check path because flushing here would await this drain
					// from inside itself.
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
			await this.bind(doc, node)
			this.emit('documentUpdated', { doc, node })
		} finally {
			this.#bindingInProgressUris.delete(uri)
		}
	}

	async #parseAndBindForReady(
		uri: string,
		parseProfiler: Profiler,
		bindProfiler: Profiler,
		diagnostics: ProjectDiagnosticsEvent[] | undefined,
		stageDiagnostics: boolean,
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
			await this.bind(doc, node, propagateProcessorErrors)
			bindProfiler.task(uri)
			if (diagnostics) {
				this.cacheService.trackDocumentUpdate(doc)
				// A following full pass stages the combined checker/linter result for
				// this URI, so staging the bind-only entry here too would publish the
				// same document twice.
				if (stageDiagnostics) {
					diagnostics.push({
						data: this.createDocumentErrorEvent(doc, node),
						name: 'documentErrored',
					})
				}
			} else {
				// Initial scans have no rollback boundary, so preserve per-file streaming and let the
				// document/AST become collectible before processing the next file.
				await this.emitAsync('documentUpdated', { doc, node })
				publishedUris.add(uri)
			}
		} finally {
			this.#bindingInProgressUris.delete(uri)
		}
	}

	/**
	 * Whether the reset's full checker/linter pass covers this URI.
	 *
	 * Only the project's own files are covered. Dependency files — the vanilla
	 * archives above all — outnumber them by roughly eight to one and produce no
	 * diagnostic anyone acts on: the editor path checks a document only once the
	 * user opens it, and an `archive:` URI cannot be client-managed at all. The
	 * URIs are compared in the form `getTrackedFiles` produced them, before
	 * `normalizeUri` maps them off disk, so a mapped project file cannot fall out
	 * of the set and silently lose its checker diagnostics.
	 */
	#isFullCheckTarget(uri: string): boolean {
		return this.watchedFiles.has(uri) && !this.#dependencyFiles?.has(uri)
	}

	/**
	 * Second reset pass: rerun the checker and linter over every project document
	 * once the global symbol table is complete. See {@link #isFullCheckTarget} for
	 * why dependency files are left out.
	 *
	 * The first pass only binds, and its ASTs are released per file to keep memory
	 * flat, so the checker and linter have to reparse and rebind here: linter rules
	 * such as `impDocPrivate` and `undeclaredSymbol` read `node.symbol`, which a
	 * fresh parse does not carry. Streaming a second time keeps at most one
	 * document alive instead of retaining every AST from the first pass.
	 *
	 * Nothing is queued during this pass (`'none'`): every document is scheduled
	 * already, so the cross-document redirects would only duplicate work.
	 */
	async #checkAllForReady(
		files: readonly string[],
		stagedDiagnostics: ProjectDiagnosticsEvent[],
		propagateProcessorErrors: boolean,
	): Promise<void> {
		const __fullCheckProfiler = this.profilers.get('project#ready#fullCheck', 'top-n', 50)
		for (const uri of files) {
			if (!this.#isFullCheckTarget(uri)) {
				continue
			}
			const normalized = this.normalizeUri(uri)
			// `rebindAndCheckClientManaged` owns the editor-managed documents.
			if (this.#clientManagedDocAndNodes.has(normalized)) {
				continue
			}

			const doc = await this.read(normalized)
			if (!doc) {
				// `#symbolUpToDateUris` is cleared by `restartForRebuild` and holds
				// exactly what the first pass bound, so a member here is a document
				// that vanished between the two passes: replace its diagnostics.
				// A non-member was never readable to begin with (`read` also returns
				// `undefined` for unsupported languages, e.g. `pack.mcmeta` in a
				// project without a JSON language). Staging an entry for those would
				// register an error key with no file-content checksum, which makes
				// `CacheService#createVerifiedChecksums` abort every later save.
				if (this.#symbolUpToDateUris.has(normalized)) {
					stagedDiagnostics.push({
						data: { errors: [], uri: normalized },
						name: 'documentErrored',
					})
				}
				continue
			}
			const node = this.parse(doc)
			await this.bind(doc, node, propagateProcessorErrors, 'none')
			await this.checkWithoutLintFlush(doc, node, propagateProcessorErrors, 'none')
			stagedDiagnostics.push({
				data: this.createDocumentErrorEvent(doc, node),
				name: 'documentErrored',
			})
			__fullCheckProfiler.task(normalized)
		}
		__fullCheckProfiler.finalize()
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

	/**
	 * Notify that a new document was opened in the editor.
	 */
	async onDidOpen(
		uri: string,
		languageID: string,
		version: number,
		content: string,
	): Promise<void> {
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
