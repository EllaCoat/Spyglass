import { localeQuote, localize } from '@spyglassmc/locales'
import type { AstNode } from '../../../node/index.js'
import { Range } from '../../../source/index.js'
import type { Linter } from '../Linter.js'

/**
 * A structural view of `NbtByteNode`. `@spyglassmc/nbt` depends on core, so neither the node type
 * nor the mcdoc type definition attached to it by the NBT checker can be imported here.
 */
interface ByteNode extends AstNode {
	value: number
	typeDef?: { kind?: string }
}

/**
 * `true` and `false` are parsed into byte nodes without any trace of the notation that was used,
 * so the raw source has to be consulted.
 */
const BooleanLiteralPattern = /^(?:true|false)$/i

/**
 * Reports byte tags that do not use the notation asked for by the rule value: the `true` and
 * `false` literals when it is `true`, and the `1b` and `0b` bytes when it is `false`.
 *
 * The literal notation is only asked for where mcdoc says a boolean is expected. Bytes without a
 * type definition are left alone, as `1b` cannot be replaced with `true` in a numeric position.
 */
export const nbtBoolean: Linter<ByteNode> = (node, ctx) => {
	const raw = ctx.src.slice(node.range.start, node.range.end)
	const isLiteral = BooleanLiteralPattern.test(raw)

	if (ctx.ruleValue === false) {
		if (!isLiteral) {
			return
		}
		ctx.err.lint(
			localize('expected-got', localize('nbt.node.byte'), localeQuote(raw)),
			node,
			{
				codeAction: {
					title: localize('code-action.nbt-type-to-byte'),
					isPreferred: true,
					changes: [
						{
							type: 'edit',
							range: Range.get(node.range),
							text: node.value === 0 ? '0b' : '1b',
						},
					],
				},
			},
		)
		return
	}

	if (isLiteral || node.typeDef?.kind !== 'boolean') {
		return
	}
	const literal = node.value === 0 ? 'false' : 'true'
	ctx.err.lint(localize('expected', literal), node, {
		codeAction: {
			title: localize('code-action.nbt-byte-to-literal'),
			isPreferred: true,
			changes: [{ type: 'edit', range: Range.get(node.range), text: literal }],
		},
	})
}
