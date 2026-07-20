import type { AstNode, Symbol, SymbolUtil } from '@spyglassmc/core'
import { ResourceLocation } from '@spyglassmc/core'
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
