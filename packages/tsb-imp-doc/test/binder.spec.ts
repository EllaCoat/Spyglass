import * as core from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import {
	bindContract,
	getImpDocSymbolData,
	impDoc,
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

describe('IMP-Doc contract binder', () => {
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
		bindContract(node, {
			doc: {
				uri: 'file:///contract.mcfunction',
			} as core.BinderContext['doc'],
			symbols: {
				lookup: () => ({ parentMap: table.function }),
			} as unknown as core.SymbolUtil,
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
