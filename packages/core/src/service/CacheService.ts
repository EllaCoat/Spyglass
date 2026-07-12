import type { TextDocument } from 'vscode-languageserver-textdocument'
import {
	bigintJsonLosslessReplacer,
	bigintJsonLosslessReviver,
	bufferToString,
	getSha1,
	Uri,
} from '../common/index.js'
import type { PosRangeLanguageError } from '../source/index.js'
import type { UnlinkedSymbolTable } from '../symbol/index.js'
import { SymbolTable } from '../symbol/index.js'
import type { LinterConfig } from './Config.js'
import { ArchiveUriSupporter } from './FileService.js'
import type { RootUriString } from './fileUtil.js'
import { fileUtil } from './fileUtil.js'
import type { Project } from './Project.js'

/**
 * The format version of the cache. Should be increased when any changes that
 * could invalidate the cache are introduced to the Spyglass codebase.
 */
export const LatestCacheVersion = 9

/**
 * Deep clone with keys sorted at every object level so that JSON.stringify is
 * insertion-order independent. Used to fingerprint the initializer/lint context.
 */
function stableStringify(value: unknown): string {
	return JSON.stringify(value, (_key, val) => {
		if (val && typeof val === 'object' && !Array.isArray(val)) {
			const sorted: Record<string, unknown> = {}
			for (const k of Object.keys(val as Record<string, unknown>).sort()) {
				sorted[k] = (val as Record<string, unknown>)[k]
			}
			return sorted
		}
		return val
	})
}

/**
 * Inputs whose value participates in the cache fingerprint. When these change
 * between runs the cached symbols/errors must be dropped.
 */
export interface CacheContext {
	initializerContext: Record<string, string>
	lint: LinterConfig
}

export type CacheHashKind = 'initializer' | 'lint'

export interface PreparedCacheContext {
	readonly changed: boolean
	readonly changedHashKinds: readonly CacheHashKind[]
	readonly hash: string
	readonly initializerHash: string
	readonly lintHash: string
}

export interface CacheTransaction {
	commit(): void
	rollback(): void
}

/**
 * Checksums of cached files or roots.
 */
interface Checksums {
	/** Hashes of the decoded document text from which file-derived state was built. */
	fileContents: Record<string, string>
	/** Hashes of the raw bytes used to detect changes on the backing file system. */
	files: Record<string, string>
	roots: Record<RootUriString, string>
	symbolRegistrars: Record<string, string>
}
namespace Checksums {
	export function create(): Checksums {
		return { fileContents: {}, files: {}, roots: {}, symbolRegistrars: {} }
	}
}

type ErrorCache = Record<string, readonly PosRangeLanguageError[]>

/**
 * Format of cache JSON files.
 */
interface CacheFile {
	checksums: Checksums
	/**
	 * Combined fingerprint retained as an integrity check for the component hashes.
	 */
	contextHash: string
	errors: ErrorCache
	/** Fingerprint of the context returned by project initializers. */
	initializerHash: string
	/** Fingerprint of the lint configuration. */
	lintHash: string
	projectRoots: string[]
	symbols: UnlinkedSymbolTable
	/**
	 * Format version of the cache. The cache should be invalidated if this number
	 * doesn't match {@link LatestCacheVersion}.
	 */
	version: number
}

interface LoadResult {
	symbols: SymbolTable
}

interface ValidateResult {
	addedFiles: string[]
	changedFiles: string[]
	removedFiles: string[]
	unchangedFiles: string[]
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return !!value && typeof value === 'object'
		&& Object.values(value).every(item => typeof item === 'string')
}

function isCacheFile(value: unknown): value is CacheFile {
	if (!value || typeof value !== 'object') {
		return false
	}
	const cache = value as Partial<CacheFile>
	return typeof cache.version === 'number'
		&& typeof cache.contextHash === 'string'
		&& typeof cache.initializerHash === 'string'
		&& typeof cache.lintHash === 'string'
		&& !!cache.checksums
		&& isStringRecord(cache.checksums.fileContents)
		&& isStringRecord(cache.checksums.files)
		&& isStringRecord(cache.checksums.roots)
		&& isStringRecord(cache.checksums.symbolRegistrars)
		&& Array.isArray(cache.projectRoots)
		&& cache.projectRoots.every(root => typeof root === 'string')
		&& !!cache.errors
		&& typeof cache.errors === 'object'
		&& !!cache.symbols
		&& typeof cache.symbols === 'object'
}

