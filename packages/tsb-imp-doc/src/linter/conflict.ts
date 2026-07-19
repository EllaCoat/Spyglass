import type { AstNode, Linter, LinterContext, Logger, StateProxy } from '@spyglassmc/core'
import type { ImpDocDeclarationNode, ImpDocVisibility } from '../node/ImpDocNode.js'
import { getImpDocSymbolData } from '../node/ImpDocNode.js'

export function conflictConfigValidator(
	_ruleName: string,
	value: unknown,
	logger: Logger,
): boolean {
	if (typeof value === 'boolean') {
		return value
	}
	logger.error(
		'[Invalid Linter Config] [impDocVisibilityConflict] Expected a boolean value',
	)
	return false
}

function visit(node: AstNode, fn: (node: AstNode) => void): void {
	fn(node)
	for (const child of node.children ?? []) {
		visit(child, fn)
	}
}

function isDeclarationNode(node: AstNode): node is ImpDocDeclarationNode {
	return node.type === 'impDoc:declaration'
}

interface ConflictCounterpart {
	visibility: ImpDocVisibility
	/** Human-readable location of the counterpart declaration. */
	where: string
}

/**
 * union (OR) 意味論の下で「宣言者の意図が両立しない」 組み合わせのみ矛盾扱いする :
 * - public + restricted の混在 = restricted 側の意図が union で無効化される
 * - 厳格 `@private` 同士で owner が異なる = 排他所有の主張が両立しない
 *
 * `@within` / `@internal` の union (= 許可 caller の追加宣言) は v3 で正当な
 * idiom (caller-local `#declare`) のため矛盾にしない。 同 owner の `@private`
 * 重複も矛盾ではない。 `denied` (= malformed annotation) は binder が error
 * 済みなので二重報告しない。
 */
function getConflictMessage(
	identifier: string,
	own: ImpDocVisibility,
	counterpart: ConflictCounterpart,
): string | undefined {
	const other = counterpart.visibility
	if (own.type === 'denied' || other.type === 'denied') {
		return undefined
	}
	if ((own.type === 'public') !== (other.type === 'public')) {
		return `Visibility of “${identifier}” is contradictory: it is declared ${
			own.type === 'public'
				? 'public here but restricted'
				: 'restricted here but public'
		} in ${counterpart.where}, so the union makes it public everywhere`
	}
	if (own.type === 'private' && other.type === 'private' && own.owner !== other.owner) {
		return `Visibility of “${identifier}” is contradictory: it is private to “${own.owner}” here and private to “${other.owner}” in ${counterpart.where}, so the union allows both owners`
	}
	return undefined
}

/**
 * 同一 symbol に対する複数 visibility 宣言 (function header + `#declare` 群) が
 * 意味論的に矛盾していないか検査する。 v3 union parity (any-match) の採用で
 * 失われる「宣言間の食い違い」 検出を warning として別軸で補う rule。
 * 診断はこの document 内の declaration name に付け、 counterpart 側の位置は
 * message 中に埋め込む (= 矛盾 pair の両側の file がそれぞれ 1 回ずつ報告する)。
 */
export const visibilityConflict: Linter<AstNode> = (node, ctx: LinterContext) => {
	visit(node as StateProxy<AstNode>, (candidate) => {
		if (!isDeclarationNode(candidate)) {
			return
		}
		const data = getImpDocSymbolData(candidate.symbol?.data)
		if (!data) {
			return
		}
		const own = (data.declarations ?? []).find(entry =>
			entry.uri === ctx.doc.uri
			&& entry.range.start === candidate.name.range.start
			&& entry.range.end === candidate.name.range.end
		)
		if (!own) {
			return
		}
		const counterparts: ConflictCounterpart[] = [
			...(data.visibility
				? [{ visibility: data.visibility, where: 'the function header' }]
				: []),
			...(data.declarations ?? [])
				.filter(entry =>
					entry.uri !== own.uri
					|| entry.range.start !== own.range.start
					|| entry.range.end !== own.range.end
				)
				.map(entry => ({
					visibility: entry.visibility,
					where: `“${entry.uri}”`,
				})),
		]
		for (const counterpart of counterparts) {
			const message = getConflictMessage(
				candidate.name.raw,
				own.visibility,
				counterpart,
			)
			if (message) {
				// 1 declaration につき最初の矛盾のみ報告する (counterpart が多い
				// 場合の同一行への診断積み上げを避ける)。
				ctx.err.lint(message, candidate.name.range)
				return
			}
		}
	})
}
