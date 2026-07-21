import * as core from '@spyglassmc/core'
import { setRefProvenance } from '../node/ImpDocNode.js'

/**
 * Line-level scan result shared by the CLI runner and the LSP macro
 * decoration. `dynamicRanges` cover `function $(...)` targets that can never
 * be resolved statically; each consumer decides its own diagnostic / marker
 * policy for them. `refs` are ready-to-attach resource-location nodes whose
 * best-effort provenance (`macro` / `nbt-string`) is already tagged.
 */
export interface ScannedFunctionRefs {
	dynamicRanges: core.Range[]
	refs: core.ResourceLocationNode[]
}

/**
 * A fully dynamic `function $(...)` (or `function #$(...)`) call target. The
 * pattern must be applied to a whole line: macro parsing splits the line into
 * `other` / `argument` segments right at `$(`, so any per-segment scan would
 * never see the pattern (spike 2).
 */
const DynamicRefPattern = /\bfunction[\t ]+#?\$\([^\s)]*\)?/g

/** A static `function <id>` / `function #<tag>` reference target. */
const StaticRefPattern =
	/\bfunction[\t ]+(#?(?:[A-Za-z0-9_.-]+:[A-Za-z0-9_./-]+|[A-Za-z0-9_./-]+))/g

/** A static optional sequence argument to the vanilla `random` command. */
const RandomSequenceRefPattern =
	/^random[\t ]+(?:(?:value|roll)[\t ]+\S+|reset)[\t ]+((?:[a-z0-9_.-]+:)?[a-z0-9_./-]+)/

interface CommandToken {
	start: number
	end: number
}

/**
 * A `$(` completing the matched resource-location token across `:` and `/`,
 * which means the actual target is decided by macro substitution at runtime.
 */
const MacroSuffixPattern = /^[A-Za-z0-9_./:-]*\$\(/

/**
 * Builds a function-category resource-location reference node for a scanned
 * target, mirroring what the mcfunction argument parser would emit.
 */
export function parseFunctionRefNode(
	raw: string,
	range: core.Range,
): core.ResourceLocationNode {
	const isTag = raw.startsWith('#')
	const id = isTag ? raw.slice(1) : raw
	const separator = id.indexOf(':')
	const namespace = separator >= 0 ? id.slice(0, separator) : undefined
	const path = id.slice(separator + 1).split('/')
	return {
		type: 'resource_location',
		range,
		namespace,
		path,
		isTag,
		options: {
			category: 'function',
			allowTag: true,
			usageType: 'reference',
		},
	}
}

function parseRandomSequenceRefNode(
	raw: string,
	range: core.Range,
): core.ResourceLocationNode {
	const separator = raw.indexOf(':')
	return {
		type: 'resource_location',
		range,
		namespace: separator >= 0 ? raw.slice(0, separator) : undefined,
		path: raw.slice(separator + 1).split('/'),
		isTag: false,
		options: {
			category: 'random_sequence',
			usageType: 'reference',
		},
	}
}

/**
 * Naive single-line scan that reports whether `index` sits inside an unclosed
 * `'` / `"` quote. Backslash escapes are honoured; any nested structure beyond
 * that is irrelevant for provenance classification.
 */
function isInsideQuote(line: string, index: number): boolean {
	let quote: string | undefined
	for (let i = 0; i < index; i++) {
		const char = line[i]
		if (quote === undefined) {
			if (char === '"' || char === "'") {
				quote = char
			}
		} else if (char === '\\') {
			i++
		} else if (char === quote) {
			quote = undefined
		}
	}
	return quote !== undefined
}

/**
 * Splits a command into top-level space-delimited tokens. Whitespace in quoted
 * strings and balanced selector / NBT / JSON / macro payloads stays inside its
 * surrounding token, so a payload containing `run random ...` cannot be
 * mistaken for a command redirect.
 */
function tokenizeCommand(line: string, start: number): CommandToken[] {
	const tokens: CommandToken[] = []
	const closers: string[] = []
	let tokenStart: number | undefined
	let quote: string | undefined

	for (let i = start; i < line.length; i++) {
		const char = line[i]!
		if (tokenStart === undefined) {
			if (char === ' ' || char === '\t') {
				continue
			}
			tokenStart = i
		}

		if (quote !== undefined) {
			if (char === '\\') {
				i++
			} else if (char === quote) {
				quote = undefined
			}
			continue
		}

		if (char === '"' || char === "'") {
			quote = char
		} else if (char === '[') {
			closers.push(']')
		} else if (char === '{') {
			closers.push('}')
		} else if (char === '(') {
			closers.push(')')
		} else if (char === closers.at(-1)) {
			closers.pop()
		} else if ((char === ' ' || char === '\t') && closers.length === 0) {
			tokens.push({ start: tokenStart, end: i })
			tokenStart = undefined
		}
	}

	if (tokenStart !== undefined) {
		tokens.push({ start: tokenStart, end: line.length })
	}
	return tokens
}

function commandTokenValue(
	line: string,
	tokens: readonly CommandToken[],
	index: number,
): string | undefined {
	const token = tokens[index]
	return token ? line.slice(token.start, token.end) : undefined
}

function advanceCommandTokens(
	tokens: readonly CommandToken[],
	index: number,
	count: number,
): number | undefined {
	return tokens[index + count - 1] ? index + count : undefined
}

/** Returns the token after a complete `execute store ...` subcommand. */
function skipExecuteStore(
	line: string,
	tokens: readonly CommandToken[],
	index: number,
): number | undefined {
	const resultKind = commandTokenValue(line, tokens, index + 1)
	if (resultKind !== 'result' && resultKind !== 'success') {
		return undefined
	}

	switch (commandTokenValue(line, tokens, index + 2)) {
		case 'block':
			return advanceCommandTokens(tokens, index, 9)
		case 'bossbar':
		case 'score':
			return advanceCommandTokens(tokens, index, 5)
		case 'entity':
		case 'storage':
			return advanceCommandTokens(tokens, index, 7)
		default:
			return undefined
	}
}

/** Returns the token after a complete `execute if|unless ...` subcommand. */
function skipExecuteCondition(
	line: string,
	tokens: readonly CommandToken[],
	index: number,
): number | undefined {
	switch (commandTokenValue(line, tokens, index + 1)) {
		case 'biome':
		case 'block':
			return advanceCommandTokens(tokens, index, 6)
		case 'blocks':
			return advanceCommandTokens(tokens, index, 12)
		case 'data': {
			const target = commandTokenValue(line, tokens, index + 2)
			if (target === 'block') {
				return advanceCommandTokens(tokens, index, 7)
			}
			return target === 'entity' || target === 'storage'
				? advanceCommandTokens(tokens, index, 5)
				: undefined
		}
		case 'dimension':
		case 'entity':
		case 'function':
		case 'predicate':
			return advanceCommandTokens(tokens, index, 3)
		case 'items': {
			const target = commandTokenValue(line, tokens, index + 2)
			if (target === 'block') {
				return advanceCommandTokens(tokens, index, 8)
			}
			return target === 'entity'
				? advanceCommandTokens(tokens, index, 6)
				: undefined
		}
		case 'loaded':
			return advanceCommandTokens(tokens, index, 5)
		case 'score': {
			const comparison = commandTokenValue(line, tokens, index + 4)
			if (comparison === 'matches') {
				return advanceCommandTokens(tokens, index, 6)
			}
			return comparison === '<'
					|| comparison === '<='
					|| comparison === '='
					|| comparison === '>='
					|| comparison === '>'
				? advanceCommandTokens(tokens, index, 7)
				: undefined
		}
		case 'stopwatch':
			return advanceCommandTokens(tokens, index, 4)
		default:
			return undefined
	}
}

/**
 * Walks the vanilla `execute` subcommand grammar up to its `run` literal. The
 * standalone CLI intentionally has no versioned command tree, so unknown
 * subcommands fail closed instead of turning later command-looking text into a
 * strict reference.
 */
function findExecuteRun(
	line: string,
	tokens: readonly CommandToken[],
	start: number,
): number | undefined {
	let index = start
	while (index < tokens.length) {
		const subcommand = commandTokenValue(line, tokens, index)
		if (subcommand === 'run') {
			return index
		}

		let next: number | undefined
		switch (subcommand) {
			case 'align':
			case 'anchored':
			case 'as':
			case 'at':
			case 'in':
			case 'on':
			case 'summon':
				next = advanceCommandTokens(tokens, index, 2)
				break
			case 'facing':
				next = advanceCommandTokens(tokens, index, 4)
				break
			case 'positioned':
				next = commandTokenValue(line, tokens, index + 1) === 'as'
						|| commandTokenValue(line, tokens, index + 1) === 'over'
					? advanceCommandTokens(tokens, index, 3)
					: advanceCommandTokens(tokens, index, 4)
				break
			case 'rotated':
				next = advanceCommandTokens(tokens, index, 3)
				break
			case 'store':
				next = skipExecuteStore(line, tokens, index)
				break
			case 'if':
			case 'unless':
				next = skipExecuteCondition(line, tokens, index)
				break
			default:
				return undefined
		}
		if (next === undefined) {
			return undefined
		}
		index = next
	}
	return undefined
}

/**
 * Finds a `random` command position after following vanilla command redirects.
 * `execute.run` and `return.run` both redirect to the root command tree.
 */
function findRandomCommandStart(
	line: string,
	tokens: readonly CommandToken[],
	index: number,
): number | undefined {
	let commandIndex = index
	while (commandIndex < tokens.length) {
		const token = tokens[commandIndex]!
		const value = line.slice(token.start, token.end)
		if (value === 'random') {
			return token.start
		}
		if (value === 'return') {
			const run = tokens[commandIndex + 1]
			if (!run || line.slice(run.start, run.end) !== 'run') {
				return undefined
			}
			commandIndex += 2
			continue
		}
		if (value !== 'execute') {
			return undefined
		}
		const run = findExecuteRun(line, tokens, commandIndex + 1)
		if (run === undefined) {
			return undefined
		}
		commandIndex = run + 1
	}
	return undefined
}

/**
 * Scans one command line for static and fully dynamic function references.
 * Static targets completed by a `$(...)` substitution are skipped entirely:
 * the prefix alone would be a spurious reference. Macro lines get `macro`
 * provenance on every static target; on normal lines a target inside a quoted
 * payload (usually SNBT) gets `nbt-string` provenance; untagged targets are
 * strict references.
 *
 * @param line The whole line text (macro lines start at their `$` prefix).
 * @param lineStart Absolute offset of `line[0]` in the source document.
 * @param isMacroLine Whether the line is a `$` macro line.
 */
export function scanLineFunctionRefs(
	line: string,
	lineStart: number,
	isMacroLine: boolean,
): ScannedFunctionRefs {
	const dynamicRanges: core.Range[] = []
	const refs: core.ResourceLocationNode[] = []

	for (const match of line.matchAll(DynamicRefPattern)) {
		dynamicRanges.push(core.Range.create(
			lineStart + match.index,
			lineStart + match.index + match[0].length,
		))
	}

	for (const match of line.matchAll(StaticRefPattern)) {
		const raw = match[1]!
		const suffix = line.slice(match.index + match[0].length)
		if (MacroSuffixPattern.test(suffix)) {
			continue
		}
		const targetStart = lineStart + match.index + match[0].lastIndexOf(raw)
		const ref = parseFunctionRefNode(
			raw,
			core.Range.create(targetStart, targetStart + raw.length),
		)
		// Macro lines are rewritten by substitution before execution and
		// quoted payloads (usually SNBT) may never run as commands, so
		// their references only get best-effort treatment.
		if (isMacroLine) {
			setRefProvenance(ref, 'macro')
		} else if (isInsideQuote(line, match.index)) {
			setRefProvenance(ref, 'nbt-string')
		}
		refs.push(ref)
	}

	return { dynamicRanges, refs }
}

/**
 * Scans the optional sequence argument of vanilla `random` commands for the
 * standalone CLI parser. The full Java Edition parser already emits the same
 * `random_sequence` resource-location node on the language-server path.
 */
export function scanLineRandomSequenceRefs(
	line: string,
	lineStart: number,
	isMacroLine: boolean,
): core.ResourceLocationNode[] {
	const firstTokenStart = line.search(/[^\t ]/)
	if (firstTokenStart < 0) {
		return []
	}

	// `$` is the mcfunction macro-line marker, not part of the command token.
	// Requiring it when the caller classified the line as a macro also keeps a
	// malformed/mismatched call from scanning arbitrary text later in the line.
	const commandStart = isMacroLine
		? line[firstTokenStart] === '$' ? firstTokenStart + 1 : undefined
		: firstTokenStart
	if (commandStart === undefined) {
		return []
	}

	const randomCommandStart = findRandomCommandStart(
		line,
		tokenizeCommand(line, commandStart),
		0,
	)
	if (randomCommandStart === undefined) {
		return []
	}

	const match = RandomSequenceRefPattern.exec(line.slice(randomCommandStart))
	if (!match) {
		return []
	}
	const raw = match[1]!
	const matchEnd = randomCommandStart + match[0].length
	if (MacroSuffixPattern.test(line.slice(matchEnd))) {
		return []
	}
	const targetStart = lineStart + randomCommandStart + match[0].lastIndexOf(raw)
	const ref = parseRandomSequenceRefNode(
		raw,
		core.Range.create(targetStart, targetStart + raw.length),
	)
	if (isMacroLine) {
		setRefProvenance(ref, 'macro')
	}
	return [ref]
}
