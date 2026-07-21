import type { AstNode, Linter, LinterContext, Logger, StateProxy, Symbol } from '@spyglassmc/core'
import { ResourceLocationNode } from '@spyglassmc/core'
import type { ImpDocSymbolData, ImpDocVisibility } from '../node/ImpDocNode.js'
import { getImpDocSymbolData, getRefProvenance } from '../node/ImpDocNode.js'
import type { DocumentResource } from '../util/documentFunction.js'
import { getDocumentResource } from '../util/documentFunction.js'
import { getVisibilityEntries, matchesVisibility } from '../util/withinPattern.js'

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

/** Resolves the calling resource of `ctx.doc`. Shared with the best-effort rule. */
export function getCaller(
	ctx: LinterContext,
	node?: AstNode,
): DocumentResource | undefined {
	return getDocumentResource(ctx, node)
}

/**
 * v3 union parity: metadata-free symbols are defensively allowed, and any
 * single definition / declaration entry admitting the caller allows the
 * reference (any-match). Returns the representative restricted entry
 * otherwise: entries are ordered definition first, then (uri, range)
 * ascending, and every public entry has already admitted the caller.
 */
export function findVisibilityViolation(
	data: ImpDocSymbolData | undefined,
	caller: DocumentResource,
): Exclude<ImpDocVisibility, { type: 'public' }> | undefined {
	const entries = getVisibilityEntries(data)
	if (
		entries.length === 0
		|| entries.some(entry => matchesVisibility(entry, caller.resourceID, caller.fileType))
	) {
		return undefined
	}
	return entries.find(
		(entry): entry is Exclude<ImpDocVisibility, { type: 'public' }> => entry.type !== 'public',
	)
}

/** Human-readable scope clause shared by the strict and best-effort rules. */
export function describeVisibilityScope(
	visibility: Exclude<ImpDocVisibility, { type: 'public' }>,
): string {
	return visibility.type === 'private' || visibility.type === 'denied'
		? `private to “${visibility.owner}”`
		: visibility.type === 'internal'
		? `internal to the namespace of “${visibility.owner}”`
		: `restricted by “${visibility.owner}”`
}

interface UsageOptionsNode extends AstNode {
	options?: { usageType?: string }
}

/**
 * Only reference usages are linted: declaration / definition sites carry the
 * same bound symbol but must not be reported against themselves. Parser nodes
 * with options default to `reference`, so only an explicit non-reference usage
 * type disqualifies them. Metadata-free nodes are ambiguous and fall back to
 * an exact URI-and-range match in the symbol's reference locations.
 */
function isReferenceUsage(node: AstNode, uri: string): boolean {
	const options = (node as UsageOptionsNode).options
	if (options !== undefined) {
		return options.usageType === undefined || options.usageType === 'reference'
	}
	return node.symbol?.reference?.some(location => {
		const range = location.range
		return location.uri === uri
			&& range !== undefined
			&& range.start === node.range.start
			&& range.end === node.range.end
	}) ?? false
}

function describeTarget(node: AstNode, symbol: Symbol): string {
	return ResourceLocationNode.is(node)
		? ResourceLocationNode.toString(node, 'full')
		: symbol.identifier
}

export const privateVisibility: Linter<AstNode> = (node, ctx: LinterContext) => {
	const caller = getCaller(ctx, node)
	if (!caller) {
		return
	}

	visit(node as StateProxy<AstNode>, (candidate) => {
		// symbol 無しの node が大半なので存在 check を先頭に置き定数コストで抜ける。
		const symbol = candidate.symbol
		if (!symbol) {
			return
		}
		// Legacy entity references are soft navigation links only. v3 did not run
		// strict visibility lint for this plugin-local category.
		if (symbol.category === 'entity') {
			return
		}
		// Best-effort provenance (macro line / quoted string) hands the
		// reference over to the warning-level impDocPrivateBestEffort rule.
		if (getRefProvenance(candidate) !== undefined) {
			return
		}
		if (!isReferenceUsage(candidate, ctx.doc.uri)) {
			return
		}
		const visibility = findVisibilityViolation(
			getImpDocSymbolData(symbol.data),
			caller,
		)
		if (!visibility) {
			return
		}

		const target = describeTarget(candidate, symbol)
		const scope = describeVisibilityScope(visibility)
		ctx.err.lint(
			symbol.category === 'function'
				? `Function “${target}” is ${scope} and cannot be called from “${caller.resourceID}”`
				: `Symbol “${target}” in category “${symbol.category}” is ${scope} and cannot be referenced from “${caller.resourceID}”`,
			candidate,
		)
	})
}
