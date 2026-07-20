import * as core from '@spyglassmc/core'
import { getImpDocSymbolData } from '../node/ImpDocNode.js'
import { getDocumentFunction } from '../util/documentFunction.js'
import { clearVisibility } from '../util/withinPattern.js'
import { clearContract } from './contract.js'

interface McfunctionEntryNode extends core.AstNode {
	type: 'mcfunction:entry'
}

/**
 * Clear stale function-header metadata before binding the current mcfunction.
 * A matching IMP-Doc child will stamp the current metadata back. If the header
 * was deleted or its ID no longer matches the URI-owned function, the symbol
 * remains public and no stale IMP-Doc metadata is retained.
 */
export const mcfunction = core.AsyncBinder.create<McfunctionEntryNode>(
	async (node, ctx) => {
		const currentFunction = getDocumentFunction(ctx, node)
		if (currentFunction && getImpDocSymbolData(currentFunction.data)) {
			clearVisibility(currentFunction)
			clearContract(currentFunction)
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
