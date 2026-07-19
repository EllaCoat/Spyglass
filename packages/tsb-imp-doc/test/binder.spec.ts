import * as core from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { bindAlias } from '../lib/binder/alias.js'
import { getCurrentFunctionSymbol } from '../lib/binder/contract.js'
import { checkAlias } from '../lib/checker/impDoc.js'
import {
	bindContract,
	getImpDocSymbolData,
	impDoc,
	type ImpDocAliasNode,
	type ImpDocContract,
	type ImpDocNode,
	stampContract,
} from '../lib/index.js'

const EmptyContract: ImpDocContract = {
	inputs: [],
	outputs: [],
	apis: [],
	users: [],
	deprecated: [],
}

async function parseFixture(): Promise<ImpDocNode> {
	const content = await readFile(
		new URL('./fixtures/12-contract-showcase.mcfunction', import.meta.url),
		'utf8',
	)
	const result = impDoc(
		new core.Source(content),
		{
			err: new core.ErrorReporter(),
		} as Parameters<typeof impDoc>[1],
	)
	assert.notEqual(result, core.Failure)
	return result as ImpDocNode
}

async function parseAliasFixture(): Promise<ImpDocAliasNode[]> {
	const content = await readFile(
		new URL('./fixtures/15-aliases.mcfunction', import.meta.url),
		'utf8',
	)
	const src = new core.Source(content)
	const err = new core.ErrorReporter()
	const aliases: ImpDocAliasNode[] = []
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
		aliases.push(...((result as ImpDocNode).declaration?.aliases ?? []))
	}
	assert.deepEqual(err.errors, [])
	return aliases
}

function getCurrentFunction(symbols: core.SymbolUtil, uri: string) {
	return getCurrentFunctionSymbol({
		doc: { uri } as core.BinderContext['doc'],
		symbols,
	})
}

