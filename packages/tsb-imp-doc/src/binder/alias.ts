import * as core from '@spyglassmc/core'
import type { ImpDocAliasNode } from '../node/ImpDocNode.js'

/** Register a lossless legacy alias and its serializable expansion payload. */
export const bindAlias = core.SyncBinder.create<ImpDocAliasNode>((node, ctx) => {
	const query = ctx.symbols.query(
		ctx.doc,
		`alias/${node.kind}`,
		node.name.raw,
	).enter({
		usage: {
			type: 'declaration',
			range: node.name.range,
		},
		data: {
			data: {
				impDoc: {
					alias: {
						kind: node.kind,
						expansion: node.value.raw,
					},
				},
			},
		},
	})

	node.symbol = query.symbol
})
