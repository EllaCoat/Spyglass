import * as core from '@spyglassmc/core'
import type {
	ImpDocAnnotation,
	ImpDocContract,
	ImpDocContractEntry,
	ImpDocContractField,
	ImpDocDeclarationBlock,
	ImpDocDeclarationCategory,
	ImpDocDeclarationLine,
	ImpDocDeclarationNode,
	ImpDocExecutorKind,
	ImpDocNode,
	ImpDocValue,
} from '../node/ImpDocNode.js'
import { ImpDocNode as ImpDocNodeUtil } from '../node/ImpDocNode.js'

const DeferredDeclarationCategories = new Set([
	'objective',
	'function',
	'loot_table',
])

const DeclarationNamePatterns: Readonly<Record<ImpDocDeclarationCategory, RegExp>> = {
	tag: /^[0-9A-Za-z_.+-]+$/,
	// `api:` の空 path と namespace 無しの `global` を許可。
	storage: /^(?:[0-9a-z_.-]+:[0-9a-z_./-]*|[0-9a-z_./-]+)$/,
	score_holder: /^\$[0-9A-Za-z_.+^-]+$/,
}

function isDeclarationCategory(
	value: string,
): value is ImpDocDeclarationCategory {
	return value === 'tag'
		|| value === 'storage'
		|| value === 'score_holder'
}

function parseDeclarationLine(
	src: core.Source,
	line: ImpDocDeclarationLine,
	ctx: core.ParserContext,
): ImpDocDeclarationNode | undefined {
	const lineSrc = src.clone()
	lineSrc.cursor = line.range.start
	lineSrc.skipSpace()

	const start = lineSrc.cursor
	if (!lineSrc.trySkip('#declare')) {
		return undefined
	}
	if (!core.Source.isSpace(lineSrc.peek())) {
		// `#declared behavior is ...` 等の `#declare` 前方一致コメントを
		// 誤って diagnostic 化しないよう、 続きが space/newline でなければ
		// silent に non-declaration として扱う。
		return undefined
	}

	lineSrc.skipSpace()
	const categoryStart = lineSrc.cursor
	const category = lineSrc.readUntil(' ', '\t', '\r', '\n')
	const categoryRange = core.Range.create(categoryStart, lineSrc.cursor)

	if (DeferredDeclarationCategories.has(category)) {
		return undefined
	}
	if (!isDeclarationCategory(category)) {
		ctx.err.report(
			`Unrecognized #declare category "${category}"`,
			categoryRange,
		)
		return undefined
	}
	if (!core.Source.isSpace(lineSrc.peek())) {
		ctx.err.report('Malformed #declare line', line.range)
		return undefined
	}

	lineSrc.skipSpace()
	const nameStart = lineSrc.cursor
	const raw = lineSrc.readUntil(' ', '\t', '\r', '\n')
	const name = {
		raw,
		range: core.Range.create(nameStart, lineSrc.cursor),
	}

	if (!DeclarationNamePatterns[category].test(raw)) {
		ctx.err.report(
			'Malformed #declare line',
			raw ? name.range : line.range,
		)
		return undefined
	}

	return {
		type: 'impDoc:declaration',
		range: core.Range.create(start, name.range.end),
		category,
		categoryRange,
		name,
	}
}

function isContinuationLine(src: core.Source): boolean {
	return src.peek() === '#'
		&& (core.Source.isWhitespace(src.peek(1, 1)) || src.peek(1, 1) === '@')
}

function parseAnnotations(
	annotations: ImpDocAnnotation[],
	src: core.Source,
	indent: number,
): void {
	const start = src.cursor
	const raw = src.readUntil(' ', '\r', '\n')
	const annotation: ImpDocAnnotation = {
		type: 'impDoc:annotation',
		range: core.Range.create(start),
		value: { raw, range: core.Range.create(start, src.cursor) },
	}

	if (src.peek() === ' ') {
		src.skipSpace()
		annotation.children = []
		parseAnnotations(annotation.children, src, indent)
	} else {
		while (true) {
			const next = src.clone().nextLine().skipSpace()
			if (next.peek() !== '#') {
				break
			}

			next.skip()
			const indentStart = next.innerCursor
			next.skipSpace()
			const indentEnd = next.innerCursor
			const nextIndent = indentEnd - indentStart
			const additionalIndent = next.string.slice(indentStart + indent, indentEnd)
			if (additionalIndent.replace(/\t/g, '  ').length < 2) {
				break
			}

			src.innerCursor = next.innerCursor
			annotation.children ??= []
			parseAnnotations(annotation.children, src, nextIndent)
		}
	}

	annotation.range.end = src.cursor
	annotations.push(annotation)
}

