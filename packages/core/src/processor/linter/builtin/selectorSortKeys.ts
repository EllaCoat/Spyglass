import { localize } from '@spyglassmc/locales'
import type { StateProxy } from '../../../common/index.js'
import type { AstNode, RecordBaseNode, StringBaseNode } from '../../../node/index.js'
import type { LinterContext } from '../../../service/index.js'
import type { LanguageErrorInfo } from '../../../source/index.js'
import { Range } from '../../../source/index.js'
import type { Linter } from '../Linter.js'

type ArgumentsNode = RecordBaseNode<StringBaseNode, AstNode>

/**
 * Reports entity selector arguments whose keys do not follow the order given by the rule value.
 *
 * Keys that are absent from the rule value neither break the order nor take part in it. The quick
 * fix moves them to the end of the selector while keeping their relative order, which guarantees
 * that applying the fix silences the diagnostic.
 */
export const selectorSortKeys: Linter<ArgumentsNode> = (node, ctx) => {
	const expectedOrder = ctx.ruleValue as string[]
	const pairs = node.children
	const ranks = pairs.map((pair) => (pair.key ? expectedOrder.indexOf(pair.key.value) : -1))

	let lastRank = -1
	for (const rank of ranks) {
		if (rank === -1) {
			continue
		}
		if (rank < lastRank) {
			const info: LanguageErrorInfo = {}
			if (node.innerRange) {
				info.codeAction = {
					title: localize('code-action.selector-sort-keys'),
					isPreferred: true,
					changes: [
						{
							type: 'edit',
							range: Range.get(node.innerRange),
							text: sort(pairs, ranks, ctx),
						},
					],
				}
			}
			ctx.err.lint(localize('unsorted-keys'), node, info)
			return
		}
		lastRank = rank
	}
}

function sort(
	pairs: StateProxy<ArgumentsNode>['children'],
	ranks: number[],
	ctx: LinterContext,
): string {
	return ranks
		.map((rank, index) => ({ index, rank: rank === -1 ? Number.MAX_SAFE_INTEGER : rank }))
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.map(({ index }) => {
			const pair = pairs[index]
			// A pair's range covers its trailing separator, which is re-added by the join below.
			return ctx.src.slice(pair.range.start, pair.end?.start ?? pair.range.end)
		})
		.join(',')
}
