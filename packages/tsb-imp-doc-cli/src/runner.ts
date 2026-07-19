import * as core from '@spyglassmc/core'
import { NodeJsExternals } from '@spyglassmc/core/lib/nodejs.js'
import * as impDoc from '@spyglassmc/tsb-imp-doc'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { rawCacheToken, writeCacheAtomically } from './cache-file.js'
import {
	createDependencyGraph,
	type DependencyGraph,
	expandAffectedFiles,
	isDependencyGraph,
	isDependencyGraphConsistent,
	toSymbolKey,
} from './graph.js'
import {
	type ExportSymbolSummary,
	type FileManifestEntry,
	isPerFileManifest,
	type PerFileManifest,
} from './manifest.js'
import type { DiagnosticSeverity, LintDiagnostic } from './reporter.js'

const CacheVersion = 2
const ImpDocPrivateRule = 'impDocPrivate'
const ImpDocPrivateBestEffortRule = 'impDocPrivateBestEffort'
const UnresolvedRule = 'unresolved'
/** Default severities applied unless the rule is configured in the overrides. */
const DefaultLintSeverities: Readonly<Record<string, string>> = {
	[ImpDocPrivateRule]: 'error',
	[ImpDocPrivateBestEffortRule]: 'warning',
}
export const SerializeProfilerId = 'project#cache#serialize'
export const SerializeManifestProfilerId = 'project#cache#serialize#manifest'
const ExportUsageTypes = [
	'declaration',
	'definition',
	'implementation',
	'typeDefinition',
] as const

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const LegacyDeclarationCategoryPattern = impDoc.LEGACY_DECLARABLE_TYPES
	.map(spec => escapeRegExp(spec.id))
	.sort((a, b) => b.length - a.length || a.localeCompare(b))
	.join('|')
const LegacyDeclarationExportPattern = new RegExp(
	`^[\\t ]*#(?:declare|define)[\\t ]+(${LegacyDeclarationCategoryPattern})`
		+ '[\\t ]+(\\S+)',
	'gm',
)
const LegacyAliasExportPattern = /^[\t ]*#alias[\t ]+(\S+)[\t ]+([^\r\n]*)/gm
const LegacyAliasCategoryByKind: ReadonlyMap<string, string> = new Map(
	impDoc.LEGACY_ALIAS_TYPES.map(spec => [
		spec.id.slice('alias/'.length),
		spec.id,
	]),
)

export interface RunnerOptions {
	targetDir: string
	parallel: number
	skipUnresolved?: boolean
	cachePath?: string
	config?: Record<string, unknown>
	profilers?: core.ProfilerFactory
}

export interface RunResult {
	diagnostics: LintDiagnostic[]
	filesScanned: number
	/** Number of files parsed, bound, checked, and linted during this invocation. */
	filesProcessed: number
	/** True only when a valid cache made the invocation a true no-op. */
	cacheHit: boolean
	/** True when no valid cache could be activated and every readable file was processed. */
	fullScan: boolean
}

interface FileInput {
	file: string
	content: string
	sha1: string
}

interface FileState extends FileInput {
	uri: string
	doc: TextDocument
	node: core.FileNode<core.AstNode>
}

interface ResultCache {
	version: number
	contextHash: string
	generation: number
	manifest: PerFileManifest
	graph: DependencyGraph
	symbols: core.UnlinkedSymbolTable
	filesScanned: number
}

interface ActivatedCache {
	cache: ResultCache
	symbols: core.SymbolTable
}

interface CacheSnapshot {
	activated?: ActivatedCache
	token?: string
}

interface CliMcfunctionNode extends core.AstNode {
	type: 'tsb-imp-doc-cli:mcfunction'
	children: core.AstNode[]
}

function sha1(value: string): string {
	return createHash('sha1').update(value).digest('hex')
}

