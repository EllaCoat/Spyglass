import * as core from '@spyglassmc/core'
import { formatContractSummary } from '../hover/contract.js'
import type { ImpDocContractField } from '../node/ImpDocNode.js'
import { getImpDocSymbolData } from '../node/ImpDocNode.js'

function getFunctionReference(
	file: core.DeepReadonly<core.AstNode>,
	offset: number,
): core.DeepReadonly<core.ResourceLocationNode> | undefined {
	for (const needle of [offset, offset - 1]) {
		if (needle < 0) {
			continue
		}
		const node = core.AstNode.findDeepestChild({
			node: file as core.AstNode,
			needle,
			endInclusive: true,
		})
		const reference = node && findFunctionReferenceAncestor(node)
		if (reference) {
			return reference
		}
	}
	return undefined
}

function findFunctionReferenceAncestor(
	node: core.DeepReadonly<core.AstNode>,
): core.DeepReadonly<core.ResourceLocationNode> | undefined {
	let ancestor: core.DeepReadonly<core.AstNode> | undefined = node
	while (ancestor) {
		if (
			core.ResourceLocationNode.is(ancestor as core.AstNode)
			&& (ancestor as core.ResourceLocationNode).options.category === 'function'
		) {
			const reference = ancestor as core.DeepReadonly<core.ResourceLocationNode>
			return !reference.isTag && isDirectFunctionCommand(reference)
				? reference
				: undefined
		}
		ancestor = ancestor.parent
	}
	return undefined
}

interface CommandChildNode extends core.AstNode {
	type: 'mcfunction:command_child'
	path: string[]
}

function isDirectFunctionCommand(
	reference: core.DeepReadonly<core.ResourceLocationNode>,
): boolean {
	let ancestor = reference.parent
	while (ancestor && ancestor.type !== 'mcfunction:command') {
		ancestor = ancestor.parent
	}
	if (!ancestor) {
		return false
	}
	const commandName = (ancestor.children?.[0] as CommandChildNode | undefined)
		?.path[0]
	return commandName === 'function'
}

function parameterText(field: ImpDocContractField): string {
	return `${field.key.raw}${field.optional ? '?' : ''}: ${field.valueType?.raw ?? 'any'}`
}

export const contractSignatureHelpProvider: core.SignatureHelpProvider = (file, ctx) => {
	const reference = getFunctionReference(file, ctx.offset)
	if (!reference) {
		return undefined
	}

	const identifier = core.ResourceLocationNode.toString(
		reference as core.ResourceLocationNode,
		'full',
	)
	const symbol = ctx.symbols.lookup('function', [identifier]).symbol
	const contract = getImpDocSymbolData(symbol?.data)?.contract
	if (!contract) {
		return undefined
	}

	const argsEntries = contract.inputs.flatMap(input =>
		input.entries.filter(entry => entry.channel === 'args')
	)
	if (argsEntries.length === 0) {
		return undefined
	}

	const fields = argsEntries.flatMap(entry => entry.fields)
	let label = `${identifier}(`
	const parameters: core.ParameterInfo[] = []
	for (const [index, field] of fields.entries()) {
		if (index > 0) {
			label += ', '
		}
		const start = label.length
		label += parameterText(field)
		parameters.push({ label: [start, label.length] })
	}
	label += ')'

	return {
		activeSignature: 0,
		signatures: [{
			label,
			activeParameter: 0,
			parameters,
			documentation: formatContractSummary(contract),
		}],
	}
}

/** Register ahead of Java Edition's generic command-tree signature provider. */
export function registerContractSignatureHelpProvider(meta: core.MetaRegistry): void {
	const providers = meta.signatureHelpProviders
	// MetaRegistry currently exposes its insertion-ordered Set by identity. The
	// regression test pins this contract because a defensive-copy getter would
	// make this reordering ineffective.
	const existing = [...providers]
	providers.clear()
	meta.registerSignatureHelpProvider(contractSignatureHelpProvider)
	for (const provider of existing) {
		meta.registerSignatureHelpProvider(provider)
	}
}
