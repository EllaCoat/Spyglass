import type { TextDocument } from 'vscode-languageserver-textdocument'
import {
	bigintJsonLosslessReplacer,
	bigintJsonLosslessReviver,
	bufferToString,
	getSha1,
	mapLimit,
	Uri,
} from '../common/index.js'
import type { PosRangeLanguageError } from '../source/index.js'
import type { UnlinkedSymbolTable } from '../symbol/index.js'
import { SymbolTable, SymbolUtil } from '../symbol/index.js'
import type { LinterConfig } from './Config.js'
import { ArchiveUriSupporter } from './FileService.js'
import type { RootUriString } from './fileUtil.js'
import { fileUtil } from './fileUtil.js'
import type { Project } from './Project.js'

/**
 * The format version of the cache. Should be increased when any changes that
 * could invalidate the cache are introduced to the Spyglass codebase.
 *
 * Note: URI normalization of projectRoots (PR #25) does NOT require bumping this version.
 * The version check runs after cache files are located by hash-derived filename, so
 * pre-normalization cache files simply become orphaned (unread) rather than triggering
 * migration or reset. Bumping would only invalidate the live cache of users already on
 * canonical URIs (Linux/macOS + lowercase-drive Windows), for no gain.
 */
export const LatestCacheVersion = 9
const ChecksumReadConcurrency = 32

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

export interface SaveOptions {
	/**
	 * Reuse the checksums recorded while binding instead of re-reading every tracked file.
	 * Reserved for saves that directly follow a full rebuild; see
	 * `CacheService#createVerifiedChecksums`.
	 */
	trustRecordedHashes?: boolean
	/**
	 * The same reuse restricted to the listed URIs, for callers that covered part of the corpus
	 * rather than all of it. Trust is the union of the two options: a tracked file qualifies when
	 * `trustRecordedHashes` is set or when it is a member here, so passing both only widens the
	 * set to every tracked file. Whatever neither option covers keeps the full read path, as do
	 * the members a recorded reason disqualifies; see `CacheService#createVerifiedChecksums`.
	 *
	 * What this gives up: the window between recording a member's hashes and running the save is
	 * as long as the pass itself — minutes, for the file it started with — and an external change
	 * landing in that window is only noticed if the file watcher reports it before the save reads
	 * `#fileChangePendingUris`. A change it misses, or reports too late, is persisted with the
	 * hashes of the text the pass read, so the next session restores state built from content the
	 * file no longer holds. Closing that window means reading every member back, which is the very
	 * cost this option exists to remove: for `Project#analyzeProject` the verification would
	 * dominate its final save. The saves that do not pass either option — the autosave interval
	 * and `close()` — read every tracked file and correct such an entry then.
	 */
	trustRecordedHashesFor?: ReadonlySet<string>
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
	return !!value && typeof value === 'object' && !Array.isArray(value)
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

/**
 * Compute the symbol cache file basename from a list of canonical projectRoots.
 * Callers must pass roots already normalized via `normalizeUri` / `fileUtil.ensureEndingSlash`
 * (the Project constructor guarantees this since PR #25); passing raw URIs will produce a
 * different hash and cause cache misses.
 */
export async function computeSymbolCacheName(projectRoots: readonly string[]): Promise<string> {
	const sortedRoots = [...projectRoots].sort()
	const hash = await getSha1(sortedRoots.join(':'))
	return `symbols/${hash}.json.gz`
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
	/** File notifications received since the URI's latest completed hash recording. */
	readonly #fileChangePendingUris = new Set<string>()
	// Monotonic counter bumped on every mutation of cached state (root updates, file tracking,
	// context commits, partial invalidation, transactions, reset). `saveOnce` snapshots its
	// value on start and skips publishing when it moved (see `isSaveSnapshotCurrent`), so a
	// stale snapshot is never published to the final cache file: on mismatch the `.tmp`
	// staging file is removed in the surrounding `finally` block, not left behind. Only the
	// narrow TOCTOU window between the final `isSaveSnapshotCurrent` check and the `rename()`
	// itself is unguarded. Distinct in meaning from `Project`'s `#resetGeneration` /
	// `#reinitializationGeneration`, which serialize lifecycle barriers.
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
			this.trackDocumentUpdate(doc)
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
	}

	/**
	 * Synchronously stop a watcher-notified URI from reusing hashes recorded before the event.
	 * Invalidating its update token also prevents an older in-flight hash operation from
	 * recording stale values or clearing the marker after this notification.
	 */
	markFileChange(uri: string): void {
		this.#hashUpdateGeneration += 1
		this.#fileChangePendingUris.add(uri)
		this.#fileContentUpdateTokens.delete(uri)
	}

	/**
	 * Drop a removed URI's change marker. {@link trackDocumentUpdate} is what normally clears it,
	 * but a deleted file is never bound again, so its marker would otherwise be retained for the
	 * lifetime of the project and accumulate across bulk deletions.
	 */
	clearFileChange(uri: string): void {
		this.#fileChangePendingUris.delete(uri)
	}

