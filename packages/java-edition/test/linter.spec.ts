import type {
	AstNode,
	LanguageError,
	LanguageErrorAction,
	MetaRegistry,
	Parser,
} from '@spyglassmc/core'
import {
	AstNode as AstNodeUtil,
	CheckerContext,
	ErrorSeverity,
	Failure,
	LinterContext,
	LinterErrorReporter,
	PairNode,
	ParserContext,
	Source,
	StateProxy,
} from '@spyglassmc/core'
import { mockProjectData } from '@spyglassmc/core/test/utils.ts'
import { argument } from '@spyglassmc/java-edition/lib/mcfunction/parser/index.js'
import type { ArgumentTreeNode } from '@spyglassmc/java-edition/lib/mcfunction/tree/index.js'
import type { McdocType } from '@spyglassmc/mcdoc'
import * as nbt from '@spyglassmc/nbt'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'

const QuoteRules = [
	'commandStringQuote',
	'nbtKeyQuote',
	'nbtPathQuote',
	'nbtStringQuote',
	'selectorKeyQuote',
]

const project = mockProjectData({ ctx: { loadedVersion: '1.21' } })
nbt.initialize({ ...project, reinitializeOnChange: () => {} })

function parse<T extends AstNode>(parser: Parser<T>, text: string): T {
	const src = new Source(text)
	const ctx = ParserContext.create(project, {
		doc: TextDocument.create('file:///linter-test.mcfunction', 'mcfunction', 0, text),
	})
	const result = parser(src, ctx)
	assert.notEqual(result, Failure)
	assert.ok(result && AstNodeUtil.is(result))
	assert.deepEqual(ctx.err.dump(), [])
	AstNodeUtil.setParents(result)
	return result as T
}

function parseArgument(treeNode: ArgumentTreeNode, text: string): AstNode {
	const parser = argument(treeNode, [])
	assert.ok(parser)
	return parse(parser, text)
}

function findNode(root: AstNode, type: string): AstNode {
	if (root.type === type) {
		return root
	}
	for (const child of root.children ?? []) {
		const found = findNodeOrUndefined(child, type)
		if (found) {
			return found
		}
	}
	assert.fail(`Could not find a ${type} node`)
}

function findNodeOrUndefined(root: AstNode, type: string): AstNode | undefined {
	if (root.type === type) {
		return root
	}
	for (const child of root.children ?? []) {
		const found = findNodeOrUndefined(child, type)
		if (found) {
			return found
		}
	}
	return undefined
}

function checkNbtType(node: nbt.NbtNode, typeDef: McdocType, text: string): void {
	const ctx = CheckerContext.create(project, {
		doc: TextDocument.create('file:///linter-test.mcfunction', 'mcfunction', 0, text),
	})
	nbt.checker.typeDefinition(typeDef)(node, ctx)
	assert.deepEqual(ctx.err.dump(), [])
	assert.ok(node.typeDef, 'The NBT checker did not attach a type definition')
}

function matchingQuoteRules(meta: MetaRegistry, node: AstNode): string[] {
	return QuoteRules.filter((rule) => !!meta.getLinter(rule).nodePredicate(node))
}

function lint(ruleName: string, ruleValue: unknown, node: AstNode, text: string): LanguageError[] {
	const registration = project.meta.getLinter(ruleName)
	assert.ok(registration.nodePredicate(node), `${ruleName} did not select ${node.type}`)
	const err = new LinterErrorReporter(ruleName, ErrorSeverity.Warning)
	const ctx = LinterContext.create(project, {
		doc: TextDocument.create('file:///linter-test.mcfunction', 'mcfunction', 0, text),
		err,
		ruleName,
		ruleValue,
	})
	registration.linter(StateProxy.create(node), ctx)
	return [...err.dump()]
}

function actionOf(error: LanguageError): LanguageErrorAction {
	const action = error.info?.codeAction
	assert.ok(action)
	return action
}