export class CacheService {
	checksums = Checksums.create()
	errors: ErrorCache = {}
	#hasValidatedFiles = false
	#invalidatedFiles = new Set<string>()
	#pendingCache: CacheFile | undefined
	#activeContextHash: string | undefined
	#activeInitializerHash: string | undefined
	#activeLintHash: string | undefined
	readonly #fileContentUpdateTokens = new Map<string, number>()
	#hashUpdateGeneration = 0
	#nextHashUpdateToken = 0
	readonly #pendingHashUpdates = new Set<Promise<void>>()
	readonly #rootUpdateTokens = new Map<string, number>()
	#saveQueue: Promise<void> = Promise.resolve()
	#saveSuspensions = 0

	/**
	 * @param cacheRoot File path to the directory where cache files by Spyglass should be stored.
	 * @param project
	 */
	constructor(private readonly cacheRoot: RootUriString, private readonly project: Project) {
		this.project.on('documentUpdated', ({ doc }) => {
			if (
				!this.#hasValidatedFiles
				// Do not save checksums for file schemes that we cannot map to disk (e.g. 'untitled:'
				// for untitled files in VS Code)
				|| !(doc.uri.startsWith(ArchiveUriSupporter.Protocol) || doc.uri.startsWith('file:'))
			) {
				return
			}
			this.#hashUpdateGeneration += 1
			const checksums = this.checksums
			const token = ++this.#nextHashUpdateToken
			this.#fileContentUpdateTokens.set(doc.uri, token)
			const text = doc.getText()
			this.trackHashUpdate(async () => {
				try {
					// TODO: Don't update this for every single change.
					const stateHash = await getSha1(text)
					let fileContentHash: string | undefined
					let fileHash: string | undefined
					try {
						const bytes = await this.project.fs.readFile(doc.uri)
						const hashes = await Promise.all([
							getSha1(bufferToString(bytes)),
							getSha1(bytes),
						])
						fileContentHash = hashes[0]
						fileHash = hashes[1]
					} catch (e) {
						if (!this.project.externals.error.isKind(e, 'EISDIR')) {
							this.project.logger.error(`[CacheService#hash-file] ${doc.uri}`, e)
						}
					}
					if (
						this.checksums === checksums
						&& this.#fileContentUpdateTokens.get(doc.uri) === token
					) {
						checksums.fileContents[doc.uri] = stateHash
						if (fileContentHash === stateHash && fileHash !== undefined) {
							checksums.files[doc.uri] = fileHash
						} else {
							delete checksums.files[doc.uri]
						}
					}
				} catch (e) {
					if (!this.project.externals.error.isKind(e, 'EISDIR')) {
						this.project.logger.error(`[CacheService#hash-file] ${doc.uri}`)
					}
				}
			})
		})
		this.project.on('rootsUpdated', ({ roots }) => {
			if (!this.#hasValidatedFiles) {
				return
			}
			this.#hashUpdateGeneration += 1
			const checksums = this.checksums
			this.trackHashUpdate(async () => {
				for (const root of roots) {
					const token = ++this.#nextHashUpdateToken
					this.#rootUpdateTokens.set(root, token)
					try {
						const hash = await this.project.fs.hash(root)
						if (
							this.checksums === checksums
							&& this.#rootUpdateTokens.get(root) === token
						) {
							checksums.roots[root] = hash
						}
					} catch (e) {
						if (!this.project.externals.error.isKind(e, 'EISDIR')) {
							this.project.logger.error(`[CacheService#hash-root] ${root}`, e)
						}
					}
				}
			})
		})
		this.project.on('symbolRegistrarExecuted', ({ id, checksum }) => {
			this.#hashUpdateGeneration += 1
			if (checksum !== undefined) {
				this.checksums.symbolRegistrars[id] = checksum
			}
		})
		this.project.on('documentErrored', ({ uri, errors }) => {
			this.#hashUpdateGeneration += 1
			this.errors[uri] = errors
		})
		for (const event of ['fileCreated', 'fileModified', 'fileDeleted'] as const) {
			this.project.on(event, () => {
				this.#hashUpdateGeneration += 1
			})
		}
	}