	/** Track a processed document without requiring its AST to remain live until publication. */
	trackDocumentUpdate(doc: TextDocument): void {
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
					// A missing `files` entry already forces verification. Either way, the
					// current document state has now replaced every hash from before the event.
					this.#fileChangePendingUris.delete(doc.uri)
				}
			} catch (e) {
				if (!this.project.externals.error.isKind(e, 'EISDIR')) {
					this.project.logger.error(`[CacheService#hash-file] ${doc.uri}`)
				}
			}
		})
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

	/**
	 * Build the checksum snapshot a save publishes, confirming that every tracked file on disk
	 * still holds the text the in-memory state was built from.
	 *
	 * @param trustRecordedHashes Reuse the recorded hashes of tracked files that have both a
	 * `fileContents` and a `files` entry instead of reading those files back from disk. Only
	 * callers running right after a full rebuild may pass `true`: every tracked file was bound
	 * moments ago, {@link trackDocumentUpdate} recorded both hashes from the same read, and
	 * `saveOnce` awaits {@link waitForPendingHashUpdates} before getting here, so re-reading the
	 * whole corpus repeats a verification that has just run. What is deliberately not trusted:
	 * a file with no `fileContents` entry was never bound, one with no `files` entry is one
	 * `trackDocumentUpdate` found disagreeing with its backing file (an unsaved client-managed
	 * edit, for instance), and one in `#fileChangePendingUris` received a watcher notification
	 * after its hashes were recorded. All three keep the full read path.
	 *
	 * The cost is that an external change the file watcher missed is no longer caught here, so
	 * the reuse stays scoped to rebuild-driven saves; the autosave interval and `close()` keep
	 * verifying every tracked file.
	 *
	 * @param trustRecordedHashesFor The same reuse, granted one URI at a time. A pass that covers
	 * part of the corpus cannot pass `trustRecordedHashes` — `Project#analyzeProject` walks the
	 * project's own files and leaves the dependency files, which outnumber them, untouched, and
	 * the flag would extend its confidence to every file it never looked at, publishing whatever
	 * external change the watcher missed on those. Membership is therefore earned per URI: the
	 * pass read, bound, checked and published the document, and it is that publish which recorded
	 * the hashes reused here. A URI the pass skipped, failed on, or stopped short of is absent
	 * from the set and keeps the full read path. The three exclusions above still apply to
	 * members, because each names a concrete reason the recorded hashes cannot be believed —
	 * a reason about the file itself, which no caller is in a position to overrule.
	 */
	private async createVerifiedChecksums(
		checksums: Checksums,
		generation: number,
		trustRecordedHashes = false,
		trustRecordedHashesFor?: ReadonlySet<string>,
	): Promise<Checksums | undefined> {
		const reusedUris: string[] = []
		const readUris: string[] = []
		for (const uri of this.project.getTrackedFiles()) {
			if (
				(trustRecordedHashes || trustRecordedHashesFor?.has(uri) === true)
				&& !this.#fileChangePendingUris.has(uri)
				&& checksums.fileContents[uri] !== undefined
				&& checksums.files[uri] !== undefined
			) {
				reusedUris.push(uri)
			} else {
				readUris.push(uri)
			}
		}
		const updates = await mapLimit(
			readUris,
			ChecksumReadConcurrency,
			async (uri) => {
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
			},
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
		// Reused URIs always carry a `fileContents` entry, so they can never reach the
		// `stateHash === undefined` abort below; skipping them drops no error-entry check.
		for (const uri of reusedUris) {
			verified.files[uri] = checksums.files[uri]
			verified.fileContents[uri] = checksums.fileContents[uri]
		}
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
			const name = await computeSymbolCacheName(this.project.projectRoots)
			this.#cacheFilePath = new Uri(name, this.cacheRoot).toString()
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
	 * Invalidate cached file-derived state.
	 * Callers may target a subset of files; omitting `uris` invalidates every cached file.
	 * Initializer invalidation always discards all linked symbols and file-derived state because a
	 * removed initializer provider cannot identify its former contributions in a new registry.
	 *
	 * Boundary with {@link reset}: prefer this method when staleness is scoped to a single hash
	 * kind (lint or file-derived state), and a full `reset()` when every cache must go. An
	 * `initializer` change can never stay partial and always takes the clear-all branch below.
	 */
	invalidatePartial(
		hashKind: CacheHashKind,
		uris?: Iterable<string>,
	): void {
		this.#hashUpdateGeneration += 1
		const targets = hashKind === 'initializer'
			? new Set([
				...this.project.getTrackedFiles(),
				...Object.keys(this.checksums.fileContents),
				...Object.keys(this.checksums.files),
				...Object.keys(this.errors),
			])
			: uris ?? new Set([
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
			this.#pendingCache = undefined
			this.#rootUpdateTokens.clear()
			this.checksums.roots = {}
			this.checksums.symbolRegistrars = {}
			this.project.symbols = new SymbolUtil({})
			this.project.symbols.buildCache()
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
	 * @param options `trustRecordedHashes` skips re-reading tracked files whose hashes were just
	 * recorded, and `trustRecordedHashesFor` skips the same reads for the listed URIs alone; see
	 * {@link createVerifiedChecksums} for who may pass either.
	 * @returns If the cache file was saved successfully.
	 */
	save(options?: SaveOptions): Promise<boolean> {
		const result = this.#saveQueue.then(() => this.saveOnce(options))
		this.#saveQueue = result.then(() => undefined, () => undefined)
		return result
	}

	private async saveOnce(options?: SaveOptions): Promise<boolean> {
		if (!this.canSave()) {
			return false
		}
		let filePath: string | undefined
		try {
			filePath = await this.getCacheFileUri()
			await this.waitForPendingHashUpdates()
			const sourceChecksums = this.checksums
			const generation = this.#hashUpdateGeneration
			const checksums = await this.createVerifiedChecksums(
				sourceChecksums,
				generation,
				options?.trustRecordedHashes,
				options?.trustRecordedHashesFor,
			)
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
