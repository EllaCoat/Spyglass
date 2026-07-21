import * as core from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { declaration as bindDeclaration } from '../lib/binder/declaration.js'
import type {
	ImpDocAnnotation,
	ImpDocContract,
	ImpDocDeclarationNode,
	ImpDocNode,
	ImpDocValue,
} from '../lib/index.js'
import {
	canonicalizeLegacyDeclarationSymbolName,
	getCanonicalSymbolCategory,
	getImpDocSymbolData,
	impDoc,
	LEGACY_DECLARABLE_TYPES,
	matchesAnyVisibility,
} from '../lib/index.js'

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

/** Declaration path stores visibility per entry; read the (sorted) first one. */
function declaredVisibility(symbol: core.Symbol) {
	return getImpDocSymbolData(symbol.data)?.declarations?.[0]?.visibility
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

function bindStorage(
	tokens?: readonly string[],
	options: { functionID?: string; registerOwner?: boolean } = {},
): {
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
			aliases: [],
			lines: [],
			range: node.range,
		},
		plainText: 'Declaration fixture',
		range: { start: 0, end: 80 },
		raw: '',
		...(options.functionID ? { functionID: value(options.functionID) } : {}),
	}
	core.AstNode.setParents(doc)

	const table = options.registerOwner === false
		? {} as core.UnlinkedSymbolTable
		: {
			function: {
				[Owner]: { definition: [{ uri: Uri }] },
			},
		} as core.UnlinkedSymbolTable
	const symbols = new core.SymbolUtil(core.SymbolTable.link(table))
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

