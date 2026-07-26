import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AstNode, MetaRegistry, Range } from '../../../lib/index.js'
import { matches, recordNode, stringNode } from './utils.ts'

const meta = new MetaRegistry()
const QuoteRules = [
	'commandStringQuote',
	'nbtKeyQuote',
	'nbtPathQuote',
	'nbtStringQuote',
	'selectorKeyQuote',
]

/**
 * Asserts that `node` is picked up by exactly the rules in `expected`.
 */
function assertRules(node: AstNode, expected: string[], hint: string) {
	assert.deepEqual(QuoteRules.filter((rule) => matches(meta, rule, node)), expected, hint)
}

/** Wraps `child` in a parent node of the given type, as the real parsers do. */
function wrap(type: string, child: AstNode): AstNode {
	const node: AstNode = {
		type,
		range: Range.create(child.range.start, child.range.end),
		children: [child],
	}
	AstNode.setParents(node)
	return node
}

const compound = recordNode({
	type: 'nbt:compound',
	brackets: '{}',
	sep: ':',
	entries: [{
		key: { type: 'nbt:string', value: 'Tags' },
		value: { type: 'nbt:string', value: 'foo', quote: '"' },
	}],
})
;(compound.values[0] as unknown as { typeDef?: { kind: string } }).typeDef = { kind: 'string' }
const selector = recordNode({
	type: 'mcfunction:entity_selector/arguments',
	entries: [{ key: { value: 'tag' }, value: { value: 'foo' } }],
})
const blockStates = recordNode({
	type: 'mcfunction:block/states',
	entries: [{ key: { value: 'facing' }, value: { value: 'north' } }],
})

describe('quote linter node predicates', () => {
	it('Should route an NBT compound key to nbtKeyQuote', () => {
		assertRules(compound.keys[0], ['nbtKeyQuote'], 'NBT compound key')
	})

	it('Should route an NBT compound value to nbtStringQuote', () => {
		assertRules(compound.values[0], ['nbtStringQuote'], 'NBT compound value')
	})

	it('Should route an NBT path key to nbtPathQuote', () => {
		const { node } = stringNode({ type: 'nbt:string', value: 'Tags' })
		wrap('nbt:path', wrap('nbt:path/key', node))
		assertRules(node, ['nbtPathQuote'], 'NBT path key')
	})

	it('Should route a loose NBT string to nbtStringQuote', () => {
		const { node } = stringNode({ type: 'nbt:string', value: 'foo', quote: '"' })
		;(node as unknown as { typeDef?: { kind: string } }).typeDef = { kind: 'string' }
		wrap('nbt:list', node)
		assertRules(node, ['nbtStringQuote'], 'NBT list element')
	})

	it('Should not route an untyped NBT string value anywhere', () => {
		const { node } = stringNode({ type: 'nbt:string', value: 'foo', quote: '"' })
		wrap('nbt:list', node)
		assertRules(node, [], 'untyped NBT list element')
	})

	it('Should route an NBT string value typed by a string union', () => {
		const { node } = stringNode({ type: 'nbt:string', value: 'foo', quote: '"' })
		;(node as unknown as { typeDef?: unknown }).typeDef = {
			kind: 'union',
			members: [{ kind: 'int' }, { kind: 'string' }],
		}
		wrap('nbt:list', node)
		assertRules(node, ['nbtStringQuote'], 'union-typed NBT list element')
	})

	it('Should not route enum, literal, or non-string union NBT values', () => {
		for (
			const typeDef of [
				{ kind: 'enum' },
				{ kind: 'literal' },
				{ kind: 'union', members: [{ kind: 'int' }, { kind: 'boolean' }] },
			]
		) {
			const { node } = stringNode({ type: 'nbt:string', value: 'foo', quote: '"' })
			;(node as unknown as { typeDef?: unknown }).typeDef = typeDef
			wrap('nbt:list', node)
			assertRules(node, [], `${typeDef.kind}-typed NBT list element`)
		}
	})

	it('Should route a command argument to commandStringQuote', () => {
		const { node } = stringNode({ value: 'foo', quote: '"' })
		wrap('mcfunction:command_child', node)
		assertRules(node, ['commandStringQuote'], 'command argument')
	})

	it('Should route a selector argument key to selectorKeyQuote', () => {
		assertRules(selector.keys[0], ['selectorKeyQuote'], 'selector argument key')
	})

	it('Should not route a selector argument value anywhere', () => {
		assertRules(selector.values[0], [], 'selector argument value')
	})

	it('Should not route block states anywhere', () => {
		assertRules(blockStates.keys[0], [], 'block state key')
		assertRules(blockStates.values[0], [], 'block state value')
	})

	it('Should not route a pair or a record node anywhere', () => {
		assertRules(compound.node.children[0], [], 'NBT compound pair')
		assertRules(selector.node, [], 'selector arguments')
	})
})

const NameOfRules: readonly (readonly [ruleName: string, category: string])[] = [
	['nameOfObjective', 'objective'],
	['nameOfScoreHolder', 'score_holder'],
	['nameOfTag', 'tag'],
	['nameOfTeam', 'team'],
]

/**
 * @returns A node that carries a symbol of the given `category`, with `props` supplying whatever
 * properties hold the symbol's name. A binder may attach a symbol to a node of any shape, so the
 * name is not necessarily kept in a `value` string.
 */
function symbolNode(category: string, props: Record<string, unknown>): AstNode {
	return {
		type: 'test:symbol_carrier',
		range: Range.create(0, 3),
		symbol: { category, identifier: 'Foo', path: ['Foo'], parentMap: {} },
		...props,
	} as unknown as AstNode
}

describe('nameOf linter node predicates', () => {
	for (const [ruleName, category] of NameOfRules) {
		it(`Should accept a ${category} symbol whose name is a string value`, () => {
			assert.equal(matches(meta, ruleName, symbolNode(category, { value: 'Foo' })), true)
		})

		it(`Should not accept a ${category} symbol without a value`, () => {
			// e.g. an `impDoc:declaration` node, which keeps its name in a `name` object instead.
			const node = symbolNode(category, { name: { raw: 'Foo', range: Range.create(0, 3) } })
			assert.equal(matches(meta, ruleName, node), false)
		})

		it(`Should not accept a ${category} symbol whose value is an object`, () => {
			// e.g. an `impDoc:alias` node, whose `value` is a `{ raw, range }` pair.
			const node = symbolNode(category, { value: { raw: 'Foo', range: Range.create(0, 3) } })
			assert.equal(matches(meta, ruleName, node), false)
		})
	}
})

describe('selectorSortKeys and nbtBoolean node predicates', () => {
	it('Should only accept selector arguments', () => {
		assert.equal(matches(meta, 'selectorSortKeys', selector.node), true)
		assert.equal(matches(meta, 'selectorSortKeys', blockStates.node), false)
		assert.equal(matches(meta, 'selectorSortKeys', compound.node), false)
	})

	it('Should only accept NBT byte tags', () => {
		const byte: AstNode = { type: 'nbt:byte', range: Range.create(0, 4) }
		assert.equal(matches(meta, 'nbtBoolean', byte), true)
		assert.equal(matches(meta, 'nbtBoolean', compound.values[0]), false)
	})
})
