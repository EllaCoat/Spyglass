import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AstNode } from '../../../lib/index.js'
import { Logger, MetaRegistry, Range } from '../../../lib/index.js'
import { editOf, lint, titleOf } from './utils.ts'

const meta = new MetaRegistry()
const Rule = 'nbtBoolean'

/**
 * `true` and `false` are parsed into byte nodes, so the notation can only be told apart by the
 * source that the node spans.
 */
function byteNode(src: string, value: number, isBoolean = false): { node: AstNode; src: string } {
	return {
		node: {
			type: 'nbt:byte',
			range: Range.create(0, src.length),
			value,
			...(isBoolean ? { typeDef: { kind: 'boolean' } } : {}),
		} as unknown as AstNode,
		src,
	}
}

describe('nbtBoolean linter asking for bytes', () => {
	it('Should report the “true” literal', () => {
		const { node, src } = byteNode('true', 1, true)
		const errors = lint(meta, Rule, false, node, src)
		assert.equal(errors.length, 1)
		assert.match(errors[0].message, /Expected a byte tag but got “true”/)
		assert.equal(titleOf(errors[0]), 'Convert to an NBT byte tag')
		assert.deepEqual(editOf(errors[0]), { range: Range.create(0, 4), text: '1b' })
	})

	it('Should report the “false” literal', () => {
		const { node, src } = byteNode('false', 0, true)
		const errors = lint(meta, Rule, false, node, src)
		assert.equal(errors.length, 1)
		assert.deepEqual(editOf(errors[0]), { range: Range.create(0, 5), text: '0b' })
	})

	it('Should report a literal regardless of its case', () => {
		const { node, src } = byteNode('True', 1, true)
		assert.equal(lint(meta, Rule, false, node, src).length, 1)
	})

	it('Should report a literal even without a type definition', () => {
		const { node, src } = byteNode('true', 1)
		assert.equal(lint(meta, Rule, false, node, src).length, 1)
	})

	it('Should keep quiet about a byte', () => {
		const { node, src } = byteNode('1b', 1, true)
		assert.deepEqual(lint(meta, Rule, false, node, src), [])
	})
})

describe('nbtBoolean linter asking for literals', () => {
	it('Should report a byte in a boolean position', () => {
		const { node, src } = byteNode('1b', 1, true)
		const errors = lint(meta, Rule, true, node, src)
		assert.equal(errors.length, 1)
		assert.match(errors[0].message, /Expected true/)
		assert.equal(titleOf(errors[0]), 'Convert to a boolean literal')
		assert.deepEqual(editOf(errors[0]), { range: Range.create(0, 2), text: 'true' })
	})

	it('Should report a zero byte in a boolean position', () => {
		const { node, src } = byteNode('0b', 0, true)
		const errors = lint(meta, Rule, true, node, src)
		assert.equal(errors.length, 1)
		assert.match(errors[0].message, /Expected false/)
		assert.deepEqual(editOf(errors[0]), { range: Range.create(0, 2), text: 'false' })
	})

	it('Should keep quiet about a byte outside a boolean position', () => {
		const { node, src } = byteNode('1b', 1)
		assert.deepEqual(lint(meta, Rule, true, node, src), [])
	})

	it('Should keep quiet about a literal', () => {
		const { node, src } = byteNode('false', 0, true)
		assert.deepEqual(lint(meta, Rule, true, node, src), [])
	})
})

describe('nbtBoolean config validator', () => {
	const logger = Logger.noop()
	const validate = (value: unknown) => !!meta.getLinter(Rule).configValidator(Rule, value, logger)

	it('Should accept booleans only', () => {
		assert.equal(validate(true), true)
		assert.equal(validate(false), true)
		assert.equal(validate('true'), false)
		assert.equal(validate(1), false)
	})
})
