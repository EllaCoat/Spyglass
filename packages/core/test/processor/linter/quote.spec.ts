import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { StringBaseNode } from '../../../lib/index.js'
import { AstNode, Logger, MetaRegistry, Range } from '../../../lib/index.js'
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

	it('Should unquote an empty string when the parser allows an empty unquoted value', () => {
		const { node, src } = stringNode({ value: '', quote: '"' })
		const errors = lint(meta, Rule, { always: false }, node, src)
		assert.equal(errors.length, 1)
		assert.deepEqual(editOf(errors[0]), { range: Range.create(0, 2), text: '' })
	})

	it('Should keep an empty string quoted when the parser prohibits an empty unquoted value', () => {
		const node = {
			...stringNode({ value: '', quote: '"' }).node,
			options: {
				quotes: ['"'],
				unquotable: { blockList: new Set<string>() },
			},
		} as StringBaseNode
		assert.deepEqual(lint(meta, 'nbtPathQuote', { always: false }, node, '""'), [])
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

	it('Should omit the quick fix when the decoded value contains a control character', () => {
		const { node, src } = stringNode({ value: 'line\nbreak', quote: "'" })
		const errors = lint(meta, Rule, { always: true, type: 'double' }, node, src)
		assert.equal(errors.length, 1)
		assert.equal(errors[0].info?.codeAction, undefined)
	})

	it('Should omit the quick fix for a string embedded in another string', () => {
		const { node: outer, src } = stringNode({ value: "'foo'", quote: '"' })
		const { node: inner } = stringNode({ value: 'foo', quote: "'" })
		inner.range = Range.create(1, 6)
		outer.valueMap.push({ inner: Range.create(0), outer: Range.create(1) })
		outer.children = [inner]
		AstNode.setParents(outer)

		const errors = lint(meta, Rule, { always: true, type: 'double' }, inner, src)
		assert.equal(errors.length, 1)
		assert.equal(errors[0].info?.codeAction, undefined)
	})

	it('Should keep primitive-looking NBT strings quoted', () => {
		for (
			const value of [
				'0',
				'-1',
				'1b',
				'2S',
				'3l',
				'1.5',
				'4.5f',
				'6.7D',
				'true',
				'FALSE',
			]
		) {
			const { node, src } = stringNode({ type: 'nbt:string', value, quote: '"' })
			assert.deepEqual(lint(meta, 'nbtStringQuote', { always: false }, node, src), [], value)
		}
	})

	it('Should allow primitive-looking strings to be unquoted outside NBT values', () => {
		for (
			const rule of [
				'commandStringQuote',
				'nbtKeyQuote',
				'nbtPathQuote',
				'selectorKeyQuote',
			]
		) {
			const { node, src } = stringNode({ value: '1b', quote: '"' })
			assert.equal(lint(meta, rule, { always: false }, node, src).length, 1, rule)
		}
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