async function bindFixture(name: string): Promise<{
	err: core.ErrorReporter
	declarations: ImpDocDeclarationNode[]
	symbols: core.SymbolUtil
}> {
	const content = await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
	const src = new core.Source(content)
	const err = new core.ErrorReporter()
	const docs: ImpDocNode[] = []
	while (src.canRead()) {
		src.skipWhitespace()
		if (!src.canRead()) {
			break
		}
		const result = impDoc(
			src,
			{ err } as Parameters<typeof impDoc>[1],
		)
		assert.notEqual(result, core.Failure)
		const doc = result as ImpDocNode
		core.AstNode.setParents(doc)
		docs.push(doc)
	}

	const symbols = new core.SymbolUtil(core.SymbolTable.link({
		function: {
			'fixture:_index.d': { definition: [{ uri: Uri }] },
		},
	} as core.UnlinkedSymbolTable))
	symbols.buildCache()
	const ctx = {
		doc: {
			uri: Uri,
			languageId: 'mcfunction',
			version: 1,
			lineCount: content.split(/\r?\n/u).length,
			getText: () => content,
			offsetAt: (position: { character: number }) => position.character,
			positionAt: (offset: number) => ({ line: 0, character: offset }),
		},
		err,
		symbols,
	} as unknown as core.BinderContext
	const declarations = docs.flatMap(doc => doc.declaration?.declarations ?? [])
	symbols.contributeAs('binder', () => {
		for (const node of declarations) {
			bindDeclaration(node, ctx)
		}
	})
	return { err, declarations, symbols }
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
			assert.equal(declaredVisibility(symbol)?.type, expectedType, label)
			assert.equal(node.symbol, symbol, label)
			assert.deepEqual(err.errors, [], label)
		}
	})

	it('binds #declare and #define to one symbol for every legacy category', async () => {
		const { declarations, err, symbols } = await bindFixture(
			'14-declaration-parity.mcfunction',
		)
		assert.deepEqual(err.errors, [])
		assert.equal(declarations.length, LEGACY_DECLARABLE_TYPES.length * 2)

		for (const spec of LEGACY_DECLARABLE_TYPES) {
			const nodes = declarations.filter(node => node.category === spec.id)
			assert.equal(nodes.length, 2, spec.id)
			const name = canonicalizeLegacyDeclarationSymbolName(
				spec.id,
				nodes[0]!.name.raw,
			)!
			const symbol = symbols
				.lookup(getCanonicalSymbolCategory(spec.id), [name])
				.symbol
			assert.ok(symbol, spec.id)
			assert.equal(nodes[0]?.symbol, symbol, spec.id)
			assert.equal(nodes[1]?.symbol, symbol, spec.id)
			assert.equal(symbol.declaration?.length, 2, spec.id)
		}

		// `sequence` declarations consolidate into the canonical
		// `random_sequence` table; no duplicate symbol stays behind in the
		// legacy `sequence` table.
		assert.ok(symbols.lookup('random_sequence', ['minecraft:Sequence.One']).symbol)
		assert.equal(
			symbols.lookup('random_sequence', ['Sequence.One']).symbol,
			undefined,
		)
		assert.equal(
			symbols.lookup('sequence', ['Sequence.One']).symbol,
			undefined,
		)
	})

	it('characterizes namespaced, bossbar/storage, entity-like, and plain families', async () => {
		const { declarations, err, symbols } = await bindFixture(
			'17-declaration-families.mcfunction',
		)
		assert.deepEqual(err.errors, [])
		assert.deepEqual(
			declarations.map(node => [node.category, node.name.raw]),
			[
				['function', 'minecraft:fixture/run'],
				['bossbar', 'fixture:bossbar'],
				['storage', 'fixture:storage'],
				['entity', 'Entity.One'],
				['score_holder', '$Score.Holder'],
				['objective', 'Objective.One'],
				['tag', 'Tag.One'],
				['team', 'Team.One'],
				['sequence', 'Sequence.One'],
				['storage', 'fixture:storage'],
			],
		)

		for (const node of declarations) {
			const name = canonicalizeLegacyDeclarationSymbolName(
				node.category,
				node.name.raw,
			)!
			assert.equal(
				node.symbol,
				symbols
					.lookup(getCanonicalSymbolCategory(node.category), [name])
					.symbol,
				node.category,
			)
		}
		assert.equal(
			declarations[2]?.symbol,
			declarations.at(-1)?.symbol,
			'#define must resolve to the same storage symbol as #declare',
		)
	})

	it('binds permissive non-namespaced IDs from a doc adjacent to the function header', async () => {
		const { declarations, err, symbols } = await bindFixture(
			'18-adjacent-declaration-doc.mcfunction',
		)
		const expected = [
			['score_holder', 'RW.TargetModel'],
			['entity', '@s'],
			['tag', 'foo/bar'],
		] as const

		assert.deepEqual(err.errors, [])
		assert.deepEqual(
			declarations.map(node => [node.category, node.name.raw]),
			expected,
		)
		for (const [index, [category, name]] of expected.entries()) {
			const symbol = symbols.lookup(category, [name]).symbol
			assert.ok(symbol, `${category}:${name}`)
			assert.equal(declarations[index]?.symbol, symbol)
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
		assert.deepEqual(declaredVisibility(denied), {
			type: 'denied',
			owner: Owner,
		})
		assert.equal(getImpDocSymbolData(denied.data)?.privateOwner, Owner)
		assert.deepEqual(denied.visibilityRestriction, ['^owner:_index\\.d$'])
	})

	it('canonicalizes a short header used as the declaration owner fallback', () => {
		const { err, symbol } = bindStorage(
			['@private'],
			{ functionID: 'foo', registerOwner: false },
		)
		assert.deepEqual(declaredVisibility(symbol), {
			type: 'private',
			owner: 'minecraft:foo',
		})
		assert.equal(
			getImpDocSymbolData(symbol.data)?.declarations?.[0]?.owner,
			'minecraft:foo',
		)
		assert.deepEqual(err.errors, [])
	})

	it('keeps every declaration visibility and matches callers against their union', () => {
		const uriA = 'file:///data/a/functions/_index.d.mcfunction'
		const uriB = 'file:///data/b/functions/_index.d.mcfunction'
		const symbols = new core.SymbolUtil(core.SymbolTable.link({
			function: {
				'a:_index.d': { definition: [{ uri: uriA }] },
				'b:_index.d': { definition: [{ uri: uriB }] },
			},
		} as core.UnlinkedSymbolTable))
		symbols.buildCache()
		const err = new core.ErrorReporter()

		const bindFrom = (uri: string, pattern: string) => {
			const node: ImpDocDeclarationNode = {
				type: 'impDoc:declaration',
				category: 'function',
				categoryRange: { start: 40, end: 48 },
				name: { raw: 'shared:target', range: { start: 49, end: 62 } },
				range: { start: 31, end: 62 },
			}
			const doc: ImpDocNode = {
				type: 'impDoc',
				annotations: [annotation('@within', 'function', pattern)],
				children: [node],
				contract: EmptyContract,
				declaration: {
					declarations: [node],
					aliases: [],
					lines: [],
					range: node.range,
				},
				plainText: 'Union fixture',
				range: { start: 0, end: 80 },
				raw: '',
			}
			core.AstNode.setParents(doc)
			const ctx = {
				doc: {
					uri,
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
		}

		bindFrom(uriA, 'a:**')
		bindFrom(uriB, 'b:**')

		const symbol = symbols.lookup('function', ['shared:target']).symbol
		assert.ok(symbol)
		const data = getImpDocSymbolData(symbol.data)
		assert.deepEqual(
			data?.declarations?.map(entry => [entry.uri, entry.owner]),
			[
				[uriA, 'a:_index.d'],
				[uriB, 'b:_index.d'],
			],
		)
		assert.equal(symbol.visibility, 3)
		assert.deepEqual(symbol.visibilityRestriction, ['^a:.{0,}$', '^b:.{0,}$'])
		assert.equal(matchesAnyVisibility(data, 'a:caller'), true)
		assert.equal(matchesAnyVisibility(data, 'b:caller'), true)
		assert.equal(matchesAnyVisibility(data, 'c:caller'), false)
		assert.deepEqual(err.errors, [])
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
			assert.equal(declaredVisibility(symbol)?.type, 'denied')
			assert.ok(err.errors.some(error =>
				error.message.includes(
					'IMP-Doc visibility annotation is malformed; falling back to deny state',
				)
			))
		}
	})
})
