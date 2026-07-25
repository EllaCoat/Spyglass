import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { StringBaseNode } from '../../../lib/index.js'
import { Logger, MetaRegistry, Range } from '../../../lib/index.js'
import { editOf, lint, stringNode, titleOf } from './utils.ts'

const meta = new MetaRegistry()
const Rule = 'commandStringQuote'

describe('quote linter', () => {
	it('Should report an unquoted string when a quote is always required', () => {
		const { node, src } = stringNode({ value: 'foo' })
		const errors = lint(meta, Rule, { always: true }, node, src)
		assert.equal(errors.length, 1)
		assert.match(errors[0].message, /Expected a quote/)
		assert.equal(titleOf(errors[0]), 'Quote this string with double quotation marks')
		assert.deepEqual(editOf(errors[0]), { range: Range.create(0, 3), text: '"foo"' })
	})

	it('Should keep quiet about a quoted string when a quote is always required', () => {
		const { node, src } = stringNode({ value: 'foo', quote: '"' })
		assert.deepEqual(lint(meta, Rule, { always: true }, node, src), [])
	})

	it('Should report a quoted string when quotes are prohibited', () => {
		const { node, src } = stringNode({ value: 'foo', quote: '"' })
		const errors = lint(meta, Rule, { always: false }, node, src)
		assert.equal(errors.length, 1)
		assert.match(errors[0].message, /Expected an unquoted string/)
		assert.equal(titleOf(errors[0]), 'Unquote this string')
		assert.deepEqual(editOf(errors[0]), { range: Range.create(0, 5), text: 'foo' })
	})

	it('Should keep quiet about a value that cannot be unquoted', () => {
		const { node, src } = stringNode({ value: 'a b', quote: '"' })
		assert.deepEqual(lint(meta, Rule, { always: false }, node, src), [])
	})

	it('Should keep quiet about an unquoted string when no quote is required', () => {
		const { node, src } = stringNode({ value: 'foo' })
		assert.deepEqual(lint(meta, Rule, { type: 'double' }, node, src), [])
	})

	it('Should keep quiet about a string that cannot be quoted at all', () => {
		// The `word` and `greedy` Brigadier strings have no `quotes` in their options.
		const node = {
			type: 'string',
			range: Range.create(0, 3),
			options: { unquotable: { allowEmpty: true } },
			value: 'foo',
			valueMap: [],
		} as unknown as StringBaseNode
		assert.deepEqual(lint(meta, Rule, { always: true }, node, 'foo'), [])
	})

	it('Should report the wrong quotation mark', () => {
		const { node, src } = stringNode({ value: 'foo', quote: "'" })
		const errors = lint(meta, Rule, { always: true, type: 'double' }, node, src)
		assert.equal(errors.length, 1)
		assert.match(errors[0].message, /Expected “"” but got “'”/)
		assert.deepEqual(editOf(errors[0]), { range: Range.create(0, 5), text: '"foo"' })
	})

	it('Should not check the quotation mark when the config does not specify a type', () => {
		const { node, src } = stringNode({ value: 'foo', quote: "'" })
		assert.deepEqual(lint(meta, Rule, { always: true }, node, src), [])
	})

	it('Should accept the other quotation mark when escapes are avoided', () => {
		const { node, src } = stringNode({ value: 'a"b', quote: "'" })
		const config = { always: true, avoidEscape: true, type: 'double' }
		assert.deepEqual(lint(meta, Rule, config, node, src), [])
	})

	it('Should prefer the other quotation mark when escapes are avoided', () => {
		const { node, src } = stringNode({ value: 'a"b', quote: '"' })
		const config = { always: true, avoidEscape: true, type: 'double' }
		const errors = lint(meta, Rule, config, node, src)
		assert.equal(errors.length, 1)
		assert.match(errors[0].message, /Single quote \(“'”\) is preferable here/)
		assert.equal(titleOf(errors[0]), 'Quote this string with single quotation marks')
		assert.equal(editOf(errors[0]).text, `'a"b'`)
	})

	it('Should escape the quotation mark and the backslash in the quick fix', () => {
		const { node, src } = stringNode({ value: String.raw`a"b\c`, quote: '"' })
		const errors = lint(meta, Rule, { always: true, type: 'single' }, node, src)
		assert.equal(errors.length, 1)
		assert.equal(editOf(errors[0]).text, String.raw`'a"b\\c'`)
	})

	it('Should be shared by all five quote rules', () => {
		for (
			const rule of [
				'commandStringQuote',
				'nbtKeyQuote',
				'nbtPathQuote',
				'nbtStringQuote',
				'selectorKeyQuote',
			]
		) {
			const { node, src } = stringNode({ value: 'foo' })
			const errors = lint(meta, rule, { always: true }, node, src)
			assert.equal(errors.length, 1, `Rule ${rule} did not report anything`)
			assert.match(errors[0].message, new RegExp(`\\(rule: ${rule}\\)$`))
		}
	})
})

describe('quote linter config validator', () => {
	const logger = Logger.noop()
	const validate = (value: unknown) => !!meta.getLinter(Rule).configValidator(Rule, value, logger)

	it('Should accept legal configs', () => {
		assert.equal(validate({}), true)
		assert.equal(validate({ always: false, avoidEscape: false, type: 'double' }), true)
		// Configs come from JSON, where a disabled `avoidEscape` is spelled as `null`.
		assert.equal(validate(JSON.parse('{"always":true,"avoidEscape":null,"type":"single"}')), true)
	})

	it('Should reject illegal configs', () => {
		assert.equal(validate('double'), false)
		assert.equal(validate([]), false)
		assert.equal(validate({ always: 'yes' }), false)
		assert.equal(validate({ avoidEscape: 'yes' }), false)
		assert.equal(validate({ avoidEscape: 0 }), false)
		assert.equal(validate({ type: 'back' }), false)
	})
})
