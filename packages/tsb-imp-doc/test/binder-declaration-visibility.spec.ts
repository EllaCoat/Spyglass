import * as core from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { declaration as bindDeclaration } from '../lib/binder/declaration.js'
import type {
	ImpDocAnnotation,
	ImpDocContract,
	ImpDocDeclarationNode,
	ImpDocNode,
	ImpDocValue,
} from '../lib/index.js'
import { getImpDocSymbolData } from '../lib/index.js'

const Owner = 'owner:_index.d'
const Uri = 'file:///data/owner/functions/_index.d.mcfunction'
const EmptyContract: ImpDocContract = {
	inputs: [],
	outputs: [],
	apis: [],
	users: [],
	deprecated: [],
}

function value(raw: string): ImpDocValue {
	return { raw, range: { start: 0, end: raw.length } }
}

function annotation(...tokens: string[]): ImpDocAnnotation {
	const [head, ...rest] = tokens
	const node: ImpDocAnnotation = {
		type: 'impDoc:annotation',
		range: { start: 0, end: 20 },
		value: value(head!),
	}
	if (rest.length) {
		node.children = [annotation(...rest)]
	}
	return node
}

function bindStorage(tokens?: readonly string[]): {
	err: core.ErrorReporter
	node: ImpDocDeclarationNode
	symbol: core.Symbol
} {
	const node: ImpDocDeclarationNode = {
		type: 'impDoc:declaration',
		category: 'storage',
		categoryRange: { start: 40, end: 47 },
		name: { raw: 'owner:data', range: { start: 48, end: 58 } },
		range: { start: 31, end: 58 },
	}
	const annotations = tokens ? [annotation(...tokens)] : []
	const doc: ImpDocNode = {
		type: 'impDoc',
		annotations,
		children: [node],
		contract: EmptyContract,
		declaration: {
			declarations: [node],
			lines: [],
			range: node.range,
		},
		plainText: 'Declaration fixture',
		range: { start: 0, end: 80 },
		raw: '',
	}
	core.AstNode.setParents(doc)

	const symbols = new core.SymbolUtil(core.SymbolTable.link({
		function: {
			[Owner]: { definition: [{ uri: Uri }] },
		},
	} as core.UnlinkedSymbolTable))
	symbols.buildCache()
	const err = new core.ErrorReporter()
	const ctx = {
		doc: {
			uri: Uri,
			languageId: 'mcfunction',
			version: 1,
			lineCount: 1,
			getText: () => '',
			offsetAt: (position: { character: number }) => position.character,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
		},
		err,
		symbols,
	} as unknown as core.BinderContext
	symbols.contributeAs('binder', () => bindDeclaration(node, ctx))
	const symbol = symbols.lookup('storage', ['owner:data']).symbol
	assert.ok(symbol)
	return { err, node, symbol }
}

describe('IMP-Doc declaration binder visibility fallback', () => {
	it('preserves valid variants and defaults annotation-free declarations to public', () => {
		for (
			const [label, tokens, expectedType] of [
				['private', ['@private'], 'private'],
				['internal', ['@internal'], 'internal'],
				['within', ['@within', 'function', 'owner:**'], 'within'],
				['public', ['@public'], 'public'],
				['api', ['@api'], 'public'],
				['no annotation', undefined, 'public'],
			] as const
		) {
			const { err, node, symbol } = bindStorage(tokens)
			assert.equal(getImpDocSymbolData(symbol.data)?.visibility?.type, expectedType, label)
			assert.equal(node.symbol, symbol, label)
			assert.deepEqual(err.errors, [], label)
		}
	})

	it('stamps internal and denied as restricted owner-bearing metadata', () => {
		const internal = bindStorage(['@internal']).symbol
		assert.equal(internal.visibility, 3)
		assert.equal(getImpDocSymbolData(internal.data)?.privateOwner, Owner)
		assert.deepEqual(internal.visibilityRestriction, [
			'^owner:.{0,}$',
			'^minecraft:.{0,}$',
		])

		const denied = bindStorage(['@within', 'unknown_type', 'owner:**']).symbol
		assert.equal(denied.visibility, 3)
		assert.deepEqual(getImpDocSymbolData(denied.data)?.visibility, {
			type: 'denied',
			owner: Owner,
		})
		assert.equal(getImpDocSymbolData(denied.data)?.privateOwner, Owner)
		assert.deepEqual(denied.visibilityRestriction, ['^owner:_index\\.d$'])
	})

	it('fails closed for all malformed @within shapes', () => {
		for (
			const tokens of [
				['@within', 'unknown_type', 'owner:**'],
				['@within'],
				['@within', 'function', 'tag1', 'tag2'],
			]
		) {
			const { err, symbol } = bindStorage(tokens)
			assert.equal(getImpDocSymbolData(symbol.data)?.visibility?.type, 'denied')
			assert.ok(err.errors.some(error =>
				error.message.includes(
					'IMP-Doc visibility annotation is malformed; falling back to deny state',
				)
			))
		}
	})
})