function valueBetween(
	src: core.Source,
	start: number,
	end: number,
): ImpDocValue {
	return {
		raw: src.slice(start, end),
		range: core.Range.create(start, end),
	}
}

function flattenedValues(annotation: ImpDocAnnotation): ImpDocValue[][] {
	return annotation.children?.length
		? annotation.children.flatMap(child =>
			ImpDocNodeUtil.flattenAnnotations([child], [annotation.value])
		)
		: [[annotation.value]]
}

function contractField(
	src: core.Source,
	values: readonly ImpDocValue[],
): ImpDocContractField[] {
	const keyIndexes = values.flatMap((value, index) => value.raw.endsWith(':') ? [index] : [])
	if (keyIndexes.length === 0) {
		return []
	}

	let child: ImpDocContractField | undefined
	for (let i = keyIndexes.length - 1; i >= 0; i--) {
		const keyIndex = keyIndexes[i]!
		const token = values[keyIndex]!
		const optional = token.raw.endsWith('?:')
		const suffixLength = optional ? 2 : 1
		const key = valueBetween(
			src,
			token.range.start,
			token.range.end - suffixLength,
		)
		const nextKeyIndex = keyIndexes[i + 1]
		const typeValues = nextKeyIndex === undefined
			? values.slice(keyIndex + 1)
			: []
		const end = typeValues.at(-1)?.range.end ?? child?.raw.range.end
			?? token.range.end
		const field: ImpDocContractField = {
			raw: valueBetween(src, token.range.start, end),
			key,
			optional,
			...(typeValues.length
				? {
					valueType: valueBetween(
						src,
						typeValues[0]!.range.start,
						typeValues.at(-1)!.range.end,
					),
				}
				: {}),
			...(child ? { children: [child] } : {}),
		}
		child = field
	}

	return child ? [child] : []
}

function normalizedKind(values: readonly ImpDocValue[]): string {
	const [first, second] = values
	if (!first) {
		return 'unknown'
	}
	if (first.raw === 'as' && second) {
		return `as_${second.raw.replace(/[^0-9A-Za-z_]+/g, '_')}`
	}
	return first.raw
}

function contractChannel(kind: string): ImpDocContractEntry['channel'] {
	if (kind === 'args' || kind === 'storage' || kind === 'score' || kind === 'tag') {
		return kind
	}
	if (kind.startsWith('as_')) {
		return 'executor'
	}
	if (kind === 'result' || kind === 'success') {
		return 'result'
	}
	return 'unknown'
}

function contractEntry(
	src: core.Source,
	direction: ImpDocContractEntry['direction'],
	values: readonly ImpDocValue[],
): ImpDocContractEntry {
	const kind = normalizedKind(values)
	const channel = contractChannel(kind)
	const valueOffset = channel === 'executor' ? 2 : 1
	const fieldValues = values.slice(valueOffset)
	let target: ImpDocValue | undefined
	let path: ImpDocValue | undefined

	if (channel === 'executor') {
		target = values[1]
	} else if (channel === 'storage' || channel === 'score' || channel === 'tag') {
		target = values[1]
		fieldValues.shift()
		if (channel === 'tag' && fieldValues[0] && !fieldValues[0].raw.endsWith(':')) {
			path = fieldValues.shift()
		}
	} else if (channel === 'result') {
		target = values[1]
		fieldValues.shift()
	}

	const first = values[0]
	const last = values.at(-1)
	const fallback = first ?? last!
	return {
		direction,
		channel,
		kind,
		raw: valueBetween(src, fallback.range.start, last?.range.end ?? fallback.range.end),
		...(target ? { target } : {}),
		...(path ? { path } : {}),
		fields: contractField(src, fieldValues),
	}
}

function entriesFor(
	src: core.Source,
	annotation: ImpDocAnnotation,
	direction: ImpDocContractEntry['direction'],
): ImpDocContractEntry[] {
	const entries = flattenedValues(annotation).flatMap(values => {
		const clause = values.slice(1)
		return clause.length ? [contractEntry(src, direction, clause)] : []
	})
	const merged: ImpDocContractEntry[] = []
	for (const entry of entries) {
		const previous = merged.at(-1)
		if (
			previous
			&& previous.kind === entry.kind
			&& previous.target?.raw === entry.target?.raw
			&& previous.path?.raw === entry.path?.raw
		) {
			previous.fields.push(...entry.fields)
			previous.raw = valueBetween(
				src,
				previous.raw.range.start,
				entry.raw.range.end,
			)
		} else {
			merged.push(entry)
		}
	}
	return merged
}

