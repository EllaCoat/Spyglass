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
