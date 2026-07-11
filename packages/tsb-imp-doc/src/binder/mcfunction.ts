import * as core from '@spyglassmc/core'
import { getImpDocSymbolData } from '../node/ImpDocNode.js'
import { clearVisibility } from '../util/withinPattern.js'

interface McfunctionEntryNode extends core.AstNode {
	type: 'mcfunction:entry'
}

function getFunctionForDocument(
	ctx: core.BinderContext,
): core.Symbol | undefined {
	const functions = ctx.symbols.lookup('function', []).parentMap
	let declared: core.Symbol | undefined
	for (const symbol of Object.values(functions ?? {})) {
		if (!symbol) {
			continue
		}
		if (symbol.definition?.some(location => location.uri === ctx.doc.uri)) {
			return symbol
		}
		if (
			!declared
			&& symbol.declaration?.some(location => location.uri === ctx.doc.uri)
		) {
			declared = symbol
		}
	}
	return declared
}

/**
 * Clear stale function-header metadata before binding the current mcfunction.
 * A matching IMP-Doc child will stamp the current metadata back. If the header
 * was deleted or its ID no longer matches the URI-owned function, the symbol
 * remains public and no stale IMP-Doc metadata is retained.
 */
export const mcfunction = core.AsyncBinder.create<McfunctionEntryNode>(
	async (node, ctx) => {
		const currentFunction = getFunctionForDocument(ctx)
		if (currentFunction && getImpDocSymbolData(currentFunction.data)) {
			clearVisibility(currentFunction)
		}

		for (const child of node.children ?? []) {
			const childBinder = ctx.meta.getBinder(child.type)
			const result = childBinder(child, ctx)
			if (result instanceof Promise) {
				await result
			}
		}
	},
)
