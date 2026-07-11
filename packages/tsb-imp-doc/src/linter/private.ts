import type { AstNode, Linter, LinterContext, Logger, StateProxy } from '@spyglassmc/core'
import { ResourceLocationNode } from '@spyglassmc/core'
import type { ImpDocNode } from '../node/ImpDocNode.js'
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

function getRoot(node: AstNode): AstNode {
	let root = node
	while (root.parent) {
		root = root.parent
	}
	return root
}

export const privateVisibility: Linter<AstNode> = (rawNode, ctx: LinterContext) => {
	if (rawNode.type !== 'impDoc') {
		return
	}
	const node = rawNode as StateProxy<ImpDocNode>
	const caller = node.symbol?.identifier ?? node.functionID?.raw
	if (!caller) {
		return
	}

	visit(getRoot(node), (candidate) => {
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
