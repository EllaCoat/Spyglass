import * as core from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { registerAliasCompleters } from '../lib/completer/alias.js'

/**
 * P4-3b: alias marker wrap の unit test (spike 3)。 「parser が 0 文字消費した
 * 空 range + outer command argument origin」 だけで alias snippet を提示し、
 * 部分入力や同じ汎用 node type を使う内部 parser では base に委ねることを pin する。
 */

const Aliases: Readonly<Record<string, Record<string, string>>> = {
	'alias/entity': { cached_entity: '@e[tag=Runtime, limit=1]' },
	'alias/uuid': { cached_uuid: '12345678-1234-5678-1234-567812345678' },
	'alias/vector': { cached_vector: '1.0 2.0 3.0' },
}

function mockCtx(offset: number): core.CompleterContext {
	return {
		doc: { uri: 'file:///caller.mcfunction' },
		offset,
		symbols: {
			lookup: (category: string) => ({
				parentMap: Object.fromEntries(
					Object.entries(Aliases[category] ?? {}).map(([identifier, expansion]) => [
						identifier,
						{
							category,
							identifier,
							declaration: [{ uri: 'file:///aliases.mcfunction' }],
							data: {
								impDoc: { alias: { kind: category.slice('alias/'.length), expansion } },
							},
						},
					]),
				),
			}),
		},
	} as unknown as core.CompleterContext
}

const BaseSelectorItemLabel = '@a'

function setupMeta(): core.MetaRegistry {
	const meta = new core.MetaRegistry()
	meta.registerCompleter<core.AstNode>(
		'mcfunction:entity_selector',
		(node) => [core.CompletionItem.create(BaseSelectorItemLabel, node)],
	)
	meta.registerCompleter<core.AstNode>('mcfunction:vector', () => [])
	registerAliasCompleters(meta)
	return meta
}

function selectorNode(
	range: core.Range,
	completionOrigin?: 'minecraft:entity' | 'minecraft:game_profile',
): core.AstNode {
	return {
		type: 'mcfunction:entity_selector',
		range,
		children: [],
		completionOrigin,
	} as unknown as core.AstNode
}

function vectorNode(
	range: core.Range,
	options: { dimension: 2 | 3; integersOnly?: boolean; noLocal?: boolean },
	completionOrigin?: 'minecraft:vec3',
): core.AstNode {
	return {
		type: 'mcfunction:vector',
		range,
		options,
		children: [],
		completionOrigin,
	} as unknown as core.AstNode
}

function uuidNode(range: core.Range, completionOrigin?: 'minecraft:uuid'): core.AstNode {
	return {
		type: 'mcfunction:uuid',
		range,
		children: [],
		completionOrigin,
	} as unknown as core.AstNode
}

describe('IMP-Doc alias completion markers (P4-3b)', () => {
	it('offers the entity alias as a snippet on an untyped selector mock', () => {
		const meta = setupMeta()
		const completer = meta.getCompleter<core.AstNode>('mcfunction:entity_selector')
		const items = completer(
			selectorNode(core.Range.create(5, 5), 'minecraft:entity'),
			mockCtx(5),
		)

		const alias = items.find(item => item.label === 'cached_entity')
		assert.ok(alias, 'expected the alias/entity snippet item')
		// CompletionKind.Snippet = 15 (const enum、 strip-types loader では inline
		// されないため runtime に enum object が存在しない、 数値で照合)。
		assert.equal(alias.kind, 15)
		assert.equal(alias.detail, '@e[tag=Runtime, limit=1]')
		assert.equal(alias.insertText, core.CompletionItem.escape('@e[tag=Runtime, limit=1]'))
		assert.ok(
			items.some(item => item.label === BaseSelectorItemLabel),
			'base selector items must be preserved',
		)
	})

	it('does not offer aliases once the selector consumed input', () => {
		const meta = setupMeta()
		const completer = meta.getCompleter<core.AstNode>('mcfunction:entity_selector')
		const items = completer(
			selectorNode(core.Range.create(5, 7), 'minecraft:entity'),
			mockCtx(6),
		)
		assert.deepEqual(items.map(item => item.label), [BaseSelectorItemLabel])
	})

	it('offers the vector alias only for the vec3 marker options', () => {
		const meta = setupMeta()
		const completer = meta.getCompleter<core.AstNode>('mcfunction:vector')
		const range = core.Range.create(5, 5)

		const vec3 = completer(
			vectorNode(range, { dimension: 3 }, 'minecraft:vec3'),
			mockCtx(5),
		)
		assert.deepEqual(vec3.map(item => item.label), ['cached_vector'])
		assert.equal(vec3[0].insertText, '1.0 2.0 3.0')

		// vec2 / rotation (dimension 2) と block_pos (integersOnly) には出さない。
		assert.deepEqual(completer(vectorNode(range, { dimension: 2 }), mockCtx(5)), [])
		assert.deepEqual(
			completer(vectorNode(range, { dimension: 3, integersOnly: true }), mockCtx(5)),
			[],
		)
		// 部分入力 (real node) にも出さない。
		assert.deepEqual(
			completer(
				vectorNode(
					core.Range.create(5, 8),
					{ dimension: 3 },
					'minecraft:vec3',
				),
				mockCtx(8),
			),
			[],
		)
	})

	it('registers the uuid completer gated to the untyped position', () => {
		const meta = setupMeta()
		const completer = meta.getCompleter<core.AstNode>('mcfunction:uuid')

		const items = completer(
			uuidNode(core.Range.create(5, 5), 'minecraft:uuid'),
			mockCtx(5),
		)
		assert.deepEqual(items.map(item => item.label), ['cached_uuid'])
		assert.deepEqual(
			completer(
				uuidNode(core.Range.create(5, 9), 'minecraft:uuid'),
				mockCtx(9),
			),
			[],
		)
	})

	it('requires an outer command-argument origin on generic mock node types', () => {
		const meta = setupMeta()
		const ctx = mockCtx(5)
		const range = core.Range.create(5, 5)

		const selector = meta.getCompleter<core.AstNode>('mcfunction:entity_selector')
		assert.deepEqual(
			selector(selectorNode(range), ctx).map(item => item.label),
			[BaseSelectorItemLabel],
		)
		assert.deepEqual(
			meta.getCompleter<core.AstNode>('mcfunction:vector')(
				vectorNode(range, { dimension: 3 }),
				ctx,
			),
			[],
		)
		assert.deepEqual(
			meta.getCompleter<core.AstNode>('mcfunction:uuid')(uuidNode(range), ctx),
			[],
		)
	})

	it('keeps the uuid mock a no-op when the plugin completers are not installed', () => {
		// java-edition が `UuidNode.mock` を返しても、 completer 未登録なら core
		// dispatch の `hasCompleter` predicate で候補ゼロに落ちる (= 非導入時
		// regression なし、 spike 3 判断 3)。
		const meta = new core.MetaRegistry()
		meta.registerCompleter<core.AstNode>('mcfunction:entity_selector', () => [])
		meta.registerCompleter<core.AstNode>('mcfunction:vector', () => [])

		assert.equal(meta.hasCompleter('mcfunction:uuid'), false)
		const ctx = { ...mockCtx(5), meta } as unknown as core.CompleterContext
		assert.deepEqual(core.completer.dispatch(uuidNode(core.Range.create(5, 5)), ctx), [])
	})
})