describe('built-in linter integration', () => {
	it('Routes parsed NBT strings by key, path, and typed value position', () => {
		const text = '{foo:"bar"}'
		const compound = parse(nbt.parser.compound, text)
		const compoundPair = compound.children[0]
		assert.ok(compoundPair.key && compoundPair.value)
		checkNbtType(compoundPair.value, { kind: 'string' }, text)

		const path = parse(nbt.parser.path, '"foo"')
		const pathPart = path.children[0]
		assert.ok(pathPart.children)
		const pathKey = pathPart.children[0]

		assert.deepEqual(matchingQuoteRules(project.meta, compoundPair.key), ['nbtKeyQuote'])
		assert.deepEqual(matchingQuoteRules(project.meta, pathKey), ['nbtPathQuote'])
		assert.deepEqual(matchingQuoteRules(project.meta, compoundPair.value), ['nbtStringQuote'])
	})

	it('Selects parsed NBT strings stamped by the checker from string and union definitions', () => {
		const definitions: McdocType[] = [{ kind: 'string' }, {
			kind: 'union',
			members: [{ kind: 'string' }, { kind: 'int' }],
		}]
		for (const definition of definitions) {
			const text = '"value"'
			const node = parse(nbt.parser.primitive, text)
			assert.equal(node.type, 'nbt:string')
			checkNbtType(node, definition, text)
			const errors = lint('nbtStringQuote', { always: false }, node, text)
			assert.equal(errors.length, 1)
		}
	})

	it('Does not select an untyped parsed NBT string value', () => {
		const node = parse(nbt.parser.primitive, '"value"')
		assert.equal(node.type, 'nbt:string')
		assert.deepEqual(matchingQuoteRules(project.meta, node), [])
	})

	it('Does not unquote parsed NBT strings that would become primitives', () => {
		for (const value of ['1', '1b', '1.5', '4.5f', 'true', 'FALSE']) {
			const text = `"${value}"`
			const node = parse(nbt.parser.primitive, text)
			assert.equal(node.type, 'nbt:string')
			checkNbtType(node, { kind: 'string' }, text)
			assert.deepEqual(lint('nbtStringQuote', { always: false }, node, text), [], value)
		}

		const text = '"value"'
		const node = parse(nbt.parser.primitive, text)
		checkNbtType(node, { kind: 'string' }, text)
		const errors = lint('nbtStringQuote', { always: false }, node, text)
		assert.equal(errors.length, 1)
		assert.equal(actionOf(errors[0]).changes?.[0]?.type, 'edit')
	})

	it('Keeps a parsed empty NBT path key quoted when unquoted emptiness is prohibited', () => {
		const text = '""'
		const path = parse(nbt.parser.path, text)
		const pathPart = path.children[0]
		assert.ok(pathPart.children)
		const errors = lint('nbtPathQuote', { always: false }, pathPart.children[0], text)
		assert.deepEqual(errors, [])
	})

	it('Preserves parsed selector separators and a trailing comma when sorting', () => {
		const text = '@e[distance = 1, type = zombie,]'
		const selector = parseArgument({
			type: 'argument',
			parser: 'minecraft:entity',
			properties: { amount: 'multiple', type: 'entities' },
		}, text)
		const args = findNode(selector, 'mcfunction:entity_selector/arguments')
		const errors = lint('selectorSortKeys', ['type', 'distance'], args, text)
		assert.equal(errors.length, 1)
		const change = actionOf(errors[0]).changes?.[0]
		assert.ok(change?.type === 'edit')
		assert.equal(change.text, 'type = zombie, distance = 1,')
	})

	it('Does not select parsed block state keys or values', () => {
		const block = parseArgument({
			type: 'argument',
			parser: 'minecraft:block_state',
			properties: {},
		}, 'stone[facing=north]')
		const states = findNode(block, 'mcfunction:block/states')
		const pair = states.children![0]
		assert.ok(PairNode.is(pair))
		assert.ok(pair.key && pair.value)
		assert.deepEqual(matchingQuoteRules(project.meta, pair.key), [])
		assert.deepEqual(matchingQuoteRules(project.meta, pair.value), [])
	})
})
