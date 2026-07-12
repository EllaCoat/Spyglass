import * as core from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { registerVisibilityCompleters } from '../lib/completer/visibility.js'

/**
 * `registerVisibilityCompleters` は `resource_location` / `symbol` /
 * `mcfunction:score_holder` の base completer を wrap する。 unit test では
 * je を initialize せずに fake base completer を register してから wrap する。
 */
function setupWrappedCompleter() {
	const meta = new core.MetaRegistry()
	meta.registerCompleter<core.ResourceLocationNode>('resource_location', () => [])
	meta.registerCompleter<core.SymbolNode>('symbol', () => [])
	meta.registerCompleter<core.AstNode>('mcfunction:score_holder', () => [])
	registerVisibilityCompleters(meta)
	return meta.getCompleter<core.AstNode>('mcfunction:score_holder')
}

function mockCtx(offset: number): core.CompleterContext {
	return {
		doc: { uri: 'test://caller.mcfunction' } as core.TextDocument,
		offset,
		symbols: {
			lookup: (category: string) => ({
				parentMap: category === 'score_holder'
					? {
						'test:score': {
							category: 'score_holder',
							identifier: 'test:score',
							data: { impDoc: { visibility: { type: 'public' } } },
							// SymbolUtil.isDeclared 判定に必要。
							declaration: [{ uri: 'test://declare.mcfunction' }],
						},
					}
					: {},
			}),
		} as unknown as core.SymbolUtil,
		config: {} as core.Config,
	} as unknown as core.CompleterContext
}

describe('IMP-Doc score_holder guard (P5c0 review)', () => {
	// selector 有り + 引数範囲内 cursor で IMP-Doc score name を追加しない。
	it('excludes IMP-Doc score names when cursor is inside selector arguments', () => {
		const completer = setupWrappedCompleter()
		const node = {
			type: 'mcfunction:score_holder',
			range: core.Range.create(0, 20),
			children: [],
			selector: {
				type: 'mcfunction:entity_selector',
				range: core.Range.create(0, 20),
				children: [
					{
						type: 'literal',
						range: core.Range.create(0, 2),
						children: [],
					},
					{
						type: 'arguments',
						range: core.Range.create(2, 20),
						children: [],
					},
				],
			},
		}
		const items = completer(node as unknown as core.AstNode, mockCtx(10))
		assert.equal(
			items.filter(i => i.label === 'test:score').length,
			0,
			'IMP-Doc score holder must not be suggested inside selector arguments',
		)
	})

	// selector 有り + 先頭 literal 範囲内 cursor では IMP-Doc score name を追加する。
	it('includes IMP-Doc score names when cursor is at the selector head literal', () => {
		const completer = setupWrappedCompleter()
		const node = {
			type: 'mcfunction:score_holder',
			range: core.Range.create(0, 20),
			children: [],
			selector: {
				type: 'mcfunction:entity_selector',
				range: core.Range.create(0, 20),
				children: [
					{
						type: 'literal',
						range: core.Range.create(0, 2),
						children: [],
					},
					{
						type: 'arguments',
						range: core.Range.create(2, 20),
						children: [],
					},
				],
			},
		}
		const items = completer(node as unknown as core.AstNode, mockCtx(1))
		assert.equal(
			items.filter(i => i.label === 'test:score').length,
			1,
			'IMP-Doc score holder must be suggested at selector head',
		)
	})

	// selector 無し (raw score name 位置) では IMP-Doc score name を追加する。
	it('includes IMP-Doc score names when no selector is present', () => {
		const completer = setupWrappedCompleter()
		const node = {
			type: 'mcfunction:score_holder',
			range: core.Range.create(0, 10),
			children: [],
		}
		const items = completer(node as unknown as core.AstNode, mockCtx(0))
		assert.equal(
			items.filter(i => i.label === 'test:score').length,
			1,
			'IMP-Doc score holder must be suggested when no selector is present',
		)
	})
})

describe('IMP-Doc resource_location tag guard (P5c0 review)', () => {
	// isTag=true では IMP-Doc は候補追加しない (# prefix broken insert 回避)。
	it('excludes IMP-Doc identifiers when the resource_location node is a tag reference', () => {
		const meta = new core.MetaRegistry()
		meta.registerCompleter<core.ResourceLocationNode>('resource_location', () => [])
		meta.registerCompleter<core.SymbolNode>('symbol', () => [])
		meta.registerCompleter<core.AstNode>('mcfunction:score_holder', () => [])
		registerVisibilityCompleters(meta)
		const completer = meta.getCompleter<core.ResourceLocationNode>(
			'resource_location',
		)

		const ctx = {
			doc: { uri: 'test://caller.mcfunction' } as core.TextDocument,
			offset: 0,
			symbols: {
				lookup: (category: string) => ({
					parentMap: category === 'tag/function'
						? {
							'test:tag': {
								category: 'tag/function',
								identifier: 'test:tag',
								data: {
									impDoc: { visibility: { type: 'public' } },
								},
								declaration: [{ uri: 'test://declare.mcfunction' }],
							},
						}
						: {},
				}),
			} as unknown as core.SymbolUtil,
			config: {} as core.Config,
		} as unknown as core.CompleterContext

		const node = {
			type: 'resource_location',
			range: core.Range.create(0, 5),
			children: [],
			isTag: true,
			options: { category: 'function' },
			raw: '',
		} as unknown as core.DeepReadonly<core.ResourceLocationNode>

		const items = completer(node, ctx)
		assert.equal(
			items.filter(i => i.label === 'test:tag').length,
			0,
			'IMP-Doc identifiers must not be added for tag references',
		)
	})
})
