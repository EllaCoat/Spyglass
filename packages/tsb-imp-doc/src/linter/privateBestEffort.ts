import type { AstNode, Linter, LinterContext, Logger, StateProxy } from '@spyglassmc/core'
import { ResourceLocationNode } from '@spyglassmc/core'
import { getImpDocSymbolData, getRefProvenance } from '../node/ImpDocNode.js'
import { describeVisibilityScope, findVisibilityViolation, getCaller } from './private.js'

export function bestEffortConfigValidator(
	_ruleName: string,
	value: unknown,
	logger: Logger,
): boolean {
	if (typeof value === 'boolean') {
		return value
	}
	logger.error(
		'[Invalid Linter Config] [impDocPrivateBestEffort] Expected a boolean value',
	)
	return false
}

function visit(node: AstNode, fn: (node: AstNode) => void): void {
	fn(node)
	for (const child of node.children ?? []) {
		visit(child, fn)
	}
}

/**
 * Warning-level counterpart of `impDocPrivate` for references whose runtime
 * semantics cannot be fully resolved statically (provenance-tagged macro-line
 * and quoted-string references, see `ImpDocRefProvenance`). Provenance tagging
 * stays scoped to function references extracted from macro / NBT contexts
 * (P4-2c policy). On top of the strict rule's visibility union check (v3
 * parity, any-match) it also flags targets without any declaration or
 * definition, because such references never surface through the
 * resolved-symbol diagnostics.
 */
export const privateBestEffortVisibility: Linter<AstNode> = (node, ctx: LinterContext) => {
	const caller = getCaller(ctx, node)

	visit(node as StateProxy<AstNode>, (candidate) => {
		if (!ResourceLocationNode.is(candidate) || candidate.options.category !== 'function') {
			return
		}
		const provenance = getRefProvenance(candidate)
		// `dynamic-pattern` never carries a resolvable target; the scanner that
		// tagged it is responsible for its own diagnostic.
		if (provenance === undefined || provenance === 'dynamic-pattern') {
			return
		}
		const origin = provenance === 'macro' ? 'a macro line' : 'a quoted string'
		const target = ResourceLocationNode.toString(candidate, 'full')
		const symbol = candidate.symbol

		// Tag references are exempt from the existence check: the CLI symbol
		// table never contains function-tag declarations, so their absence
		// carries no signal.
		if (
			!candidate.isTag
			&& !symbol?.declaration?.length
			&& !symbol?.definition?.length
		) {
			ctx.err.lint(
				`Function “${target}” is referenced in ${origin} but is not declared anywhere`,
				candidate,
			)
			return
		}
		if (!caller) {
			return
		}

		const visibility = findVisibilityViolation(
			getImpDocSymbolData(symbol?.data),
			caller,
		)
		if (!visibility) {
			return
		}

		const scope = describeVisibilityScope(visibility)
		ctx.err.lint(
			`Function “${target}” is ${scope} and cannot be called from “${caller.resourceID}” (referenced in ${origin})`,
			candidate,
		)
	})
}
