import * as core from '@spyglassmc/core'
import { getImpDocSymbolData } from '../node/ImpDocNode.js'
import { dedupeCompletionItems } from './visibility.js'

/** java-edition の argument node を production dependency 追加なしに扱う最小型。 */
interface EntitySelectorCompletionNode extends core.AstNode {
	readonly type: 'mcfunction:entity_selector'
	readonly completionOrigin?: 'minecraft:entity' | 'minecraft:game_profile'
}

interface VectorCompletionNode extends core.AstNode {
	readonly type: 'mcfunction:vector'
	readonly completionOrigin?: 'minecraft:vec3'
	readonly options: {
		readonly dimension: 2 | 3
		readonly integersOnly?: boolean
		readonly noLocal?: boolean
	}
}

interface UuidCompletionNode extends core.AstNode {
	readonly type: 'mcfunction:uuid'
	readonly completionOrigin?: 'minecraft:uuid'
}

/**
 * `alias/<kind>` symbol table から snippet 候補を生成する。 v3 parity
 * (`CommandParser.ts:138-157`): label = alias 名、 insert = expansion 展開値。
 * expansion は LSP 側で常に snippet 扱いされる (`toLS.ts` の
 * `InsertTextFormat.Snippet`) ため TextMate escape してから載せる。
 */
export function getAliasCompletionItems(
	kind: 'entity' | 'uuid' | 'vector',
	range: core.RangeLike,
	ctx: core.CompleterContext,
): core.CompletionItem[] {
	const rawMap = ctx.symbols.lookup(`alias/${kind}`, []).parentMap
	const ans: core.CompletionItem[] = []

	for (const [identifier, symbol] of Object.entries(rawMap ?? {})) {
		if (!symbol || !core.SymbolUtil.isDeclared(symbol)) {
			continue
		}
		const expansion = getImpDocSymbolData(symbol.data)?.alias?.expansion
		if (!expansion) {
			continue
		}
		ans.push(
			core.CompletionItem.create(identifier, range, {
				kind: core.CompletionKind.Snippet,
				detail: expansion,
				insertText: core.CompletionItem.escape(expansion),
			}),
		)
	}

	return ans
}

/**
 * alias 候補は「parser が 0 文字消費した位置」 だけに出す (v3 parity)。 mcfunction
 * completer の外側 argument mock は `ctx.offset` の空 range と parser identity
 * (`completionOrigin`) を持つ。 両方を要求し、 particle 内部や MCDoc attribute が
 * 同じ汎用 node type を mock する経路から alias を隔離する。
 */
function isUntypedPosition(node: core.DeepReadonly<core.AstNode>): boolean {
	return core.Range.length(node.range) === 0
}

/**
 * Language Server 経路 (= je.initialize 後) で呼ぶ。
 * - `alias/entity` = `minecraft:entity` / `minecraft:game_profile` の 0 文字位置で
 *   dispatch される `mcfunction:entity_selector` mock を wrap
 * - `alias/vector` = `mcfunction:vector` mock を wrap し、 `dimension === 3 &&
 *   !integersOnly` で vec3 だけに限定 (vec2 / block_pos / rotation を除外)
 * - `alias/uuid` = java-edition が `UuidNode.mock` を返すが base completer は
 *   未登録のため、 ここで新規登録する (非導入時は core dispatch の `hasCompleter`
 *   predicate で候補ゼロのまま = regression なし)
 */
export function registerAliasCompleters(meta: core.MetaRegistry): void {
	if (
		!meta.hasCompleter<EntitySelectorCompletionNode>('mcfunction:entity_selector')
		|| !meta.hasCompleter<VectorCompletionNode>('mcfunction:vector')
	) {
		throw new Error(
			'[tsb-imp-doc] Java Edition completers must be registered before '
				+ 'tsb-imp-doc alias completion wrapping (= run je.initialize first)',
		)
	}

	const baseSelector = meta.getCompleter<EntitySelectorCompletionNode>(
		'mcfunction:entity_selector',
	)
	meta.registerCompleter<EntitySelectorCompletionNode>(
		'mcfunction:entity_selector',
		(node, ctx) => {
			const baseItems = baseSelector(node, ctx)
			if (
				!isUntypedPosition(node)
				|| (node.completionOrigin !== 'minecraft:entity'
					&& node.completionOrigin !== 'minecraft:game_profile')
			) {
				return baseItems
			}
			return dedupeCompletionItems([
				...baseItems,
				...getAliasCompletionItems('entity', node.range, ctx),
			])
		},
	)

	const baseVector = meta.getCompleter<VectorCompletionNode>('mcfunction:vector')
	meta.registerCompleter<VectorCompletionNode>(
		'mcfunction:vector',
		(node, ctx) => {
			const baseItems = baseVector(node, ctx)
			if (
				!isUntypedPosition(node)
				|| node.completionOrigin !== 'minecraft:vec3'
				|| node.options.dimension !== 3
				|| node.options.integersOnly
			) {
				return baseItems
			}
			return dedupeCompletionItems([
				...baseItems,
				...getAliasCompletionItems('vector', node.range, ctx),
			])
		},
	)

	meta.registerCompleter<UuidCompletionNode>(
		'mcfunction:uuid',
		(node, ctx) => {
			if (
				!isUntypedPosition(node)
				|| node.completionOrigin !== 'minecraft:uuid'
			) {
				return []
			}
			return getAliasCompletionItems('uuid', node.range, ctx)
		},
	)
}
