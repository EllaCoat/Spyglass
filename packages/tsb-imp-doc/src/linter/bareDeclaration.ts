import type { AstNode, Linter, LinterContext, Logger } from '@spyglassmc/core'
import type { ImpDocDeclarationNode } from '../node/ImpDocNode.js'

export function bareDeclarationConfigValidator(
	_ruleName: string,
	value: unknown,
	logger: Logger,
): boolean {
	if (typeof value === 'boolean') {
		return value
	}
	logger.error(
		'[Invalid Linter Config] [impDocBareDeclaration] Expected a boolean value',
	)
	return false
}

/** Matches the `#declare` / `#define` directives that own no IMP-Doc block. */
export function isBareDeclaration(node: AstNode): node is ImpDocDeclarationNode {
	return node.type === 'impDoc:declaration'
		&& (node as ImpDocDeclarationNode).bare === true
}

/**
 * Reports a `#declare` / `#define` directive that owns no IMP-Doc block of its
 * own (see `ImpDocDeclarationNode.bare`).
 *
 * Such a directive is not broken — v3 registered it and so does the fork — but
 * its visibility silently differs from what the surrounding text suggests: the
 * enclosing function header's `@private` / `@within` applies to the function,
 * never to a directive outside a `#>` block, so the symbol ends up public.
 * Writing the directive inside its own block is the norm (one exception across
 * the whole TSB Core corpus, none in Asset), so this stays an opt-in rule
 * rather than a parser diagnostic.
 */
export const bareDeclaration: Linter<AstNode> = (node, ctx: LinterContext) => {
	// `nodePredicate` already filtered the traversal; re-checking here keeps the
	// declaration fields typed and the linter safe to call directly in tests.
	if (!isBareDeclaration(node)) {
		return
	}
	ctx.err.lint(
		`Declaration of ${node.category} “${node.name.raw}” owns no IMP-Doc block, so no “@public” / “@private” / “@within” annotation applies to it and the symbol is declared public; move it under a “#>” block of its own to scope it`,
		node.name.range,
	)
}
