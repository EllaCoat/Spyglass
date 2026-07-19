import type { AstNode, Linter, LinterContext, Logger, StateProxy } from '@spyglassmc/core'
import { ResourceLocationNode } from '@spyglassmc/core'
import { getImpDocSymbolData } from '../node/ImpDocNode.js'
import { matchesVisibility } from '../util/withinPattern.js'

export function configValidator(_ruleName: string, value: unknown, logger: Logger): boolean {
	if (typeof value === 'boolean') {
		return value
	}
	logger.error('[Invalid Linter Config] [impDocPrivate] Expected a boolean value')
	return false
}

function visit(node: AstNode, fn: (node: AstNode) => void): void {
	fn(node)
	for (const child of node.children ?? []) {
		visit(child, fn)
	}
}

/**
 * Legacy full scan over every function symbol in the global table. Kept as a
 * safety net for symbol tables whose reverse URI cache has not been built
 * (e.g. `SymbolUtil.buildCache()` was never called); `getCaller` only falls
 * back to it when the index returns no candidate at all.
 */
function getCallerByFullScan(ctx: LinterContext): string | undefined {
	const functions = ctx.symbols.lookup('function', []).parentMap
	let declaration: string | undefined
	for (const symbol of Object.values(functions ?? {})) {
		if (!symbol) {
			continue
		}
		if (symbol.definition?.some(location => location.uri === ctx.doc.uri)) {
			return symbol.identifier
		}
		if (
			declaration === undefined
			&& symbol.declaration?.some(location => location.uri === ctx.doc.uri)
		) {
			declaration = symbol.identifier
		}
	}
	return declaration
}

function getCaller(ctx: LinterContext): string | undefined {
	const candidates = ctx.symbols.getSymbolCandidatesAtUri(ctx.doc.uri)
	if (candidates.length === 0) {
		return getCallerByFullScan(ctx)
	}
	// The candidates are a superset (stale entries are not filtered out by the
	// index), so every location must be re-verified against the document URI.
	const definitions = new Set<string>()
	const declarations = new Set<string>()
	for (const symbol of candidates) {
		if (symbol.category !== 'function' || symbol.path.length !== 1) {
			continue
		}
		if (symbol.definition?.some(location => location.uri === ctx.doc.uri)) {
			definitions.add(symbol.identifier)
		} else if (symbol.declaration?.some(location => location.uri === ctx.doc.uri)) {
			declarations.add(symbol.identifier)
		}
	}
	const matches = definitions.size > 0 ? definitions : declarations
	if (matches.size === 0) {
		return undefined
	}
	if (matches.size === 1) {
		return matches.values().next().value
	}
	// Multiple functions match this URI: reproduce the legacy semantics, which
	// returned the first match in the function symbol map's insertion order.
	// The index's own order follows location entry, not map insertion.
	const functions = ctx.symbols.lookup('function', []).parentMap
	for (const identifier of Object.keys(functions ?? {})) {
		if (matches.has(identifier)) {
			return identifier
		}
	}
	return matches.values().next().value
}

export const privateVisibility: Linter<AstNode> = (node, ctx: LinterContext) => {
	const caller = getCaller(ctx)
	if (!caller) {
		return
	}

	visit(node as StateProxy<AstNode>, (candidate) => {
		if (!ResourceLocationNode.is(candidate) || candidate.options.category !== 'function') {
			return
		}
		const data = getImpDocSymbolData(candidate.symbol?.data)
		const visibility = data?.visibility

		// metadata 無し / public は defensive に許可。
		if (!visibility || matchesVisibility(visibility, caller, 'function')) {
			return
		}
		// matchesVisibility が public を先に許可済みだが、 TypeScript の
		// narrowing が効かないため defensive check。
		if (visibility.type === 'public') {
			return
		}

		const target = ResourceLocationNode.toString(candidate, 'full')
		const scope = visibility.type === 'private' || visibility.type === 'denied'
			? `private to “${visibility.owner}”`
			: visibility.type === 'internal'
			? `internal to the namespace of “${visibility.owner}”`
			: `restricted by “${visibility.owner}”`

		ctx.err.lint(
			`Function “${target}” is ${scope} and cannot be called from “${caller}”`,
			candidate,
		)
	})
}