function annotationArgument(
	src: core.Source,
	annotation: ImpDocAnnotation,
): ImpDocValue | undefined {
	const values = flattenedValues(annotation)[0]?.slice(1) ?? []
	return values.length
		? valueBetween(src, values[0]!.range.start, values.at(-1)!.range.end)
		: undefined
}

function parseContract(
	src: core.Source,
	annotations: ImpDocAnnotation[],
): { annotations: ImpDocAnnotation[]; contract: ImpDocContract } {
	const contract: ImpDocContract = {
		inputs: [],
		outputs: [],
		apis: [],
		users: [],
		deprecated: [],
	}
	const typed = annotations.map((annotation): ImpDocAnnotation => {
		switch (annotation.value.raw) {
			case '@input': {
				const entries = entriesFor(src, annotation, 'input')
				const kinds = new Set(entries.map(entry => entry.kind))
				const input = {
					...annotation,
					type: 'impDoc:input' as const,
					...(kinds.size === 1 ? { kind: entries[0]!.kind } : {}),
					entries,
				}
				contract.inputs.push(input)
				return input
			}
			case '@output': {
				const entries = entriesFor(src, annotation, 'output')
				const kinds = new Set(entries.map(entry => entry.kind))
				const output = {
					...annotation,
					type: 'impDoc:output' as const,
					...(kinds.size === 1 ? { kind: entries[0]!.kind } : {}),
					entries,
				}
				contract.outputs.push(output)
				return output
			}
			case '@api': {
				const api = {
					...annotation,
					type: 'impDoc:api' as const,
					audience: 'api' as const,
				}
				contract.apis.push(api)
				return api
			}
			case '@user': {
				const raw = annotationArgument(src, annotation)
				const requested = raw?.raw.replace(/^as\s+/, '')
				const kind: ImpDocExecutorKind = requested === 'player'
						|| requested === 'entity'
						|| requested === 'server'
					? requested
					: raw
					? 'unknown' as const
					: 'player' as const
				const user = {
					...annotation,
					type: 'impDoc:user' as const,
					executor: {
						kind,
						explicit: raw !== undefined,
						...(raw ? { raw } : {}),
					},
				}
				contract.users.push(user)
				return user
			}
			case '@deprecated': {
				const message = annotationArgument(src, annotation)
				const deprecated = {
					...annotation,
					type: 'impDoc:deprecated' as const,
					...(message ? { message } : {}),
				}
				contract.deprecated.push(deprecated)
				return deprecated
			}
			default:
				return annotation
		}
	})
	return { annotations: typed, contract }
}

function readDeclarationLine(
	src: core.Source,
	lineStart: number,
	indent: string,
): ImpDocDeclarationLine {
	src.skipLine()
	return {
		indent,
		range: core.Range.create(lineStart, src.cursor),
		raw: src.slice(lineStart, src.cursor),
	}
}

function parseDeclarationBlock(
	src: core.Source,
	ctx: core.ParserContext,
	lineStart: number,
	indentBeforeLastHash: number,
	indent: string,
): ImpDocDeclarationBlock {
	const lines: ImpDocDeclarationLine[] = []
	const declarations: ImpDocDeclarationNode[] = []
	let commandIndent = indent.length

	const addLine = (start: number, lineIndent: string): void => {
		const line = readDeclarationLine(src, start, lineIndent)
		lines.push(line)
		const declaration = parseDeclarationLine(src, line, ctx)
		if (declaration) {
			declarations.push(declaration)
		}
	}

	addLine(lineStart, indent)

	while (commandIndent - indentBeforeLastHash >= 1 && src.canRead()) {
		const next = src.clone().nextLine()
		const nextLineStart = next.cursor
		const nextIndent = next.readSpace()
		commandIndent = nextIndent.length
		if (commandIndent - indentBeforeLastHash < 1 || !next.canReadInLine()) {
			break
		}
		src.innerCursor = next.innerCursor
		addLine(nextLineStart, nextIndent)
	}

	return {
		declarations,
		lines,
		range: core.Range.create(lines[0].range.start, lines.at(-1)!.range.end),
	}
}

