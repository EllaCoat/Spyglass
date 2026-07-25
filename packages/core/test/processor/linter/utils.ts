import assert from 'node:assert/strict'
import type {
	LanguageError,
	LinterContext,
	MetaRegistry,
	PairNode,
	Quote,
	Range as RangeType,
	RecordBaseNode,
	StringBaseNode,
} from '../../../lib/index.js'
import {
	AstNode,
	BrigadierStringOptions,
	ErrorSeverity,
	LinterErrorReporter,
	Logger,
	Range,
	ReadonlySource,
	StateProxy,
} from '../../../lib/index.js'

/**
 * The nodes in these specs are built by hand on purpose: the rules under test dispatch on node
 * types that belong to `@spyglassmc/mcfunction`, `@spyglassmc/java-edition`, and
 * `@spyglassmc/nbt`, all of which depend on core and therefore cannot be imported here.
 */

/**
 * Runs the linter registered under `ruleName` against `node` and returns the reported errors.
 */
export function lint(
	meta: MetaRegistry,
	ruleName: string,
	ruleValue: unknown,
	node: AstNode,
	src: string,
): readonly LanguageError[] {
	const err = new LinterErrorReporter(ruleName, ErrorSeverity.Warning)
	const ctx = {
		err,
		logger: Logger.noop(),
		ruleName,
		ruleValue,
		src: new ReadonlySource(src),
	} as unknown as LinterContext
	meta.getLinter(ruleName).linter(StateProxy.create(node), ctx)
	return err.dump()
}

export function matches(meta: MetaRegistry, ruleName: string, node: AstNode): boolean {
	return !!meta.getLinter(ruleName).nodePredicate(node)
}

/**
 * @returns The single edit that the quick fix of `error` is made of.
 */
export function editOf(error: LanguageError): { range: RangeType; text: string } {
	const change = error.info?.codeAction?.changes?.[0]
	assert.ok(change?.type === 'edit', 'Expected the quick fix to contain an edit')
	return { range: { start: change.range.start, end: change.range.end }, text: change.text }
}

export function titleOf(error: LanguageError): string | undefined {
	return error.info?.codeAction?.title
}

export interface StringNodeOptions {
	/** Defaults to `'string'`. */
	type?: string
	value: string
	/** When given, the node is a quoted string opened by this quotation mark. */
	quote?: Quote
}

/**
 * @returns The source text that a string node built from `options` would span.
 */
export function rawOf({ value, quote }: StringNodeOptions): string {
	const escaped = value.replace(/[\\'"]/g, (c) => (c === '\\' || c === quote ? `\\${c}` : c))
	return quote ? `${quote}${escaped}${quote}` : value
}

function stringNodeAt(options: StringNodeOptions, start: number): StringBaseNode {
	return {
		type: options.type ?? 'string',
		range: Range.create(start, start + rawOf(options).length),
		options: BrigadierStringOptions,
		value: options.value,
		valueMap: [],
		...(options.quote ? { quote: options.quote } : {}),
	} as unknown as StringBaseNode
}

/**
 * @returns A string node, along with the source that the node spans.
 */
export function stringNode(options: StringNodeOptions): { node: StringBaseNode; src: string } {
	return { node: stringNodeAt(options, 0), src: rawOf(options) }
}

export interface RecordNodeOptions {
	/** e.g. `'nbt:compound'` */
	type: string
	/** The opening and closing brackets. Defaults to `'[]'`. */
	brackets?: string
	/** The key-value separator. Defaults to `'='`. */
	sep?: string
	entries: readonly { key: StringNodeOptions; value: StringNodeOptions }[]
}

/**
 * Builds a record node the same way {@link record} does, including the separator ranges and the
 * inner range.
 *
 * @returns The record node, the source that it spans, and its key and value nodes.
 */
export function recordNode({ type, brackets = '[]', sep = '=', entries }: RecordNodeOptions): {
	node: RecordBaseNode<StringBaseNode, StringBaseNode>
	src: string
	keys: StringBaseNode[]
	values: StringBaseNode[]
} {
	let src = brackets[0]
	const keys: StringBaseNode[] = []
	const values: StringBaseNode[] = []
	const children: PairNode<StringBaseNode, StringBaseNode>[] = []

	for (const [index, entry] of entries.entries()) {
		const pairStart = src.length
		const key = stringNodeAt(entry.key, src.length)
		src += rawOf(entry.key)
		const sepRange = Range.create(src.length, src.length + sep.length)
		src += sep
		const value = stringNodeAt(entry.value, src.length)
		src += rawOf(entry.value)
		let end: RangeType | undefined
		if (index < entries.length - 1) {
			end = Range.create(src.length, src.length + 1)
			src += ','
		}
		keys.push(key)
		values.push(value)
		children.push({
			type: 'pair',
			range: Range.create(pairStart, src.length),
			children: [key, value],
			key,
			sep: sepRange,
			value,
			end,
		})
	}

	const innerRange = Range.create(1, src.length)
	src += brackets[1]
	const node: RecordBaseNode<StringBaseNode, StringBaseNode> = {
		type,
		range: Range.create(0, src.length),
		innerRange,
		children,
	}
	AstNode.setParents(node)
	return { node, src, keys, values }
}
