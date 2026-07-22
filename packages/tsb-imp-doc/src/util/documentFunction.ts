import type { AstNode, Symbol, SymbolUtil } from '@spyglassmc/core'
import { ResourceLocation } from '@spyglassmc/core'
import type { LegacyFileTypeId } from '../legacy/categories.js'
import { isLegacyFileType } from '../legacy/categories.js'
import { getImpDocSymbolData, ImpDocNode } from '../node/ImpDocNode.js'

interface DocumentFunctionContext {
	doc: { uri: string }
	symbols: SymbolUtil
}

function getDocumentHeaderFunctionId(node: AstNode | undefined): string | undefined {
	if (!node) {
		return undefined
	}

	let root = node
	while (root.parent) {
		root = root.parent
	}

	const pending = [root]
	while (pending.length > 0) {
		const candidate = pending.pop()!
		if (ImpDocNode.is(candidate) && candidate.functionID?.raw) {
			return ResourceLocation.lengthen(candidate.functionID.raw)
		}
		pending.push(...[...(candidate.children ?? [])].reverse())
	}
	return undefined
}

function getFunctionSymbols(ctx: DocumentFunctionContext): Symbol[] {
	const indexed = ctx.symbols.getSymbolCandidatesAtUri(ctx.doc.uri)
	if (indexed.length > 0) {
		return filterFunctionSymbols(indexed)
	}

	return Object.values(ctx.symbols.lookup('function', []).parentMap ?? {})
		.filter((symbol): symbol is Symbol => symbol !== undefined)
}

function filterFunctionSymbols(symbols: readonly Symbol[]): Symbol[] {
	return symbols.filter(
		symbol => symbol.category === 'function' && symbol.path.length === 1,
	)
}

/**
 * Selects the first non-empty priority tier only when it identifies exactly
 * one function. An ambiguous higher-priority tier stops resolution instead of
 * guessing by insertion order or falling through to a weaker signal.
 */
function selectUnambiguousFunctionTier(
	tiers: readonly (readonly Symbol[])[],
): Symbol | undefined {
	for (const matches of tiers) {
		if (matches.length > 0) {
			return matches.length === 1 ? matches[0] : undefined
		}
	}
	return undefined
}

/**
 * Resolves the function defined by a document. Definition locations retain
 * priority for the language-server path. The CLI only contributes declaration
 * locations, so its parsed IMP-Doc function header (or persisted `headerUri`)
 * distinguishes the document function from caller-local `#declare` symbols.
 * Multiple candidates in the first applicable priority tier fail closed.
 */
function selectDocumentFunction(
	ctx: DocumentFunctionContext,
	node: AstNode | undefined,
	functionSymbols: readonly Symbol[],
): Symbol | undefined {
	const uri = ctx.doc.uri
	const headerFunctionId = getDocumentHeaderFunctionId(node)
	const definitions: Symbol[] = []
	const headerMatches: Symbol[] = []
	const trackedHeaderMatches: Symbol[] = []
	const declarations: Symbol[] = []

	for (const symbol of functionSymbols) {
		if (symbol.definition?.some(location => location.uri === uri)) {
			definitions.push(symbol)
		}
		if (!symbol.declaration?.some(location => location.uri === uri)) {
			continue
		}
		declarations.push(symbol)
		if (symbol.identifier === headerFunctionId) {
			headerMatches.push(symbol)
		}
		if (getImpDocSymbolData(symbol.data)?.headerUri === uri) {
			trackedHeaderMatches.push(symbol)
		}
	}

	return selectUnambiguousFunctionTier([
		definitions,
		headerMatches,
		trackedHeaderMatches,
		declarations,
	])
}

/**
 * Resolves the document function strictly through the URI reverse index. An
 * unindexed client-managed / synthetic document returns immediately instead
 * of falling back to a workspace-wide function symbol scan.
 */
export function getDocumentFunctionFromUri(
	ctx: DocumentFunctionContext,
	node?: AstNode,
): Symbol | undefined {
	const candidates = filterFunctionSymbols(
		ctx.symbols.getSymbolCandidatesAtUri(ctx.doc.uri),
	)
	if (candidates.length === 0) {
		return undefined
	}
	return selectDocumentFunction(ctx, node, candidates)
}

/**
 * Full document-function resolution, including the legacy global fallback
 * required by unindexed declaration-only CLI symbol tables.
 */
export function getDocumentFunction(
	ctx: DocumentFunctionContext,
	node?: AstNode,
): Symbol | undefined {
	return selectDocumentFunction(ctx, node, getFunctionSymbols(ctx))
}

/**
 * The resource a document represents, generalized over v3's caller notion of
 * the current document's `{fileType, resourceID}`. `fileType` is always one of
 * the 47 legacy file types and doubles as the `@within` caller type.
 */
export interface DocumentResource {
	readonly fileType: LegacyFileTypeId
	readonly resourceID: string
}

/** All candidates must agree on one resource; ambiguity fails closed. */
function selectUnambiguousResource(
	candidates: readonly DocumentResource[],
): DocumentResource | undefined {
	const first = candidates[0]
	if (!first) {
		return undefined
	}
	const ambiguous = candidates.some(candidate =>
		candidate.fileType !== first.fileType
		|| candidate.resourceID !== first.resourceID
	)
	return ambiguous ? undefined : first
}

/**
 * Resolves the resource defined by a document. Function documents keep the
 * full {@link getDocumentFunction} priority chain (CLI compatibility included);
 * any other document resolves through the URI reverse index to the non-function
 * legacy file-type symbol bound at this URI (JSON / worldgen / tag files).
 * Definitions take priority over declarations; a document that resolves to
 * several distinct resources fails closed instead of guessing.
 */
export function getDocumentResource(
	ctx: DocumentFunctionContext,
	node?: AstNode,
): DocumentResource | undefined {
	const functionSymbol = getDocumentFunction(ctx, node)
	if (functionSymbol) {
		return { fileType: 'function', resourceID: functionSymbol.identifier }
	}

	const uri = ctx.doc.uri
	const definitions: DocumentResource[] = []
	const declarations: DocumentResource[] = []
	for (const symbol of ctx.symbols.getSymbolCandidatesAtUri(uri)) {
		if (
			symbol.category === 'function'
			|| symbol.path.length !== 1
			|| !isLegacyFileType(symbol.category)
		) {
			continue
		}
		if (symbol.definition?.some(location => location.uri === uri)) {
			definitions.push({ fileType: symbol.category, resourceID: symbol.identifier })
		} else if (symbol.declaration?.some(location => location.uri === uri)) {
			declarations.push({ fileType: symbol.category, resourceID: symbol.identifier })
		}
	}
	return definitions.length > 0
		? selectUnambiguousResource(definitions)
		: selectUnambiguousResource(declarations)
}
