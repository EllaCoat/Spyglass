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
		return indexed.filter(
			symbol => symbol.category === 'function' && symbol.path.length === 1,
		)
	}

	return Object.values(ctx.symbols.lookup('function', []).parentMap ?? {})
		.filter((symbol): symbol is Symbol => symbol !== undefined)
}

/**
 * Select a match in the function symbol map's insertion order. This preserves
 * the legacy fallback for headerless documents while keeping indexed and full
 * scan lookups consistent.
 */
function selectInSymbolMapOrder(
	ctx: DocumentFunctionContext,
	matches: readonly Symbol[],
): Symbol | undefined {
	if (matches.length <= 1) {
		return matches[0]
	}
	const identifiers = new Set(matches.map(symbol => symbol.identifier))
	for (const symbol of Object.values(ctx.symbols.lookup('function', []).parentMap ?? {})) {
		if (symbol && identifiers.has(symbol.identifier)) {
			return symbol
		}
	}
	return matches[0]
}

/**
 * Resolves the function defined by a document. Definition locations retain
 * priority for the language-server path. The CLI only contributes declaration
 * locations, so its parsed IMP-Doc function header (or persisted `headerUri`)
 * distinguishes the document function from caller-local `#declare` symbols.
 */
export function getDocumentFunction(
	ctx: DocumentFunctionContext,
	node?: AstNode,
): Symbol | undefined {
	const uri = ctx.doc.uri
	const headerFunctionId = getDocumentHeaderFunctionId(node)
	const definitions: Symbol[] = []
	const headerMatches: Symbol[] = []
	const trackedHeaderMatches: Symbol[] = []
	const declarations: Symbol[] = []

	for (const symbol of getFunctionSymbols(ctx)) {
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

	return selectInSymbolMapOrder(ctx, definitions)
		?? selectInSymbolMapOrder(ctx, headerMatches)
		?? selectInSymbolMapOrder(ctx, trackedHeaderMatches)
		?? selectInSymbolMapOrder(ctx, declarations)
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