function stableStringify(value: unknown): string {
	return JSON.stringify(value, (_key, item) => {
		if (item && typeof item === 'object' && !Array.isArray(item)) {
			return Object.fromEntries(
				Object.entries(item as Record<string, unknown>)
					.sort(([a], [b]) => a.localeCompare(b)),
			)
		}
		return item
	})
}

function severityName(severity: core.ErrorSeverity): DiagnosticSeverity {
	switch (severity) {
		case core.ErrorSeverity.Hint:
			return 'hint'
		case core.ErrorSeverity.Information:
			return 'information'
		case core.ErrorSeverity.Warning:
			return 'warning'
		case core.ErrorSeverity.Error:
		default:
			return 'error'
	}
}

function stripRuleSuffix(message: string, rule: string): string {
	return message
		.replace(new RegExp(`\\s+\\(rule: ${rule}\\)$`), '')
		.replace(new RegExp(`\\s+（ルール: ${rule}）$`), '')
}

function toDiagnostic(
	state: FileState,
	error: core.LanguageError,
	rule: string,
): LintDiagnostic {
	const position = state.doc.positionAt(error.range.start)
	return {
		file: state.file,
		line: position.line + 1,
		col: position.character + 1,
		severity: severityName(error.severity),
		rule,
		message: stripRuleSuffix(error.message, rule),
	}
}

function runnerError(file: string, error: unknown): LintDiagnostic {
	return {
		file,
		line: 1,
		col: 1,
		severity: 'error',
		rule: UnresolvedRule,
		message: error instanceof Error ? error.message : String(error),
	}
}

function parseResourceLocation(
	raw: string,
	range: core.Range,
): core.ResourceLocationNode {
	const isTag = raw.startsWith('#')
	const id = isTag ? raw.slice(1) : raw
	const separator = id.indexOf(':')
	const namespace = separator >= 0 ? id.slice(0, separator) : undefined
	const path = id.slice(separator + 1).split('/')
	return {
		type: 'resource_location',
		range,
		namespace,
		path,
		isTag,
		options: {
			category: 'function',
			allowTag: true,
			usageType: 'reference',
		},
	}
}

/**
 * Naive single-line scan that reports whether `index` sits inside an unclosed
 * `'` / `"` quote. Backslash escapes are honoured; any nested structure beyond
 * that is irrelevant for provenance classification.
 */
function isInsideQuote(line: string, index: number): boolean {
	let quote: string | undefined
	for (let i = 0; i < index; i++) {
		const char = line[i]
		if (quote === undefined) {
			if (char === '"' || char === "'") {
				quote = char
			}
		} else if (char === '\\') {
			i++
		} else if (char === quote) {
			quote = undefined
		}
	}
	return quote !== undefined
}

/**
 * Minimal base parser for the CI vertical slice. The IMP-Doc initializer wraps this parser and
 * replaces the emitted legacy comment nodes with its own ImpDocNode implementation.
 */
