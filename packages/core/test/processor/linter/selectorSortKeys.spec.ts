import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Logger, MetaRegistry, Range } from '../../../lib/index.js'
import { editOf, lint, recordNode, titleOf } from './utils.ts'

const meta = new MetaRegistry()
const Rule = 'selectorSortKeys'
const Order = ['type', 'distance', 'limit', 'sort']

function selectorArguments(...keys: string[]) {
	return recordNode({
		type: 'mcfunction:entity_selector/arguments',
		entries: keys.map((key) => ({ key: { value: key }, value: { value: `v_${key}` } })),
	})
}

describe('selectorSortKeys linter', () => {
	it('Should report unsorted keys', () => {
		const { node, src } = selectorArguments('distance', 'type')
		assert.equal(src, '[distance=v_distance,type=v_type]')
		const errors = lint(meta, Rule, Order, node, src)
		assert.equal(errors.length, 1)
		assert.match(errors[0].message, /Unsorted keys/)
		assert.equal(titleOf(errors[0]), 'Sort selector argument')
		assert.deepEqual(editOf(errors[0]), {
			range: Range.create(1, src.length - 1),
			text: 'type=v_type,distance=v_distance',
		})
	})

	it('Should keep quiet about sorted keys', () => {
		const { node, src } = selectorArguments('type', 'distance', 'sort')
		assert.deepEqual(lint(meta, Rule, Order, node, src), [])
	})

	it('Should keep quiet about a single key', () => {
		const { node, src } = selectorArguments('limit')
		assert.deepEqual(lint(meta, Rule, Order, node, src), [])
	})

	it('Should keep quiet about repeated keys', () => {
		const { node, src } = selectorArguments('type', 'type', 'sort')
		assert.deepEqual(lint(meta, Rule, Order, node, src), [])
	})

	it('Should ignore keys that the rule value does not mention', () => {
		const { node, src } = selectorArguments('tag', 'type', 'predicate', 'distance')
		assert.deepEqual(lint(meta, Rule, Order, node, src), [])
	})

	it('Should move keys that the rule value does not mention to the end', () => {
		const { node, src } = selectorArguments('distance', 'tag', 'type', 'predicate')
		const errors = lint(meta, Rule, Order, node, src)
		assert.equal(errors.length, 1)
		assert.equal(
			editOf(errors[0]).text,
			'type=v_type,distance=v_distance,tag=v_tag,predicate=v_predicate',
		)
	})

	it('Should produce a quick fix that silences the diagnostic', () => {
		const { node, src } = selectorArguments('sort', 'limit', 'distance', 'type')
		const errors = lint(meta, Rule, Order, node, src)
		assert.equal(errors.length, 1)
		const { range, text } = editOf(errors[0])
		const fixed = `${src.slice(0, range.start)}${text}${src.slice(range.end)}`
		assert.equal(fixed, '[type=v_type,distance=v_distance,limit=v_limit,sort=v_sort]')
		const { node: fixedNode } = selectorArguments('type', 'distance', 'limit', 'sort')
		assert.deepEqual(lint(meta, Rule, Order, fixedNode, fixed), [])
	})
})

describe('selectorSortKeys config validator', () => {
	const logger = Logger.noop()
	const validate = (value: unknown) => !!meta.getLinter(Rule).configValidator(Rule, value, logger)

	it('Should accept an array of strings', () => {
		assert.equal(validate([]), true)
		assert.equal(validate(['type', 'distance']), true)
	})

	it('Should reject anything else', () => {
		assert.equal(validate('type'), false)
		assert.equal(validate(['type', 1]), false)
		assert.equal(validate({}), false)
	})
})
