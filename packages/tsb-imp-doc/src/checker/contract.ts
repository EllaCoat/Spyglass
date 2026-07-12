import type { CheckerContext, ErrorSeverity } from '@spyglassmc/core'
import { getContractCheckSeverity } from '../linter/contract.js'
import type {
	ImpDocContractDirection,
	ImpDocContractEntry,
	ImpDocContractField,
	ImpDocNode,
} from '../node/ImpDocNode.js'

/**
 * Legacy fixtures use `boolean` and `text` in addition to the vocabulary in
 * the IMP-Doc migration plan. NBT-shaped container names are accepted because
 * contracts commonly describe nested storage payloads. Union (`A | B`) and
 * array (`A[]`) notation are handled by the validator rather than duplicated
 * in this set. Matching deliberately remains case-sensitive to preserve the
 * canonical lowercase vocabulary used by Legacy IMP-Doc fixtures.
 */
export const KnownContractTypeNames = new Set([
	'any',
	'bool',
	'boolean',
	'byte',
	'compound',
	'double',
	'entities',
	'entity',
	'float',
	'int',
	'integer',
	'list',
	'long',
	'number',
	'object',
	'player',
	'players',
	'short',
	'string',
	'text',
	'uuid',
])

function unknownTypeNames(raw: string): string[] {
	return raw.split('|')
		.map(part => part.trim().replace(/(?:\[\])+$/g, '').trim())
		.filter(name => name.length > 0 && !KnownContractTypeNames.has(name))
}

function visitFields(
	fields: readonly ImpDocContractField[],
	fn: (field: ImpDocContractField, fieldPath: readonly string[]) => void,
	ancestorPath: readonly string[] = [],
): void {
	for (const field of fields) {
		const fieldPath = [...ancestorPath, field.key.raw]
		fn(field, fieldPath)
		visitFields(field.children ?? [], fn, fieldPath)
	}
}

interface SeenField {
	direction: ImpDocContractDirection
	entry: ImpDocContractEntry
	field: ImpDocContractField
}

function fieldIdentity(
	direction: ImpDocContractDirection,
	entry: ImpDocContractEntry,
	fieldPath: readonly string[],
): string {
	return [
		direction,
		entry.channel,
		entry.target?.raw ?? '',
		entry.path?.raw ?? '',
		...fieldPath,
	].join('\0')
}

function crossDirectionIdentity(
	entry: ImpDocContractEntry,
	fieldPath: readonly string[],
): string {
	return [
		entry.channel,
		entry.target?.raw ?? '',
		entry.path?.raw ?? '',
		...fieldPath,
	].join('\0')
}

function normalizedType(field: ImpDocContractField): string | undefined {
	return field.valueType?.raw
		.replace(/\s+/g, '')
		.split('|')
		.map(member => member.trim())
		.filter(Boolean)
		.sort()
		.join('|') || undefined
}

function typesConflict(left: string, right: string): boolean {
	const leftMembers = left.split('|')
	const rightMembers = right.split('|')
	return !leftMembers.includes('any')
		&& !rightMembers.includes('any')
		&& left !== right
}

function reportVocabulary(
	field: ImpDocContractField,
	ctx: CheckerContext,
	severity: ErrorSeverity,
): void {
	if (!field.valueType) {
		return
	}
	const unknown = unknownTypeNames(field.valueType.raw)
	if (unknown.length) {
		ctx.err.report(
			`Unknown IMP-Doc contract type name${unknown.length === 1 ? '' : 's'} “${
				unknown.join(', ')
			}”`,
			field.valueType,
			severity,
		)
	}
}

export function checkContract(node: ImpDocNode, ctx: CheckerContext): void {
	const severity = getContractCheckSeverity(ctx.config)
	if (severity === undefined) {
		return
	}

	const seen = new Map<string, SeenField>()
	const byDirection = {
		input: new Map<string, SeenField>(),
		output: new Map<string, SeenField>(),
	}
	const annotations = [...node.contract.inputs, ...node.contract.outputs]

	for (const annotation of annotations) {
		for (const entry of annotation.entries) {
			visitFields(entry.fields, (field, fieldPath) => {
				reportVocabulary(field, ctx, severity)

				const identity = fieldIdentity(entry.direction, entry, fieldPath)
				if (seen.has(identity)) {
					ctx.err.report(
						`Duplicate @${entry.direction} ${entry.channel} contract key “${field.key.raw}”`,
						field.key,
						severity,
					)
				} else {
					const item = { direction: entry.direction, entry, field }
					seen.set(identity, item)
					byDirection[entry.direction].set(
						crossDirectionIdentity(entry, fieldPath),
						item,
					)
				}
			})
		}
	}

	for (const [identity, input] of byDirection.input) {
		const output = byDirection.output.get(identity)
		const inputType = normalizedType(input.field)
		const outputType = output && normalizedType(output.field)
		if (output && inputType && outputType && typesConflict(inputType, outputType)) {
			ctx.err.report(
				`Conflicting @input/@output ${output.entry.channel} type for key “${output.field.key.raw}”: “${inputType}” versus “${outputType}”`,
				output.field.valueType ?? output.field.raw,
				severity,
			)
		}
	}
}