const cliMcfunction: core.Parser<CliMcfunctionNode> = (src, ctx) => {
	const children: core.AstNode[] = []
	let offset = 0
	for (const line of src.string.split(/\r?\n/)) {
		const leadingSpace = line.match(/^[\t ]*/)?.[0].length ?? 0
		if (line[leadingSpace] === '#') {
			children.push({
				type: 'comment',
				range: core.Range.create(offset + leadingSpace, offset + line.length),
			})
		} else {
			const isMacroLine = line[leadingSpace] === '$'
			const dynamicPattern = /\bfunction[\t ]+\$\([^\s)]*\)?/g
			for (const match of line.matchAll(dynamicPattern)) {
				const range = core.Range.create(
					offset + match.index,
					offset + match.index + match[0].length,
				)
				// A fully dynamic target can never be resolved statically, so it
				// stays best-effort: a warning plus a provenance-tagged marker
				// node instead of a hard error.
				ctx.err.report(
					'Unresolved dynamic function reference',
					range,
					core.ErrorSeverity.Warning,
				)
				const marker: core.AstNode = { type: 'tsb-imp-doc-cli:dynamic-ref', range }
				impDoc.setRefProvenance(marker, 'dynamic-pattern')
				children.push(marker)
			}

			const referencePattern =
				/\bfunction[\t ]+(#[A-Za-z0-9_.-]+(?::[A-Za-z0-9_./-]+)?|[A-Za-z0-9_.-]+(?::[A-Za-z0-9_./-]+)?)/g
			for (const match of line.matchAll(referencePattern)) {
				const raw = match[1]
				// A `$(` right after the static prefix means the actual target is
				// completed by a macro substitution at runtime; the prefix alone
				// would be a spurious reference, so no node is emitted for it.
				if (line.startsWith('$(', match.index + match[0].length)) {
					continue
				}
				const targetStart = offset + match.index + match[0].lastIndexOf(raw)
				const ref = parseResourceLocation(
					raw,
					core.Range.create(targetStart, targetStart + raw.length),
				)
				// Macro lines are rewritten by substitution before execution and
				// quoted payloads (usually SNBT) may never run as commands, so
				// their references only get best-effort treatment.
				if (isMacroLine) {
					impDoc.setRefProvenance(ref, 'macro')
				} else if (isInsideQuote(line, match.index)) {
					impDoc.setRefProvenance(ref, 'nbt-string')
				}
				children.push(ref)
			}
		}
		offset += line.length
			+ (src.string.slice(offset + line.length, offset + line.length + 2) === '\r\n'
				? 2
				: 1)
	}

	src.cursor = src.string.length
	return {
		type: 'tsb-imp-doc-cli:mcfunction',
		range: core.Range.create(0, src.string.length),
		children,
	}
}

function createConfig(overrides: Record<string, unknown> | undefined): core.Config {
	const config = core.ConfigService.merge(
		core.VanillaConfig,
		{
			env: { dependencies: [] },
			lint: { ...DefaultLintSeverities },
		},
		overrides ?? {},
	)
	const lint = config.lint as unknown as Record<string, unknown>
	for (const rule of Object.keys(core.VanillaConfig.lint)) {
		delete lint[rule]
	}
	for (const [rule, severity] of Object.entries(DefaultLintSeverities)) {
		if (
			!(overrides?.['lint'] && typeof overrides['lint'] === 'object'
				&& rule in overrides['lint'])
		) {
			lint[rule] = severity
		}
	}
	return config
}

function createLogger(): core.Logger {
	return {
		error: () => {},
		info: () => {},
		log: () => {},
		warn: () => {},
	}
}

function inferFunctionId(file: string): string | undefined {
	const parts = file.replace(/\\/g, '/').split('/')
	for (let i = parts.length - 2; i >= 0; i--) {
		if (parts[i] !== 'functions' && parts[i] !== 'function') {
			continue
		}
		if (i < 1 || !parts.at(-1)?.endsWith('.mcfunction')) {
			return undefined
		}
		const namespace = parts[i - 1]
		const pathParts = parts.slice(i + 1)
		pathParts[pathParts.length - 1] = pathParts.at(-1)!.slice(0, -'.mcfunction'.length)
		return `${namespace}:${pathParts.join('/')}`
	}
	return undefined
}

function getImpDocFunctionIds(node: core.AstNode): string[] {
	const ids: string[] = []
	core.traversePreOrder(
		node,
		() => true,
		(candidate): candidate is impDoc.ImpDocNode => candidate.type === 'impDoc',
		(candidate) => {
			if (candidate.functionID?.raw) {
				ids.push(candidate.functionID.raw)
			}
		},
	)
	return ids
}