describe('IMP-Doc contract binder', () => {
	it('binds all alias kinds with serializable, lossless expansions', async () => {
		const aliases = await parseAliasFixture()
		const table = core.SymbolTable.link({})
		const symbols = new core.SymbolUtil(table)
		const err = new core.ErrorReporter()
		const ctx = {
			doc: {
				uri: 'file:///aliases.mcfunction',
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

		symbols.contributeAs('binder', () => {
			for (const alias of aliases) {
				bindAlias(alias, ctx)
			}
		})

		for (const alias of aliases) {
			const symbol = symbols.lookup(
				`alias/${alias.kind}`,
				[alias.name.raw],
			).symbol
			assert.ok(symbol, alias.kind)
			assert.equal(alias.symbol, symbol)
			assert.deepEqual(getImpDocSymbolData(symbol.data)?.alias, {
				kind: alias.kind,
				expansion: alias.value.raw,
			})
			checkAlias(alias, { err } as core.CheckerContext)
		}
		assert.deepEqual(err.errors, [])

		const restored = core.SymbolTable.deserialize(core.SymbolTable.serialize(table))
		assert.deepEqual(
			getImpDocSymbolData(
				restored['alias/selectorTemplate']?.['hostile_selector']?.data,
			)?.alias,
			{
				kind: 'selectorTemplate',
				expansion: '@e[type=#fixture:hostile, distance=..16]',
			},
		)
	})

	it('stores a serializable contract on the current function symbol', async () => {
		const node = await parseFixture()
		core.AstNode.setParents(node)
		const identifier = node.functionID?.raw
		assert.ok(identifier)

		const table = core.SymbolTable.link({
			function: {
				[identifier]: {
					definition: [{ uri: 'file:///contract.mcfunction' }],
				},
			},
		} as core.UnlinkedSymbolTable)
		const symbol = table.function?.[identifier]
		assert.ok(symbol)
		const symbols = new core.SymbolUtil(table)
		symbols.buildCache()
		bindContract(node, {
			doc: {
				uri: 'file:///contract.mcfunction',
			} as core.BinderContext['doc'],
			symbols,
		})

		const stored = getImpDocSymbolData(symbol.data)?.contract
		assert.notEqual(stored, node.contract)
		assert.deepEqual(
			stored?.inputs[0]?.entries[0]?.fields.map(field => [
				field.key.raw,
				field.optional,
				field.valueType?.raw,
			]),
			[
				['Difficulty', false, 'int'],
				['Label', true, 'string | text'],
			],
		)

		const restored = core.SymbolTable.deserialize(core.SymbolTable.serialize(table))
		assert.deepEqual(
			getImpDocSymbolData(restored.function?.[identifier]?.data)?.contract,
			stored,
		)
	})

	it('preserves declaration-only CLI and definition-backed language server lookup', () => {
		const uri = 'file:///contract.mcfunction'
		for (
			const testCase of [
				{ name: 'CLI', usage: 'declaration' as const, expected: undefined },
				{ name: 'language server', usage: 'definition' as const, expected: 'example:contract' },
			]
		) {
			const symbols = new core.SymbolUtil({})
			symbols.contributeAs('uri_binder', () => {
				symbols.query(uri, 'function', 'example:contract').enter({
					usage: { type: testCase.usage },
				})
			})

			assert.equal(
				getCurrentFunction(symbols, uri)?.identifier,
				testCase.expected,
				testCase.name,
			)
		}
	})

	it('falls back to legacy scan for an unindexed table and ambiguous candidates', () => {
		const uri = 'file:///contract.mcfunction'
		const unindexed = new core.SymbolUtil(core.SymbolTable.link({
			function: {
				'example:unindexed': { definition: [{ uri }] },
			},
		} as core.UnlinkedSymbolTable))
		assert.equal(getCurrentFunction(unindexed, uri)?.identifier, 'example:unindexed')

		const symbols = new core.SymbolUtil({})
		symbols.contributeAs('uri_binder', () => {
			// Insert `first` into the function map before `second`.
			symbols.query('file:///other.mcfunction', 'function', 'example:first').enter({
				usage: { type: 'declaration' },
			})
			symbols.query(uri, 'function', 'example:second').enter({
				usage: { type: 'definition' },
			})
			symbols.query(uri, 'function', 'example:first').enter({
				usage: { type: 'definition' },
			})
		})
		const first = symbols.lookup('function', ['example:first']).symbol
		const second = symbols.lookup('function', ['example:second']).symbol
		assert.ok(first)
		assert.ok(second)
		// The public candidate API does not promise parent-map order.
		const candidatesOutOfMapOrder = {
			getSymbolCandidatesAtUri: () => [second, first],
			lookup: symbols.lookup.bind(symbols),
		} as unknown as core.SymbolUtil
		assert.equal(getCurrentFunction(candidatesOutOfMapOrder, uri)?.identifier, 'example:first')
	})

	it('excludes nested function members from current function lookup', () => {
		const uri = 'file:///contract.mcfunction'
		const symbols = new core.SymbolUtil(core.SymbolTable.link({
			function: {
				'example:outer': {
					members: {
						nested: { definition: [{ uri }] },
					},
				},
			},
		} as core.UnlinkedSymbolTable))
		symbols.buildCache()

		assert.deepEqual(
			symbols.getSymbolCandidatesAtUri(uri).map(symbol => symbol.path),
			[['example:outer', 'nested']],
		)
		assert.equal(getCurrentFunction(symbols, uri), undefined)
	})

	it('skips empty contracts and clears a previously stamped contract', async () => {
		const node = await parseFixture()
		const symbol = { data: {} } as core.Symbol

		stampContract(symbol, EmptyContract)
		assert.equal(getImpDocSymbolData(symbol.data)?.contract, undefined)

		stampContract(symbol, node.contract)
		assert.ok(getImpDocSymbolData(symbol.data)?.contract)

		stampContract(symbol, EmptyContract)
		assert.equal(getImpDocSymbolData(symbol.data)?.contract, undefined)
	})
})