/**
 * Parses one legacy IMP-Doc component beginning with `#>`.
 *
 * The parser deliberately leaves `#declare` semantics to the Phase 1 symbol registrar. It still
 * records the attached declaration block so the original component boundary is preserved.
 */
export const impDoc: core.Parser<ImpDocNode> = (src, ctx) => {
	const originalCursor = src.cursor
	src.skipSpace()
	if (!src.tryPeek('#>')) {
		src.cursor = originalCursor
		return core.Failure
	}

	const start = src.cursor
	const isFunctionDoc = /^\s*$/.test(src.slice(0, start))
	const node: ImpDocNode = {
		type: 'impDoc',
		range: core.Range.create(start),
		annotations: [],
		contract: {
			inputs: [],
			outputs: [],
			apis: [],
			users: [],
			deprecated: [],
		},
		children: [],
		plainText: '',
		raw: '',
	}

	src.skip(2).skipSpace()
	if (isFunctionDoc) {
		const idStart = src.cursor
		const raw = src.readUntil(' ', '\r', '\n')
		node.functionID = { raw, range: core.Range.create(idStart, src.cursor) }
		if (!raw) {
			ctx.err.report("Expected a function ID after '#>'", node.functionID)
		}
	} else {
		node.plainText += src.readLine() + '\n'
	}

	let indentBeforeLastHash = 0
	while (src.canRead()) {
		src.nextLine()
		if (!src.canRead()) {
			break
		}

		const lineStart = src.cursor
		const indent = src.readSpace()
		if (isContinuationLine(src)) {
			indentBeforeLastHash = indent.length
			src.skip()
			const indentStart = src.cursor
			src.skipSpace()
			if (src.peek() === '@') {
				parseAnnotations(node.annotations, src, src.cursor - indentStart)
			} else {
				node.plainText += src.readLine() + '\n'
			}
			continue
		}

		if (src.canReadInLine() && !isFunctionDoc) {
			node.declaration = parseDeclarationBlock(
				src,
				ctx,
				lineStart,
				indentBeforeLastHash,
				indent,
			)
		} else {
			src.skipLine()
		}
		break
	}

	const parsedContract = parseContract(src, node.annotations)
	node.annotations = parsedContract.annotations
	node.contract = parsedContract.contract
	node.range.end = src.cursor
	node.raw = src.slice(start, node.range.end)
	node.children = [
		...node.annotations,
		...(node.declaration?.declarations ?? []),
	]
	return node
}

function overlapsAnyDeclarationLine(
	node: core.AstNode,
	declaration: ImpDocDeclarationBlock | undefined,
): boolean {
	return declaration?.lines.some(line =>
		line.range.start <= node.range.start && node.range.end <= line.range.end
	) ?? false
}

/**
 * Adapts an already configured mcfunction language parser by replacing legacy `#>` comment runs
 * with first-class `ImpDocNode`s while retaining semantic command nodes attached to declaration
 * blocks.
 */
export function extendMcfunctionParser(
	parser: core.Parser<core.AstNode>,
): core.Parser<core.AstNode> {
	return (src, ctx) => {
		const result = parser(src, ctx)
		if (result === core.Failure || !result.children?.length) {
			return result
		}

		const originalChildren = result.children
		const children: core.AstNode[] = []
		for (let i = 0; i < originalChildren.length; i++) {
			const child = originalChildren[i]
			if (child.type !== 'comment' || !src.slice(child).trimStart().startsWith('#>')) {
				children.push(child)
				continue
			}

			const componentSrc = new core.Source(src.string, src.indexMap)
			componentSrc.cursor = child.range.start
			const component = impDoc(componentSrc, ctx)
			if (component === core.Failure) {
				children.push(child)
				continue
			}

			const attachedNodes: core.AstNode[] = []
			while (i + 1 < originalChildren.length) {
				const candidate = originalChildren[i + 1]
				if (candidate.range.start >= component.range.end) {
					break
				}
				i++
				if (overlapsAnyDeclarationLine(candidate, component.declaration)) {
					attachedNodes.push(candidate)
				}
			}
			const bodyNodes = [
				...(component.declaration?.declarations ?? []),
				...attachedNodes,
			].sort((a, b) => a.range.start - b.range.start)
			component.children = [...component.annotations, ...bodyNodes]
			children.push(component)
		}

		result.children = children
		return result
	}
}
