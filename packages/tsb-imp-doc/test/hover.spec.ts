import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { formatContractEntry } from '../lib/hover/contract.js'
import type { ImpDocContractEntry, ImpDocContractField } from '../lib/index.js'
import { type ContractRuntime, createContractRuntime } from './contract-runtime.ts'

const range = { start: 0, end: 0 }

describe('IMP-Doc contract hover', () => {
	let runtime: ContractRuntime

	before(async () => {
		runtime = await createContractRuntime()
	})
	after(async () => await runtime.close())

	it('includes function, visibility, and contract summary at a function call', () => {
		const offset = runtime.caller.content.indexOf('contract:target') + 1
		const hover = runtime.service.getHover(
			runtime.caller.node,
			runtime.caller.doc,
			offset,
		)
		assert.ok(hover)
		assert.match(hover.markdown, /\(function\) contract:target/)
		assert.match(hover.markdown, /Visibility:\*\* public/)
		assert.match(
			hover.markdown,
			/contract:target @input args \(Difficulty: int, Label\?: string\) -> @output storage contract: \(Result: bool\)/,
		)
	})

	it('preserves raw multi-token entry heads instead of exposing normalized kinds', () => {
		const entries: ImpDocContractEntry[] = [
			{
				direction: 'input',
				channel: 'executor',
				kind: 'as_player',
				raw: { raw: 'as player', range },
				target: { raw: 'player', range },
				fields: [],
			},
			{
				direction: 'output',
				channel: 'result',
				kind: 'result',
				raw: { raw: 'result datapack is loaded', range },
				target: { raw: 'datapack', range },
				fields: [],
			},
		]
		assert.deepEqual(entries.map(formatContractEntry), [
			'@input as player',
			'@output result datapack is loaded',
		])
	})

	it('includes children when a contract field also has a value type', () => {
		const count: ImpDocContractField = {
			raw: { raw: 'Count: int', range },
			key: { raw: 'Count', range },
			optional: false,
			valueType: { raw: 'int', range },
		}
		const entry: ImpDocContractEntry = {
			direction: 'input',
			channel: 'args',
			kind: 'args',
			raw: { raw: 'args', range },
			fields: [{
				raw: { raw: 'Payload: compound', range },
				key: { raw: 'Payload', range },
				optional: false,
				valueType: { raw: 'compound', range },
				children: [count],
			}],
		}
		assert.equal(
			formatContractEntry(entry),
			'@input args (Payload: compound { Count: int })',
		)
	})
})