	/** Prevent cache publication while an async symbol/error mutation is in progress. */
	beginStateMutation(): () => void {
		this.#hashUpdateGeneration += 1
		this.#saveSuspensions += 1
		let settled = false
		return () => {
			if (settled) {
				throw new Error('Cache state mutation has already settled')
			}
			settled = true
			this.#hashUpdateGeneration += 1
			this.#saveSuspensions -= 1
		}
	}

	private trackHashUpdate(update: () => Promise<void>): void {
		const pending = update().catch(e => {
			this.project.logger.error('[CacheService#hash-update]', e)
		})
		this.#pendingHashUpdates.add(pending)
		void pending.then(() => this.#pendingHashUpdates.delete(pending))
	}

	private async waitForPendingHashUpdates(): Promise<void> {
		while (this.#pendingHashUpdates.size > 0) {
			await Promise.all(this.#pendingHashUpdates)
		}
	}

	private async createVerifiedChecksums(
		checksums: Checksums,
		generation: number,
	): Promise<Checksums | undefined> {
		const updates = await Promise.all(
			this.project.getTrackedFiles().map(async (uri) => {
				try {
					const bytes = await this.project.fs.readFile(uri)
					const clientDocument = this.project.getClientManaged(uri)?.doc
					const [fileHash, fileContentHash, clientContentHash] = await Promise.all([
						getSha1(bytes),
						getSha1(bufferToString(bytes)),
						clientDocument ? getSha1(clientDocument.getText()) : undefined,
					])
					return { clientContentHash, fileContentHash, fileHash, uri }
				} catch (e) {
					this.project.logger.error(`[CacheService#hash-file] ${uri}`, e)
					throw e
				}
			}),
		)
		if (
			this.checksums !== checksums
			|| this.#hashUpdateGeneration !== generation
		) {
			return undefined
		}
		const verified = Checksums.create()
		verified.roots = { ...checksums.roots }
		verified.symbolRegistrars = { ...checksums.symbolRegistrars }
		for (const update of updates) {
			const stateHash = checksums.fileContents[update.uri]
			if (stateHash === undefined) {
				if (Object.hasOwn(this.errors, update.uri)) {
					return undefined
				}
				verified.files[update.uri] = update.fileHash
				continue
			}
			if (
				stateHash !== update.fileContentHash
				|| (update.clientContentHash !== undefined && update.clientContentHash !== stateHash)
			) {
				return undefined
			}
			verified.files[update.uri] = update.fileHash
			verified.fileContents[update.uri] = stateHash
		}
		return verified
	}

	private canSave(): boolean {
		return this.project.projectRoots.length > 0
			&& this.#hasValidatedFiles
			&& this.#saveSuspensions === 0
			&& this.#activeContextHash !== undefined
			&& this.#activeInitializerHash !== undefined
			&& this.#activeLintHash !== undefined
	}

	#cacheFilePath: string | undefined
	private async getCacheFileUri(): Promise<string> {
		if (!this.#cacheFilePath) {
			const sortedRoots = [...this.project.projectRoots].sort()
			const hash = await getSha1(sortedRoots.join(':'))
			this.#cacheFilePath = new Uri(`symbols/${hash}.json.gz`, this.cacheRoot).toString()
		}
		return this.#cacheFilePath
	}

	/**
	 * Read and format-check the cache file. Symbols/errors/checksums are NOT
	 * applied yet; call {@link activate} once the initializer + lint context is
	 * available so we can compare fingerprints and drop stale caches.
	 */
	async loadMetadata(): Promise<void> {
		this.#pendingCache = undefined
		if (this.project.projectRoots.length === 0) {
			return
		}
		const __profiler = this.project.profilers.get('cache#loadMetadata')
		let filePath: string | undefined
		try {
			filePath = await this.getCacheFileUri()
			this.project.logger.info(`[CacheService#loadMetadata] symbolCachePath = ${filePath}`)
			const cache = await fileUtil.readGzippedJson(
				this.project.externals,
				filePath,
				bigintJsonLosslessReviver,
			)
			__profiler.task('Read File')
			const version = cache && typeof cache === 'object'
				? (cache as { version?: unknown }).version
				: undefined
			if (version !== LatestCacheVersion) {
				this.project.logger.info(
					`[CacheService#loadMetadata] Unsupported cache format ${
						String(version)
					}; expected ${LatestCacheVersion}`,
				)
			} else if (isCacheFile(cache)) {
				this.#pendingCache = cache
			} else {
				this.project.logger.info(
					`[CacheService#loadMetadata] Invalid cache schema for format ${LatestCacheVersion}`,
				)
			}
		} catch (e) {
			if (!this.project.externals.error.isKind(e, 'ENOENT')) {
				this.project.logger.error('[CacheService#loadMetadata] ', e)
			}
		}
		__profiler.finalize()
	}

	/**
	 * Compare the pending cache fingerprint against the current initializer/lint
	 * context. On match the cached symbols/errors/checksums are adopted; on
	 * mismatch (or missing pending cache) everything is dropped so the next
	 * {@link validate} pass treats every file as added.
	 */
	async activate(context: CacheContext): Promise<LoadResult> {
		const ans: LoadResult = { symbols: {} }
		const prepared = await this.prepareContext(context)
		this.commitContext(prepared)
		const cache = this.#pendingCache
		this.#pendingCache = undefined
		if (this.project.projectRoots.length === 0) {
			return ans
		}
		const __profiler = this.project.profilers.get('cache#activate')
		try {
			if (!cache || cache.initializerHash !== prepared.initializerHash) {
				this.project.logger.info(
					`[CacheService#activate] initializer context ${
						cache ? 'mismatch' : 'missing'
					}; dropping cache`,
				)
				this.checksums = Checksums.create()
				this.errors = {}
				this.#invalidatedFiles.clear()
				this.#hasValidatedFiles = false
				return ans
			}
			this.checksums = cache.checksums
			this.errors = cache.errors
			ans.symbols = SymbolTable.link(cache.symbols)
			__profiler.task('Link Symbols')
			if (cache.lintHash !== prepared.lintHash) {
				this.project.logger.info(
					'[CacheService#activate] lint context mismatch; partially invalidating cache',
				)
				this.invalidatePartial('lint')
			} else if (cache.contextHash !== prepared.hash) {
				this.project.logger.info(
					'[CacheService#activate] combined context mismatch; dropping cache',
				)
				this.checksums = Checksums.create()
				this.errors = {}
				this.#invalidatedFiles.clear()
				ans.symbols = {}
				this.#hasValidatedFiles = false
			}
		} finally {
			__profiler.finalize()
		}
		return ans
	}

	/**
	 * Refresh the fingerprint used by subsequent cache saves.
	 *
	 * @returns Whether an already-active context changed.
	 */
	async updateContext(context: CacheContext): Promise<boolean> {
		const prepared = await this.prepareContext(context)
		this.commitContext(prepared)
		return prepared.changed
	}

	/** Calculate a context fingerprint without making it active. */
	async prepareContext(context: CacheContext): Promise<PreparedCacheContext> {
		const [hash, initializerHash, lintHash] = await Promise.all([
			getSha1(stableStringify(context)),
			getSha1(stableStringify(context.initializerContext)),
			getSha1(stableStringify(context.lint)),
		])
		const changedHashKinds: CacheHashKind[] = []
		if (
			this.#activeInitializerHash !== undefined
			&& this.#activeInitializerHash !== initializerHash
		) {
			changedHashKinds.push('initializer')
		}
		if (this.#activeLintHash !== undefined && this.#activeLintHash !== lintHash) {
			changedHashKinds.push('lint')
		}
		return {
			changed: this.#activeContextHash !== undefined && this.#activeContextHash !== hash,
			changedHashKinds,
			hash,
			initializerHash,
			lintHash,
		}
	}

	/** Make a previously prepared context fingerprint active. */
	commitContext(context: PreparedCacheContext): void {
		this.#hashUpdateGeneration += 1
		this.#activeContextHash = context.hash
		this.#activeInitializerHash = context.initializerHash
		this.#activeLintHash = context.lintHash
	}

	/**
	 * Invalidate cached file-derived state without discarding the linked symbol table.
	 * Callers may target a subset of files; omitting `uris` invalidates every cached file.
	 * Initializer invalidation additionally forces roots and symbol registrars to be rebuilt.
	 */
	invalidatePartial(
		hashKind: CacheHashKind,
		uris?: Iterable<string>,
	): void {
		this.#hashUpdateGeneration += 1
		const targets = uris ?? new Set([
			...Object.keys(this.checksums.fileContents),
			...Object.keys(this.checksums.files),
			...Object.keys(this.errors),
		])
		for (const uri of targets) {
			this.#invalidatedFiles.add(uri)
			this.#fileContentUpdateTokens.delete(uri)
			delete this.checksums.fileContents[uri]
			delete this.checksums.files[uri]
			delete this.errors[uri]
		}
		if (hashKind === 'initializer') {
			this.#rootUpdateTokens.clear()
			this.checksums.roots = {}
			this.checksums.symbolRegistrars = {}
		}
		this.#hasValidatedFiles = false
	}

	/**
	 * Snapshot mutable cache state and suspend saves while a project rebuild is in progress.
	 * The snapshot can be restored without exposing a partially rebuilt symbol table on disk.
	 */
	beginTransaction(): CacheTransaction {
		this.#hashUpdateGeneration += 1
		const snapshot = {
			activeContextHash: this.#activeContextHash,
			activeInitializerHash: this.#activeInitializerHash,
			activeLintHash: this.#activeLintHash,
			checksums: {
				fileContents: { ...this.checksums.fileContents },
				files: { ...this.checksums.files },
				roots: { ...this.checksums.roots },
				symbolRegistrars: { ...this.checksums.symbolRegistrars },
			},
			errors: { ...this.errors },
			hasValidatedFiles: this.#hasValidatedFiles,
			invalidatedFiles: new Set(this.#invalidatedFiles),
			pendingCache: this.#pendingCache,
		}
		this.#saveSuspensions += 1
		let settled = false
		const settle = () => {
			if (settled) {
				throw new Error('Cache transaction has already settled')
			}
			settled = true
			this.#hashUpdateGeneration += 1
			this.#saveSuspensions -= 1
		}
		return {
			commit: () => settle(),
			rollback: () => {
				this.#activeContextHash = snapshot.activeContextHash
				this.#activeInitializerHash = snapshot.activeInitializerHash
				this.#activeLintHash = snapshot.activeLintHash
				this.checksums = snapshot.checksums
				this.errors = snapshot.errors
				this.#hasValidatedFiles = snapshot.hasValidatedFiles
				this.#invalidatedFiles = snapshot.invalidatedFiles
				this.#pendingCache = snapshot.pendingCache
				settle()
			},
		}
	}

	async validate(): Promise<ValidateResult> {
		const ans: ValidateResult = {
			addedFiles: [],
			changedFiles: [],
			removedFiles: [],
			unchangedFiles: [],
		}

		const unchangedRoots: string[] = []
		for (const [uri, checksum] of Object.entries(this.checksums.roots)) {
			try {
				const hash = await this.project.fs.hash(uri)
				if (hash === checksum) {
					unchangedRoots.push(uri)
				}
			} catch (e) {
				if (!this.project.externals.error.isKind(e, 'EISDIR')) {
					this.project.logger.error(`[CacheService#hash-file] ${uri}`)
				}
				// Failed calculating hash. Assume the root has changed.
			}
		}

		for (const [uri, checksum] of Object.entries(this.checksums.files)) {
			if (unchangedRoots.some((root) => fileUtil.isSubUriOf(uri, root))) {
				ans.unchangedFiles.push(uri)
				continue
			}
			if (this.project.shouldExclude(uri)) {
				ans.removedFiles.push(uri)
				continue
			}

			try {
				const hash = await this.project.fs.hash(uri)
				if (hash === checksum) {
					ans.unchangedFiles.push(uri)
				} else {
					ans.changedFiles.push(uri)
				}
			} catch (e) {
				if (
					this.project.externals.error.isKind(e, 'ENOENT')
					|| this.project.externals.error.isKind(e, 'EISDIR')
				) {
					ans.removedFiles.push(uri)
				} else {
					this.project.logger.error(`[CacheService#validate] ${uri}`, e)
					// Assume the file has changed.
					ans.changedFiles.push(uri)
				}
			}
		}

		const trackedFiles = new Set(this.project.getTrackedFiles())
		for (const uri of this.#invalidatedFiles) {
			if (trackedFiles.has(uri) && !this.project.shouldExclude(uri)) {
				ans.changedFiles.push(uri)
			} else {
				ans.removedFiles.push(uri)
			}
		}

		for (const uri of trackedFiles) {
			if (!(uri in this.checksums.files) && !this.#invalidatedFiles.has(uri)) {
				ans.addedFiles.push(uri)
			}
		}

		this.#invalidatedFiles.clear()
		this.#hasValidatedFiles = true

		return ans
	}

	/**
	 * @returns If the cache file was saved successfully.
	 */
	save(): Promise<boolean> {
		const result = this.#saveQueue.then(() => this.saveOnce())
		this.#saveQueue = result.then(() => undefined, () => undefined)
		return result
	}

	private async saveOnce(): Promise<boolean> {
		if (!this.canSave()) {
			return false
		}
		let filePath: string | undefined
		try {
			filePath = await this.getCacheFileUri()
			await this.waitForPendingHashUpdates()
			const sourceChecksums = this.checksums
			const generation = this.#hashUpdateGeneration
			const checksums = await this.createVerifiedChecksums(sourceChecksums, generation)
			if (!checksums) {
				return false
			}
			const contextHash = this.#activeContextHash
			const initializerHash = this.#activeInitializerHash
			const lintHash = this.#activeLintHash
			const projectRoots = [...this.project.projectRoots]
			if (
				!this.isSaveSnapshotCurrent(
					sourceChecksums,
					generation,
					contextHash,
					initializerHash,
					lintHash,
					projectRoots,
				)
				|| contextHash === undefined
				|| initializerHash === undefined
				|| lintHash === undefined
			) {
				return false
			}
			const __profiler = this.project.profilers.get('cache#save')
			const cache: CacheFile = {
				version: LatestCacheVersion,
				contextHash,
				initializerHash,
				lintHash,
				projectRoots,
				checksums,
				symbols: SymbolTable.unlink(this.project.symbols.global),
				errors: { ...this.errors },
			}
			__profiler.task('Unlink Symbols')

			const tempPath = `${filePath}.${await getSha1(
				`${Date.now()}:${Math.random()}`,
			)}.tmp`
			let published = false
			try {
				await fileUtil.writeGzippedJson(
					this.project.externals,
					tempPath,
					cache,
					bigintJsonLosslessReplacer,
				)
				__profiler.task('Write Temporary File')
				if (
					!this.isSaveSnapshotCurrent(
						sourceChecksums,
						generation,
						contextHash,
						initializerHash,
						lintHash,
						projectRoots,
					)
				) {
					return false
				}
				await this.project.externals.fs.rename(tempPath, filePath)
				published = true
				__profiler.task('Publish File').finalize()
				return true
			} finally {
				if (!published) {
					try {
						await this.project.externals.fs.unlink(tempPath)
					} catch (e) {
						if (!this.project.externals.error.isKind(e, 'ENOENT')) {
							this.project.logger.error(`[CacheService#save] cleanup = ${tempPath}`, e)
						}
					}
				}
			}
		} catch (e) {
			this.project.logger.error(`[CacheService#save] path = ${filePath}`, e)
			throw e
		}
	}

	private isSaveSnapshotCurrent(
		checksums: Checksums,
		generation: number,
		contextHash: string | undefined,
		initializerHash: string | undefined,
		lintHash: string | undefined,
		projectRoots: readonly string[],
	): boolean {
		return this.canSave()
			&& this.checksums === checksums
			&& this.#hashUpdateGeneration === generation
			&& this.#activeContextHash === contextHash
			&& this.#activeInitializerHash === initializerHash
			&& this.#activeLintHash === lintHash
			&& this.project.projectRoots.length === projectRoots.length
			&& this.project.projectRoots.every((root, index) => root === projectRoots[index])
	}

	async hasFileChangedSinceCache(doc: TextDocument): Promise<boolean> {
		return (this.checksums.fileContents[doc.uri] !== (await getSha1(doc.getText())))
	}

	reset(): LoadResult {
		this.#hasValidatedFiles = false
		this.#hashUpdateGeneration += 1
		this.#fileContentUpdateTokens.clear()
		this.#invalidatedFiles.clear()
		this.#rootUpdateTokens.clear()
		this.checksums = Checksums.create()
		this.errors = {}
		return { symbols: {} }
	}
}
