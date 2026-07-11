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

function getCaller(ctx: LinterContext): string | undefined {
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
		const scope = visibility.type === 'private'
			? `private to “${visibility.owner}”`
			: `restricted by “${visibility.owner}”`

		ctx.err.lint(
			`Function “${target}” is ${scope} and cannot be called from “${caller}”`,
			candidate,
		)
	})
}
