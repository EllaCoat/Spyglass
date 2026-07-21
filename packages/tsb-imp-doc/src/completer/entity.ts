import * as core from '@spyglassmc/core'
import { dedupeCompletionItems, getAllowedImpDocIdentifiers } from './visibility.js'

/** java-edition の `EntityNode` を production dependency 追加なしに扱う最小型。 */
interface EntityCompletionNode extends core.AstNode {
	readonly type: 'mcfunction:entity'
	readonly playerName?: core.StringNode
	readonly selector?: core.AstNode
	readonly uuid?: core.AstNode
}

function getEntityNameItems(
	range: core.RangeLike,
	node: core.DeepReadonly<core.AstNode>,
	ctx: core.CompleterContext,
): core.CompletionItem[] {
	return getAllowedImpDocIdentifiers('entity', node, ctx).map(identifier =>
		core.CompletionItem.create(identifier, range, {
			kind: core.CompletionKind.Variable,
		})
	)
}

/**
 * `mcfunction:entity` の completer。 java-edition は base completer を登録しない
 * (= core fallback が子 node へ降りるだけ) ため、 ここで登録すると dispatch が
 * この node で停止する。 元の挙動 (子 node への委譲) を保ちつつ、 plain name 位置
 * では `#declare entity` 済みの名前を候補に載せる (v3 `EntityArgumentParser.ts:60`
 * parity、 spike 1 判断 B)。
 */
const entity: core.Completer<EntityCompletionNode> = (node, ctx) => {
	const child = node.children?.[0]
	const baseItems = child ? core.completer.dispatch(child, ctx) : []
	if (!node.playerName) {
		return baseItems
	}
	return dedupeCompletionItems([
		...baseItems,
		...getEntityNameItems(node.playerName, node, ctx),
	])
}

/**
 * Language Server 経路 (= je.initialize 後) で呼ぶ。 部分入力は
 * `mcfunction:entity` の新規登録で、 0 文字位置は `mcfunction:entity_selector`
 * mock の wrap で、 それぞれ宣言済み entity name を候補に追加する。
 */
export function registerEntityCompleters(meta: core.MetaRegistry): void {
	if (!meta.hasCompleter<core.AstNode>('mcfunction:entity_selector')) {
		throw new Error(
			'[tsb-imp-doc] Java Edition completers must be registered before '
				+ 'tsb-imp-doc entity completion wrapping (= run je.initialize first)',
		)
	}

	meta.registerCompleter<EntityCompletionNode>('mcfunction:entity', entity)

	const baseSelector = meta.getCompleter<core.AstNode>('mcfunction:entity_selector')
	meta.registerCompleter<core.AstNode>(
		'mcfunction:entity_selector',
		(node, ctx) => {
			const baseItems = baseSelector(node, ctx)
			// mock (= 空 range) 以外 = `@` 入力済みの real selector には名前を出さない。
			if (core.Range.length(node.range) !== 0) {
				return baseItems
			}
			return dedupeCompletionItems([
				...baseItems,
				...getEntityNameItems(node.range, node, ctx),
			])
		},
	)
}
