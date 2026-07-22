import * as core from '@spyglassmc/core'
import type { ImpDocNode } from '../node/ImpDocNode.js'
import { ImpDocNode as ImpDocNodeUtil } from '../node/ImpDocNode.js'
import { getDocumentFunction } from '../util/documentFunction.js'
import {
	fallbackVisibility,
	parseVisibility,
	stampVisibility,
	trackDeclarationVisibility,
} from '../util/withinPattern.js'

/** `linter/private.ts`'s `visit` の binder 版: attached subtree だけを歩く。 */
function visit(node: core.AstNode, fn: (node: core.AstNode) => void): void {
	fn(node)
	for (const child of node.children ?? []) {
		visit(child, fn)
	}
}

/**
 * `candidate` が自身の bound symbol の definition/declaration site そのものかを
 * 判定する。 `linter/private.ts`'s `isReferenceUsage` の裏返し: reference usage
 * (= attached command 内で他の symbol を参照しているだけの node) を除外し、
 * attached command 自身が定義/宣言した symbol だけを stamp 対象にする。
 */
function isDefinitionOrDeclarationSite(
	symbol: core.Symbol,
	uri: string,
	range: core.Range,
): boolean {
	return (['definition', 'declaration'] as const).some(usage =>
		symbol[usage]?.some(loc =>
			loc.uri === uri
			&& loc.range?.start === range.start
			&& loc.range?.end === range.end
		)
	)
}

/**
 * IMP-Doc component に attached された command (`parser/impDoc.ts` が
 * `attachedNodes` として抽出済) が bind した symbol へ doc/visibility を stamp
 * する (Phase 4-3c)。 `binder/impDoc.ts` の child dispatch loop 完了後に呼ばれる
 * 前提 (= attached node の symbol は既に bind 済)。
 *
 * attached AST subtree のみを歩き、 URI の全 symbol を scan するような lookup /
 * query は一切呼ばない。 stamp 先は既存の `ImpDocDeclarationVisibility` entry
 * (`declarations[]`) そのものなので、 URI purge / warm cache index 再構築は
 * `withinPattern.ts` の既存経路 (`clearImpDocMetadataForUri` /
 * `trackDeclarationVisibility`) がそのまま面倒を見る。
 */
export function stampAttachedSymbols(node: ImpDocNode, ctx: core.BinderContext): void {
	const attached = node.attachedNodes
	if (!attached?.length) {
		return
	}

	const owner = getDocumentFunction(ctx, node)?.identifier
		?? (node.functionID?.raw ? core.ResourceLocation.lengthen(node.functionID.raw) : undefined)
	if (!owner) {
		return
	}

	const visibility = parseVisibility(node.annotations, owner, ctx.err)
		?? fallbackVisibility(node.annotations, owner, ctx.err)
	const description = ImpDocNodeUtil.getDescription(node)

	for (const root of attached) {
		visit(root, candidate => {
			// symbol 無しの node が大半なので存在 check を先頭に置き定数コストで抜ける。
			const symbol = candidate.symbol
			if (!symbol) {
				return
			}
			if (!isDefinitionOrDeclarationSite(symbol, ctx.doc.uri, candidate.range)) {
				return
			}
			stampVisibility(symbol, visibility, {
				uri: ctx.doc.uri,
				range: candidate.range,
				owner,
				description,
			})
			trackDeclarationVisibility(ctx.symbols, symbol, ctx.doc.uri)
		})
	}
}
