import * as core from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { checkContract } from '../lib/checker/contract.js'
import {
	impDoc,
	type ImpDocContractEntry,
	type ImpDocContractField,
	type ImpDocNode,
	type ImpDocValue,
} from '../lib/index.js'
import { contractConfigValidator } from '../lib/linter/contract.js'

function value(raw: string): ImpDocValue {
	return { raw, range: { start: 0, end: raw.length } }
}

function field(
	key: string,
	valueType?: string,
	children?: ImpDocContractField[],
): ImpDocContractField {
	return {
		raw: value(`${key}${valueType ? `: ${valueType}` : ':'}`),
		key: value(key),
		optional: false,
		...(valueType ? { valueType: value(valueType) } : {}),
		...(children ? { children } : {}),
	}
}

function entry(
	direction: 'input' | 'output',
	channel: ImpDocContractEntry['channel'],
	fields: ImpDocContractField[],
	target?: string,
	path?: string,
): ImpDocContractEntry {
	return {
		direction,
		channel,
		kind: channel,
		raw: value([channel, target, path].filter(Boolean).join(' ')),
		...(target ? { target: value(target) } : {}),
		...(path ? { path: value(path) } : {}),
		fields,
	}
}

function contractNode(entries: ImpDocContractEntry[]): ImpDocNode {
	const annotation = (direction: 'input' | 'output') => ({
		type: `impDoc:${direction}`,
		range: { start: 0, end: 0 },
		value: value(`@${direction}`),
		entries: entries.filter(entry => entry.direction === direction),
	})
	return {
		type: 'impDoc',
		range: { start: 0, end: 0 },
		annotations: [],
		contract: {
			inputs: [annotation('input')],
			outputs: [annotation('output')],
			apis: [],
			users: [],
			deprecated: [],
		},
		plainText: '',
		raw: '',
	} as ImpDocNode
}

async function parseFixture(name: string): Promise<ImpDocNode> {
	const content = await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
	const result = impDoc(
		new core.Source(content),
		{
			err: new core.ErrorReporter(),
		} as Parameters<typeof impDoc>[1],
	)
	assert.notEqual(result, core.Failure)
	return result as ImpDocNode
}

function diagnostics(
	node: ImpDocNode,
	level: 'off' | 'information' | 'warning' | 'error',
): readonly core.LanguageError[] {
	const err = new core.ErrorReporter()
	const config = core.ConfigService.merge(core.VanillaConfig, {
		lint: { impDocContractCheck: level },
	})
	checkContract(node, { config, err } as core.CheckerContext)
	return err.errors
}

describe('IMP-Doc contract checker', () => {
	it('accepts known scalar, union, nested, and array vocabulary', async () => {
		const showcase = await parseFixture('12-contract-showcase.mcfunction')
		assert.deepEqual(diagnostics(showcase, 'error'), [])

		const invalid = await parseFixture('13-contract-semantics-invalid.mcfunction')
		const messages = diagnostics(invalid, 'error').map(error => error.message)
		assert.equal(messages.filter(message => message.includes('Unknown')).length, 1)
		assert.ok(messages.some(message => message.includes('dragon')))
		assert.ok(!messages.some(message => message.includes('player[]')))
	})

	it('reports duplicate keys and input/output type conflicts', async () => {
		const node = await parseFixture('13-contract-semantics-invalid.mcfunction')
		const errors = diagnostics(node, 'warning')
		assert.equal(errors.length, 3)
		assert.ok(errors.some(error => error.message.includes('Duplicate @input args')))
		assert.ok(errors.some(error => error.message.includes('Conflicting @input/@output args')))
	})

	it('gates all checks at the configured four severity levels', async () => {
		const node = await parseFixture('13-contract-semantics-invalid.mcfunction')
		assert.equal(diagnostics(node, 'off').length, 0)
		for (
			const [level, severity] of [
				['information', core.ErrorSeverity.Information],
				['warning', core.ErrorSeverity.Warning],
				['error', core.ErrorSeverity.Error],
			] as const
		) {
			const errors = diagnostics(node, level)
			assert.equal(errors.length, 3)
			assert.ok(errors.every(error => error.severity === severity))
		}
	})

	it('distinguishes storage roots, entry paths, and ancestor field paths', () => {
		const node = contractNode([
			entry('input', 'storage', [field('Value', 'int')], 'storage:a'),
			entry('input', 'storage', [field('Value', 'int')], 'storage:b'),
			entry('input', 'storage', [field('Value', 'int')], 'storage:a', 'RootA'),
			entry('input', 'storage', [field('Value', 'int')], 'storage:a', 'RootB'),
			entry('input', 'storage', [
				field('Payload', undefined, [field('Count', 'int')]),
				field('Metadata', undefined, [field('Count', 'string')]),
				field('Count', 'bool'),
			], 'storage:nested'),
			entry('output', 'storage', [field('Value', 'string')], 'storage:out'),
		])
		assert.deepEqual(diagnostics(node, 'error'), [])
	})

	it('still reports true duplicates and matching-root cross-direction conflicts', () => {
		const node = contractNode([
			entry('input', 'storage', [field('Value', 'int')], 'storage:same'),
			entry('input', 'storage', [field('Value', 'int')], 'storage:same'),
			entry('input', 'storage', [field('Result', 'int')], 'storage:shared', 'Data'),
			entry('output', 'storage', [field('Result', 'string')], 'storage:shared', 'Data'),
		])
		const messages = diagnostics(node, 'error').map(error => error.message)
		assert.equal(messages.filter(message => message.includes('Duplicate')).length, 1)
		assert.equal(messages.filter(message => message.includes('Conflicting')).length, 1)
	})

	it('canonicalizes union whitespace and order and treats any as compatible', () => {
		const node = contractNode([
			entry('input', 'args', [
				field('Whitespace', 'string|text'),
				field('Order', 'string|text'),
				field('Wildcard', 'any'),
			]),
			entry('output', 'args', [
				field('Whitespace', 'string | text'),
				field('Order', 'text|string'),
				field('Wildcard', 'int'),
			]),
		])
		assert.deepEqual(diagnostics(node, 'error'), [])
	})

	it('reports invalid impDocContractCheck values through config validation', () => {
		const messages: string[] = []
		const logger: core.Logger = {
			error: message => messages.push(String(message)),
			info: () => {},
			log: () => {},
			warn: () => {},
		}
		for (const invalid of ['warn', 'ERROR', 'typo', ['warning']]) {
			assert.equal(
				contractConfigValidator('impDocContractCheck', invalid, logger),
				false,
			)
		}
		assert.equal(messages.length, 4)
		assert.ok(messages.every(message => message.includes('Expected one of')))
		assert.equal(
			contractConfigValidator('impDocContractCheck', true, logger),
			true,
		)
		assert.equal(
			contractConfigValidator('impDocContractCheck', 'off', logger),
			true,
		)
	})
})
