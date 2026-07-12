import type { BinderContext, Symbol } from '@spyglassmc/core'
import type {
	ImpDocAnnotationBase,
	ImpDocContract,
	ImpDocContractEntry,
	ImpDocContractField,
	ImpDocNode,
	ImpDocSymbolData,
	ImpDocValue,
} from '../node/ImpDocNode.js'
import { getImpDocSymbolData } from '../node/ImpDocNode.js'

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: {}
}

function cloneValue(value: ImpDocValue): ImpDocValue {
	return { raw: value.raw, range: { ...value.range } }
}

function cloneField(field: ImpDocContractField): ImpDocContractField {
	return {
		raw: cloneValue(field.raw),
		key: cloneValue(field.key),
		optional: field.optional,
		...(field.valueType ? { valueType: cloneValue(field.valueType) } : {}),
		...(field.children?.length
			? { children: field.children.map(cloneField) }
			: {}),
	}
}

function cloneEntry(entry: ImpDocContractEntry): ImpDocContractEntry {
	return {
		direction: entry.direction,
		channel: entry.channel,
		kind: entry.kind,
		raw: cloneValue(entry.raw),
		...(entry.target ? { target: cloneValue(entry.target) } : {}),
		...(entry.path ? { path: cloneValue(entry.path) } : {}),
		fields: entry.fields.map(cloneField),
	}
}

function cloneAnnotationBase(annotation: ImpDocAnnotationBase) {
	return {
		range: { ...annotation.range },
		value: cloneValue(annotation.value),
	}
}

/**
 * Copy only the semantic contract view into Symbol.data. Parser nodes have
 * parent links after parsing, so retaining the original annotation objects
 * would make SymbolTable serialization cyclic.
 */
export function cloneContract(contract: ImpDocContract): ImpDocContract {
	return {
		inputs: contract.inputs.map(input => ({
			...cloneAnnotationBase(input),
			type: 'impDoc:input',
			...(input.kind ? { kind: input.kind } : {}),
			entries: input.entries.map(cloneEntry),
		})),
		outputs: contract.outputs.map(output => ({
			...cloneAnnotationBase(output),
			type: 'impDoc:output',
			...(output.kind ? { kind: output.kind } : {}),
			entries: output.entries.map(cloneEntry),
		})),
		apis: contract.apis.map(api => ({
			...cloneAnnotationBase(api),
			type: 'impDoc:api',
			audience: 'api',
		})),
		users: contract.users.map(user => ({
			...cloneAnnotationBase(user),
			type: 'impDoc:user',
			executor: {
				kind: user.executor.kind,
				explicit: user.executor.explicit,
				...(user.executor.raw
					? { raw: cloneValue(user.executor.raw) }
					: {}),
			},
		})),
		deprecated: contract.deprecated.map(deprecated => ({
			...cloneAnnotationBase(deprecated),
			type: 'impDoc:deprecated',
			...(deprecated.message
				? { message: cloneValue(deprecated.message) }
				: {}),
		})),
	}
}

export function getCurrentFunctionSymbol(
	ctx: Pick<BinderContext, 'doc' | 'symbols'>,
): Symbol | undefined {
	const functions = ctx.symbols.lookup('function', []).parentMap
	for (const symbol of Object.values(functions ?? {})) {
		if (
			symbol
			&& symbol.definition?.some(location => location.uri === ctx.doc.uri)
		) {
			return symbol
		}
	}
	return undefined
}

export function stampContract(symbol: Symbol, contract: ImpDocContract): void {
	if (isEmptyContract(contract)) {
		clearContract(symbol)
		return
	}
	const root = asRecord(symbol.data)
	const impDoc: ImpDocSymbolData = {
		...getImpDocSymbolData(symbol.data),
		contract: cloneContract(contract),
	}
	symbol.data = { ...root, impDoc }
}

function isEmptyContract(contract: ImpDocContract): boolean {
	return contract.inputs.length + contract.outputs.length + contract.apis.length
			+ contract.users.length + contract.deprecated.length === 0
}

export function clearContract(symbol: Symbol): void {
	const root = asRecord(symbol.data)
	const previous = getImpDocSymbolData(symbol.data)
	if (!previous?.contract) {
		return
	}

	const impDoc: ImpDocSymbolData = { ...previous }
	delete impDoc.contract
	if (Object.keys(impDoc).length === 0) {
		delete root.impDoc
	} else {
		root.impDoc = impDoc
	}
	symbol.data = root
}

export function bindContract(
	node: ImpDocNode,
	ctx: Pick<BinderContext, 'doc' | 'symbols'>,
	symbol = getCurrentFunctionSymbol(ctx),
): void {
	if (
		symbol
		&& node.functionID?.raw === symbol.identifier
	) {
		stampContract(symbol, node.contract)
	}
}
