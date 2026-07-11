import type { TextDocument } from 'vscode-languageserver-textdocument'
import {
	bigintJsonLosslessReplacer,
	bigintJsonLosslessReviver,
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
export const LatestCacheVersion = 8

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

/**
 * Checksums of cached files or roots.
 */
interface Checksums {
	files: Record<string, string>
	roots: Record<RootUriString, string>
	symbolRegistrars: Record<string, string>
}
namespace Checksums {
	export function create(): Checksums {
		return { files: {}, roots: {}, symbolRegistrars: {} }
	}
}

type ErrorCache = Record<string, readonly PosRangeLanguageError[]>

/**
 * Format of cache JSON files.
 */
interface CacheFile {
	checksums: Checksums
	/**
	 * Fingerprint of the initializer and lint context when the cache was saved.
	 * Set by {@link CacheService.activate}. Undefined when loading a cache from
	 * an earlier fork version — treated as a mismatch.
	 */
	contextHash?: string
	errors: ErrorCache
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

export class CacheService {
	checksums = Checksums.create()
	errors: ErrorCache = {}
	#hasValidatedFiles = false
	#pendingCache: CacheFile | undefined
	#activeContextHash: string | undefined

	/**
	 * @param cacheRoot File path to the directory where cache files by Spyglass should be stored.
	 * @param project
	 */
	constructor(private readonly cacheRoot: RootUriString, private readonly project: Project) {
		this.project.on('documentUpdated', async ({ doc }) => {
			if (
				!this.#hasValidatedFiles
				// Do not save checksums for file schemes that we cannot map to disk (e.g. 'untitled:'
				// for untitled files in VS Code)
				|| !(doc.uri.startsWith(ArchiveUriSupporter.Protocol) || doc.uri.startsWith('file:'))
			) {
				return
			}
			try {
				// TODO: Don't update this for every single change.
				this.checksums.files[doc.uri] = await getSha1(doc.getText())
			} catch (e) {
				if (!this.project.externals.error.isKind(e, 'EISDIR')) {
					this.project.logger.error(`[CacheService#hash-file] ${doc.uri}`)
				}
			}
		})
		this.project.on('rootsUpdated', async ({ roots }) => {
			if (!this.#hasValidatedFiles) {
				return
			}
			for (const root of roots) {
				try {
					this.checksums.roots[root] = await this.project.fs.hash(root)
				} catch (e) {
					if (!this.project.externals.error.isKind(e, 'EISDIR')) {
						this.project.logger.error(`[CacheService#hash-root] ${root}`, e)
					}
				}
			}
		})
		this.project.on('symbolRegistrarExecuted', ({ id, checksum }) => {
			if (checksum !== undefined) {
				this.checksums.symbolRegistrars[id] = checksum
			}
		})
		this.project.on('documentErrored', ({ uri, errors }) => {
			this.errors[uri] = errors
		})
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
			const cache = (await fileUtil.readGzippedJson(
				this.project.externals,
				filePath,
				bigintJsonLosslessReviver,
			)) as CacheFile
			__profiler.task('Read File')
			if (cache.version === LatestCacheVersion) {
				this.#pendingCache = cache
			} else {
				this.project.logger.info(
					`[CacheService#loadMetadata] Unsupported cache format ${cache.version}; expected ${LatestCacheVersion}`,
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
		await this.updateContext(context)
		const cache = this.#pendingCache
		this.#pendingCache = undefined
		if (this.project.projectRoots.length === 0) {
			return ans
		}
		const __profiler = this.project.profilers.get('cache#activate')
		try {
			if (!cache || cache.contextHash !== this.#activeContextHash) {
				this.project.logger.info(
					`[CacheService#activate] context ${cache ? 'mismatch' : 'missing'}; dropping cache`,
				)
				this.checksums = Checksums.create()
				this.errors = {}
				this.#hasValidatedFiles = false
				return ans
			}
			this.checksums = cache.checksums
			this.errors = cache.errors
			ans.symbols = SymbolTable.link(cache.symbols)
			__profiler.task('Link Symbols')
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
		const next = await getSha1(stableStringify(context))
		const changed = this.#activeContextHash !== undefined
			&& this.#activeContextHash !== next
		this.#activeContextHash = next
		return changed
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

		for (const uri of this.project.getTrackedFiles()) {
			if (!(uri in this.checksums.files)) {
				ans.addedFiles.push(uri)
			}
		}

		this.#hasValidatedFiles = true

		return ans
	}

	/**
	 * @returns If the cache file was saved successfully.
	 */
	async save(): Promise<boolean> {
		if (this.project.projectRoots.length === 0) {
			return false
		}
		const __profiler = this.project.profilers.get('cache#save')
		let filePath: string | undefined
		try {
			filePath = await this.getCacheFileUri()
			const cache: CacheFile = {
				version: LatestCacheVersion,
				contextHash: this.#activeContextHash,
				projectRoots: this.project.projectRoots,
				checksums: this.checksums,
				symbols: SymbolTable.unlink(this.project.symbols.global),
				errors: this.errors,
			}
			__profiler.task('Unlink Symbols')

			await fileUtil.writeGzippedJson(
				this.project.externals,
				filePath,
				cache,
				bigintJsonLosslessReplacer,
			)
			__profiler.task('Write File').finalize()

			return true
		} catch (e) {
			this.project.logger.error(`[CacheService#save] path = ${filePath}`, e)
		}
		return false
	}

	async hasFileChangedSinceCache(doc: TextDocument): Promise<boolean> {
		return (this.checksums.files[doc.uri] !== (await getSha1(doc.getText())))
	}

	reset(): LoadResult {
		this.#hasValidatedFiles = false
		this.checksums = Checksums.create()
		this.errors = {}
		return { symbols: {} }
	}
}
