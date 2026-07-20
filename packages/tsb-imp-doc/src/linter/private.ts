import type { AstNode, Linter, LinterContext, Logger, StateProxy } from '@spyglassmc/core'
import { ResourceLocationNode } from '@spyglassmc/core'
import type { ImpDocVisibility } from '../node/ImpDocNode.js'
import { getImpDocSymbolData, getRefProvenance } from '../node/ImpDocNode.js'
import { getDocumentFunction } from '../util/documentFunction.js'
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

/** Resolves the calling function of `ctx.doc`. Shared with the best-effort rule. */
export function getCaller(ctx: LinterContext, node?: AstNode): string | undefined {
	return getDocumentFunction(ctx, node)?.identifier
}

export const privateVisibility: Linter<AstNode> = (node, ctx: LinterContext) => {
	const caller = getCaller(ctx, node)
	if (!caller) {
		return
	}

	visit(node as StateProxy<AstNode>, (candidate) => {
		if (!ResourceLocationNode.is(candidate) || candidate.options.category !== 'function') {
			return
		}
		// Best-effort provenance (macro line / quoted string) hands the
		// reference over to the warning-level impDocPrivateBestEffort rule.
		if (getRefProvenance(candidate) !== undefined) {
			return
		}
		const data = getImpDocSymbolData(candidate.symbol?.data)
		const entries = getVisibilityEntries(data)

		// metadata 無しは defensive に許可。 v3 union parity: definition /
		// declaration のどれか 1 entry でも caller を許可すれば OK (any-match)。
		if (
			entries.length === 0
			|| entries.some(entry => matchesVisibility(entry, caller, 'function'))
		) {
			return
		}
		// public entry は any-match で必ず許可済みなので、 ここに残る entry は
		// 全て restricted。 message には entries 順 (= definition 優先、 次いで
		// (uri, range) 昇順) の先頭を代表として使う。
		const visibility = entries.find(
			(entry): entry is Exclude<ImpDocVisibility, { type: 'public' }> => entry.type !== 'public',
		)
		if (!visibility) {
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