function contextHash(options: RunnerOptions): string {
	return sha1(stableStringify({
		version: CacheVersion,
		impDocVersion: impDoc.ImpDocVersion,
		targetDir: resolve(options.targetDir),
		skipUnresolved: options.skipUnresolved ?? false,
		config: options.config ?? {},
	}))
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isResultCache(value: unknown, expectedContextHash: string): value is ResultCache {
	if (!isRecord(value)) {
		return false
	}
	const generation = value['generation']
	return value['version'] === CacheVersion
		&& value['contextHash'] === expectedContextHash
		&& Number.isSafeInteger(generation)
		&& (generation as number) > 0
		&& typeof value['filesScanned'] === 'number'
		&& isRecord(value['symbols'])
		&& isPerFileManifest(value['manifest'], generation as number)
		&& isDependencyGraph(value['graph'], generation as number)
		&& isDependencyGraphConsistent(value['graph'], value['manifest'])
}

async function readCacheSnapshot(
	path: string,
	expectedContextHash: string,
): Promise<CacheSnapshot> {
	let rawBytes: Buffer
	try {
		rawBytes = await readFile(path)
	} catch {
		return {}
	}

	const token = rawCacheToken(rawBytes)
	let value: unknown
	try {
		value = JSON.parse(rawBytes.toString('utf8'))
	} catch {
		return { token }
	}
	if (!isResultCache(value, expectedContextHash)) {
		return { token }
	}
	try {
		return {
			activated: {
				cache: value,
				symbols: core.SymbolTable.link(value.symbols),
			},
			token,
		}
	} catch {
		return { token }
	}
}

async function readInputs(
	files: readonly string[],
	parallel: number,
	diagnostics: LintDiagnostic[],
	skipUnresolved: boolean,
): Promise<Map<string, FileInput>> {
	const entries = await core.mapLimit(files, parallel, async (file) => {
		try {
			const content = await readFile(file, 'utf8')
			return { file, content, sha1: sha1(content) } satisfies FileInput
		} catch (error) {
			if (!skipUnresolved) {
				diagnostics.push(runnerError(file, error))
			}
			return undefined
		}
	})
	return new Map(
		entries
			.filter((entry): entry is FileInput => entry !== undefined)
			.map(entry => [entry.file, entry]),
	)
}

function discoverExportKeys(input: FileInput): string[] {
	const keys = new Set<string>()
	const inferredId = inferFunctionId(input.file)
	if (inferredId) {
		keys.add(toSymbolKey('function', [inferredId]))
	}
	for (const match of input.content.matchAll(/^\s*#>\s*(\S+)/gm)) {
		keys.add(toSymbolKey('function', [match[1]]))
	}
	for (const match of input.content.matchAll(LegacyDeclarationExportPattern)) {
		const category = match[1]!
		const canonical = impDoc.canonicalizeLegacyDeclarationName(category, match[2]!)
		if (canonical !== undefined) {
			keys.add(toSymbolKey(category, [canonical]))
		}
	}
	for (const match of input.content.matchAll(LegacyAliasExportPattern)) {
		const kind = match[1]!
		const nameSrc = new core.Source(match[2]!)
		const err = new core.ErrorReporter()
		const name = impDoc.parseLegacyAliasNameToken(nameSrc, { err })
		if (!name || !core.Source.isSpace(nameSrc.peek())) {
			continue
		}
		nameSrc.skipSpace()
		if (!nameSrc.canRead()) {
			continue
		}
		const category = LegacyAliasCategoryByKind.get(kind) ?? `alias/${kind}`
		keys.add(toSymbolKey(category, [name.value]))
	}
	return [...keys]
}

function createFileState(
	input: FileInput,
	projectData: core.ProjectData,
): FileState {
	const uri = pathToFileURL(input.file).toString()
	const doc = TextDocument.create(uri, 'mcfunction', 0, input.content)
	const parser = projectData.meta.getParserForLanguageId<core.AstNode>('mcfunction')!
	const node = core.file(parser)(
		new core.Source(input.content),
		core.ParserContext.create(projectData, { doc }),
	)
	return { ...input, uri, doc, node }
}

function collectReferences(state: FileState): string[] {
	const references = new Set<string>()
	core.traversePreOrder(
		state.node,
		() => true,
		() => true,
		(candidate) => {
			if (core.ResourceLocationNode.is(candidate) && candidate.options.category) {
				const symbolPath = core.SymbolPath.fromSymbol(candidate.symbol)
				const category = candidate.isTag
					? `tag/${candidate.options.category}`
					: candidate.options.category
				references.add(
					symbolPath
						? toSymbolKey(symbolPath.category, symbolPath.path)
						: toSymbolKey(category, [
							core.ResourceLocationNode.toString(candidate, 'full'),
						]),
				)
			} else if (
				core.SymbolNode.is(candidate)
				&& candidate.value
				&& (candidate.options.usageType ?? 'reference') === 'reference'
			) {
				const symbolPath = core.SymbolPath.fromSymbol(candidate.symbol)
				references.add(
					symbolPath
						? toSymbolKey(symbolPath.category, symbolPath.path)
						: toSymbolKey(candidate.options.category, [
							...(candidate.options.parentPath ?? []),
							candidate.value,
						]),
				)
			}
		},
	)
	return [...references].sort()
}

/**
 * Collects exported symbol summaries for every URI in `uris` with a single
 * traversal of the global symbol table, instead of one traversal per file.
 *
 * Equivalent to the previous per-file collection: for each symbol, `usage`
 * lists the matching {@link ExportUsageTypes} in declaration order
 * (`reference` stays excluded), and each per-URI bucket is sorted by symbol
 * key. URIs without exports have no entry in the returned map.
 */
function collectAllExports(
	symbols: core.SymbolUtil,
	uris: ReadonlySet<string>,
): Map<string, ExportSymbolSummary[]> {
	const exportsByUri = new Map<string, ExportSymbolSummary[]>()
	core.SymbolUtil.forEachSymbol(symbols.global, (symbol) => {
		let usageByUri: Map<string, ExportSymbolSummary['usage']> | undefined
		for (const type of ExportUsageTypes) {
			for (const location of symbol[type] ?? []) {
				if (!uris.has(location.uri)) {
					continue
				}
				const usage = (usageByUri ??= new Map()).get(location.uri)
				if (!usage) {
					usageByUri.set(location.uri, [type])
				} else if (usage[usage.length - 1] !== type) {
					// Types are visited in declaration order, so a duplicate of
					// the current type can only be the last element.
					usage.push(type)
				}
			}
		}
		if (!usageByUri) {
			return
		}
		for (const [uri, usage] of usageByUri) {
			let exports = exportsByUri.get(uri)
			if (!exports) {
				exports = []
				exportsByUri.set(uri, exports)
			}
			exports.push({
				category: symbol.category,
				path: [...symbol.path],
				key: toSymbolKey(symbol.category, symbol.path),
				usage,
			})
		}
	})
	for (const exports of exportsByUri.values()) {
		exports.sort((a, b) => a.key.localeCompare(b.key))
	}
	return exportsByUri
}

function sortDiagnostics(diagnostics: LintDiagnostic[]): void {
	diagnostics.sort((a, b) =>
		a.file.localeCompare(b.file)
		|| a.line - b.line
		|| a.col - b.col
		|| a.rule.localeCompare(b.rule)
		|| a.message.localeCompare(b.message)
	)
}

async function checksumBarrier(
	files: readonly string[],
	inputs: ReadonlyMap<string, FileInput>,
	parallel: number,
): Promise<boolean> {
	if (inputs.size !== files.length) {
		return false
	}
	const matches = await core.mapLimit(files, parallel, async (file) => {
		try {
			return sha1(await readFile(file, 'utf8')) === inputs.get(file)?.sha1
		} catch {
			return false
		}
	})
	return matches.every(Boolean)
}

/** Runs the registered parser, checker, and private linter over scanner output. */
export async function runImpDocLint(
	files: readonly string[],
	options: RunnerOptions,
): Promise<RunResult> {
	if (!Number.isSafeInteger(options.parallel) || options.parallel < 1) {
		throw new Error(`parallel must be a positive integer, got ${options.parallel}`)
	}

	const normalizedFiles = [...new Set(files.map(file => resolve(file)))].sort()
	const normalizedFileSet = new Set(normalizedFiles)
	const cachePath = options.cachePath ? resolve(options.cachePath) : undefined
	const activeContextHash = contextHash(options)
	const cacheSnapshot = cachePath
		? await readCacheSnapshot(cachePath, activeContextHash)
		: {}
	const activated = cacheSnapshot.activated
	const fullScan = activated === undefined
	const readDiagnostics: LintDiagnostic[] = []
	const inputs = await readInputs(
		normalizedFiles,
		options.parallel,
		readDiagnostics,
		options.skipUnresolved ?? false,
	)

	const changedFiles = new Set<string>()
	if (activated) {
		for (const file of normalizedFiles) {
			if (activated.cache.manifest.files[file]?.sha1 !== inputs.get(file)?.sha1) {
				changedFiles.add(file)
			}
		}
		for (const file of Object.keys(activated.cache.manifest.files)) {
			if (!normalizedFileSet.has(file)) {
				changedFiles.add(file)
			}
		}
	} else {
		for (const file of normalizedFiles) {
			changedFiles.add(file)
		}
	}

	const discoveredExportKeys = [...changedFiles]
		.flatMap(file => inputs.has(file) ? discoverExportKeys(inputs.get(file)!) : [])
	const affectedFiles = activated
		? expandAffectedFiles(
			changedFiles,
			discoveredExportKeys,
			activated.cache.manifest,
			activated.cache.graph,
		)
		: new Set(normalizedFiles)

	if (activated && affectedFiles.size === 0 && readDiagnostics.length === 0) {
		const diagnostics = Object.values(activated.cache.manifest.files)
			.flatMap(entry => entry.diagnostics)
		sortDiagnostics(diagnostics)
		return {
			diagnostics,
			filesScanned: normalizedFiles.length,
			filesProcessed: 0,
			cacheHit: true,
			fullScan: false,
		}
	}

	const targetDir = resolve(options.targetDir)
	const rootUri = core.fileUtil.ensureEndingSlash(pathToFileURL(targetDir).toString())
	const cacheRoot = core.fileUtil.ensureEndingSlash(
		pathToFileURL(dirname(cachePath ?? targetDir)).toString(),
	)
	const logger = createLogger()
	const meta = new core.MetaRegistry()
	const symbols = new core.SymbolUtil(activated?.symbols ?? {})
	const config = createConfig(options.config)
	const projectData: core.ProjectData = {
		cacheRoot,
		config,
		ctx: { errorSource: 'tsb-imp-doc-cli' },
		ensureBindingStarted: async () => {},
		externals: NodeJsExternals,
		fs: core.FileService.create(NodeJsExternals, cacheRoot),
		isDebugging: false,
		logger,
		meta,
		profilers: options.profilers ?? core.ProfilerFactory.noop(),
		projectRoots: [rootUri],
		roots: [rootUri],
		symbols,
	}

	meta.registerLanguage('mcfunction', {
		extensions: ['.mcfunction'],
		parser: cliMcfunction,
	})
	await impDoc.initialize({ ...projectData, reinitializeOnChange: () => {} })

	// Match Project's URI lifecycle when a warm cache reprocesses a file:
	// plugin-owned metadata must be cleared before core removes its locations.
	// Initializing IMP-Doc first makes its declaration visibility clearer
	// available on this standalone CLI path as well.
	if (activated) {
		symbols.buildCache()
		const clearContext = core.UriBinderContext.create(projectData)
		for (const file of affectedFiles) {
			const uri = pathToFileURL(file).toString()
			for (const clearer of meta.uriSymbolClearers) {
				clearer(uri, clearContext)
			}
			symbols.clear({ uri })
		}
		symbols.trim(symbols.global)
	}

	const diagnostics = activated
		? Object.entries(activated.cache.manifest.files)
			.filter(([file]) => inputs.has(file) && !affectedFiles.has(file))
			.flatMap(([, entry]) => entry.diagnostics)
		: []
	diagnostics.push(...readDiagnostics)

	const parseProfiler = projectData.profilers.get('project#ready#parse', 'top-n', 50)
	const processInputs = [...affectedFiles]
		.map(file => inputs.get(file))
		.filter((input): input is FileInput => input !== undefined)
	const parsed = await core.mapLimit(processInputs, options.parallel, async (input) => {
		const uri = pathToFileURL(input.file).toString()
		try {
			return createFileState(input, projectData)
		} catch (error) {
			if (!options.skipUnresolved) {
				diagnostics.push(runnerError(input.file, error))
			}
			return undefined
		} finally {
			parseProfiler.task(uri)
		}
	})
	parseProfiler.finalize()
	const states = parsed.filter((state): state is FileState => state !== undefined)

	// Enter declarations, rather than definitions, so the checker only assigns function visibility
	// to components that carry a function ID.
	symbols.contributeAs('uri_binder', () => {
		const entered = new Set<string>()
		for (const state of states) {
			const ids = [inferFunctionId(state.file), ...getImpDocFunctionIds(state.node)]
			for (const id of ids) {
				if (!id || entered.has(`${state.uri}\0${id}`)) {
					continue
				}
				entered.add(`${state.uri}\0${id}`)
				symbols.query(state.uri, 'function', id).enter({
					usage: { type: 'declaration' },
				})
			}
		}
	})

	const bindProfiler = projectData.profilers.get('project#ready#bind', 'top-n', 50)
	for (const state of states) {
		try {
			const ctx = core.BinderContext.create(projectData, { doc: state.doc })
			const binder = meta.getBinder(state.node.type)
			await symbols.contributeAsAsync('binder', async () => {
				await binder(core.StateProxy.create(state.node), ctx)
			})
			state.node.binderErrors = ctx.err.dump()
		} catch (error) {
			if (!options.skipUnresolved) {
				diagnostics.push(runnerError(state.file, error))
			}
		} finally {
			bindProfiler.task(state.uri)
		}
	}
	bindProfiler.finalize()

	const checkProfiler = projectData.profilers.get('project#check', 'top-n', 50)
	const check = async (state: FileState): Promise<void> => {
		try {
			const ctx = core.CheckerContext.create(projectData, { doc: state.doc })
			await meta.getChecker(state.node.type)(core.StateProxy.create(state.node), ctx)
			state.node.checkerErrors = ctx.err.dump()
		} catch (error) {
			if (!options.skipUnresolved) {
				diagnostics.push(runnerError(state.file, error))
			}
		} finally {
			checkProfiler.task(state.uri)
		}
	}
	const indexStates = states.filter(state => basename(state.file) === '_index.d.mcfunction')
	const regularStates = states.filter(state => basename(state.file) !== '_index.d.mcfunction')
	await core.mapLimit(indexStates, options.parallel, check)
	await core.mapLimit(regularStates, options.parallel, check)
	checkProfiler.finalize()

	const lintConfig = config.lint as unknown as Record<string, unknown>
	for (const ruleName of [ImpDocPrivateRule, ImpDocPrivateBestEffortRule]) {
		const lintValue = core.LinterConfigValue.destruct(
			lintConfig[ruleName] as Parameters<typeof core.LinterConfigValue.destruct>[0],
		)
		if (!lintValue) {
			continue
		}
		const registration = meta.getLinter(ruleName)
		if (!registration.configValidator(ruleName, lintValue.ruleValue, logger)) {
			continue
		}
		const lintProfiler = projectData.profilers.get('project#lint', 'top-n', 50)
		await core.mapLimit(states, options.parallel, async (state) => {
			try {
				const err = new core.LinterErrorReporter(
					ruleName,
					lintValue.ruleSeverity,
					projectData.ctx['errorSource'],
				)
				const ctx = core.LinterContext.create(projectData, {
					doc: state.doc,
					err,
					ruleName,
					ruleValue: lintValue.ruleValue,
				})
				core.traversePreOrder(
					state.node,
					() => true,
					registration.nodePredicate,
					(node) => registration.linter(core.StateProxy.create(node), ctx),
				)
				// Diagnostics carry the rule that produced them, so they are
				// attributed here instead of a shared post-pass over linterErrors.
				const errors = err.dump()
				state.node.linterErrors = [...state.node.linterErrors ?? [], ...errors]
				for (const error of errors) {
					diagnostics.push(toDiagnostic(state, error, ruleName))
				}
			} finally {
				lintProfiler.task(state.uri)
			}
		})
		lintProfiler.finalize()
	}

	for (const state of states) {
		if (!options.skipUnresolved) {
			for (
				const error of [
					...state.node.parserErrors,
					...state.node.binderErrors ?? [],
					...state.node.checkerErrors ?? [],
				]
			) {
				diagnostics.push(toDiagnostic(state, error, UnresolvedRule))
			}
		}
	}
	sortDiagnostics(diagnostics)

	const serializeProfiler = projectData.profilers.get(SerializeProfilerId)
	const generation = (activated?.cache.generation ?? 0) + 1
	const manifestFiles: Record<string, FileManifestEntry> = {}
	if (activated) {
		for (const [file, entry] of Object.entries(activated.cache.manifest.files)) {
			if (inputs.has(file) && !affectedFiles.has(file)) {
				// Legacy v2 entries may still carry metadata that is no longer part of
				// ExportSymbolSummary. Project retained entries onto the lean schema so
				// any cache rewrite never creates a mixed-shape manifest.
				manifestFiles[file] = {
					...entry,
					generation,
					exports: entry.exports.map(({ category, path, key, usage }) => ({
						category,
						path,
						key,
						usage,
					})),
				}
			}
		}
	}
	const exportsByUri = collectAllExports(symbols, new Set(states.map(state => state.uri)))
	const manifestProfiler = projectData.profilers.get(SerializeManifestProfilerId, 'top-n', 50)
	for (const state of states) {
		manifestFiles[state.file] = {
			generation,
			sha1: state.sha1,
			parse: {
				bytes: new TextEncoder().encode(state.content).byteLength,
				lines: state.content.split(/\r?\n/).length,
				parserErrors: state.node.parserErrors.length,
			},
			exports: exportsByUri.get(state.uri) ?? [],
			references: collectReferences(state),
			diagnostics: diagnostics.filter(diagnostic => diagnostic.file === state.file),
		}
		manifestProfiler.task(state.uri)
	}
	manifestProfiler.finalize()
	const manifest: PerFileManifest = { generation, files: manifestFiles }
	serializeProfiler.task('Build manifest / collect exports')
	const graph = createDependencyGraph(manifest)
	serializeProfiler.task('Build dependency graph')
	const result: RunResult = {
		diagnostics,
		filesScanned: normalizedFiles.length,
		filesProcessed: states.length,
		cacheHit: false,
		fullScan,
	}

	if (cachePath) {
		const checksumIntact = await checksumBarrier(normalizedFiles, inputs, options.parallel)
		serializeProfiler.task('Checksum barrier')
		if (checksumIntact) {
			const unlinkedSymbols = core.SymbolTable.unlink(symbols.global)
			serializeProfiler.task('Unlink symbol table')
			// Serialize before entering the process-local write queue, so queue waits
			// inside writeCacheAtomically are not attributed to JSON.stringify.
			const serializedCache = JSON.stringify(
				{
					version: CacheVersion,
					contextHash: activeContextHash,
					generation,
					manifest,
					graph,
					symbols: unlinkedSymbols,
					filesScanned: normalizedFiles.length,
				} satisfies ResultCache,
			)
			serializeProfiler.task('JSON.stringify')
			await writeCacheAtomically(cachePath, cacheSnapshot.token, serializedCache)
			serializeProfiler.task('Atomic cache write')
		}
	}
	serializeProfiler.finalize()
	return result
}
