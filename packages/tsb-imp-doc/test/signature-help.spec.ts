import * as core from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
	contractSignatureHelpProvider,
	registerContractSignatureHelpProvider,
} from '../lib/signatureHelp/contract.js'
import { type ContractRuntime, createContractRuntime } from './contract-runtime.ts'

function context(runtime: ContractRuntime, offset: number): core.SignatureHelpProviderContext {
	return core.SignatureHelpProviderContext.create(runtime.service.project, {
		doc: runtime.caller.doc,
		offset,
	})
}

function referenceFile(
	commandName: string | undefined,
	isTag = false,
): { file: core.FileNode<core.AstNode>; offset: number } {
	const reference: core.ResourceLocationNode = {
		type: 'resource_location',
		range: { start: 10, end: 25 },
		options: { category: 'function', allowTag: true },
		isTag,
		namespace: 'contract',
		path: ['target'],
	}
	const referenceParent: core.AstNode = {
		type: 'mcfunction:command_child',
		range: { ...reference.range },
		children: [reference],
		path: commandName === 'function'
			? ['function', 'name']
			: ['schedule', 'function', 'name'],
	} as core.AstNode
	const root = commandName
		? {
			type: 'mcfunction:command',
			range: { start: 0, end: 25 },
			options: {},
			children: [
				{
					type: 'mcfunction:command_child',
					range: { start: 0, end: commandName.length },
					children: [],
					path: [commandName],
				},
				referenceParent,
			],
		}
		: {
			type: 'other-language:reference',
			range: { start: 0, end: 25 },
			children: [reference],
		}
	const file = {
		type: 'file',
		range: { start: 0, end: 25 },
		children: [root],
	} as unknown as core.FileNode<core.AstNode>
	core.AstNode.setParents(file)
	return { file, offset: reference.range.start + 1 }
}

describe('IMP-Doc contract signature help', () => {
	let runtime: ContractRuntime

	before(async () => {
		runtime = await createContractRuntime()
	})
	after(async () => await runtime.close())

	it('returns @input args at the ID end, after a space, and at an opening parenthesis', () => {
		const lines = runtime.caller.content.split('\n')
		const target = 'contract:target'
		const lineStarts = lines.slice(0, 3).map(line => runtime.caller.content.indexOf(line!))
		const offsets = [
			lineStarts[0]! + lines[0]!.indexOf(target) + target.length,
			lineStarts[1]! + lines[1]!.indexOf(target) + target.length + 1,
			lineStarts[2]! + lines[2]!.indexOf('('),
		]
		for (const offset of offsets) {
			const help = runtime.service.getSignatureHelp(
				runtime.caller.node,
				runtime.caller.doc,
				offset,
			)
			assert.ok(help)
			const signature = help.signatures[0]
			assert.equal(
				signature?.label,
				'contract:target(Difficulty: int, Label?: string)',
			)
			assert.deepEqual(
				signature?.parameters.map(parameter =>
					signature.label.slice(parameter.label[0], parameter.label[1])
				),
				['Difficulty: int', 'Label?: string'],
			)
			assert.match(signature?.documentation ?? '', /@input args/)
		}
	})

	it('rejects schedule, tag, and non-mcfunction function references', () => {
		for (
			const fixture of [
				referenceFile('schedule'),
				referenceFile('function', true),
				referenceFile(undefined),
			]
		) {
			assert.equal(
				contractSignatureHelpProvider(
					fixture.file,
					context(runtime, fixture.offset),
				),
				undefined,
			)
		}
	})

	it('keeps the contract provider first across initializer orders and later registrations', () => {
		const genericA: core.SignatureHelpProvider = () => undefined
		const genericB: core.SignatureHelpProvider = () => undefined

		const javaFirst = new core.MetaRegistry()
		javaFirst.registerSignatureHelpProvider(genericA)
		const exposedProviders = javaFirst.signatureHelpProviders
		registerContractSignatureHelpProvider(javaFirst)
		javaFirst.registerSignatureHelpProvider(genericB)
		assert.strictEqual(javaFirst.signatureHelpProviders, exposedProviders)
		assert.deepEqual(
			[...javaFirst.signatureHelpProviders],
			[contractSignatureHelpProvider, genericA, genericB],
		)

		const contractFirst = new core.MetaRegistry()
		registerContractSignatureHelpProvider(contractFirst)
		contractFirst.registerSignatureHelpProvider(genericA)
		assert.deepEqual(
			[...contractFirst.signatureHelpProviders],
			[contractSignatureHelpProvider, genericA],
		)
	})
})
