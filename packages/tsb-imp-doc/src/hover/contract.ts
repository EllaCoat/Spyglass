import type {
	ImpDocContract,
	ImpDocContractEntry,
	ImpDocContractField,
	ImpDocVisibility,
} from '../node/ImpDocNode.js'

function formatField(field: ImpDocContractField): string {
	const key = `${field.key.raw}${field.optional ? '?' : ''}`
	const valueType = field.valueType?.raw
	const children = field.children?.length
		? `{ ${field.children.map(formatField).join(', ')} }`
		: undefined
	if (valueType || children) {
		return `${key}: ${[valueType, children].filter(Boolean).join(' ')}`
	}
	return key
}

export function formatContractEntry(entry: ImpDocContractEntry): string {
	// The first raw line preserves multi-token spellings such as `as player`
	// and `result datapack is loaded`; normalized `kind` remains internal.
	const head = entry.raw.raw.split(/\r?\n/, 1)[0] ?? entry.kind
	const fields = entry.fields.length
		? ` (${entry.fields.map(formatField).join(', ')})`
		: ''
	return `@${entry.direction} ${head}${fields}`
}

export function formatContractSummary(contract: ImpDocContract): string | undefined {
	const inputs = contract.inputs.flatMap(input => input.entries)
	const outputs = contract.outputs.flatMap(output => output.entries)
	const inputText = inputs.map(formatContractEntry).join(', ')
	const outputText = outputs.map(formatContractEntry).join(', ')
	if (inputText && outputText) {
		return `${inputText} -> ${outputText}`
	}
	return inputText || outputText || undefined
}

function formatVisibility(visibility: ImpDocVisibility): string {
	switch (visibility.type) {
		case 'public':
			return 'public'
		case 'private':
			return `private (${visibility.owner})`
		case 'within':
			return `within ${visibility.patterns.map(pattern => pattern.raw).join(', ')}`
	}
}

export function formatContractHoverDescription(
	functionID: string,
	visibility: ImpDocVisibility,
	contract: ImpDocContract,
	description: string,
): string {
	const summary = formatContractSummary(contract)
	const semantic = [
		`**Visibility:** ${formatVisibility(visibility)}`,
		...(summary ? [`\`${functionID} ${summary}\``] : []),
	].join('\n\n')
	return description ? `${semantic}\n\n${description}` : semantic
}
