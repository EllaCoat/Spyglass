import { localeQuote, localize } from '@spyglassmc/locales'
import type { Logger } from '../../common/index.js'
import { StateProxy } from '../../common/index.js'
import type { AstNode, Quote, StringBaseNode } from '../../node/index.js'
import { PairNode } from '../../node/index.js'
import { isAllowedCharacter } from '../../parser/index.js'
import type { MetaRegistry, QuoteConfig } from '../../service/index.js'
import { SymbolLinterConfig } from '../../service/index.js'
import type { LanguageErrorAction } from '../../source/index.js'
import { Range } from '../../source/index.js'
import { McdocCategories } from '../../symbol/index.js'
import { nbtBoolean } from './builtin/nbtBoolean.js'
import { selectorSortKeys } from './builtin/selectorSortKeys.js'
import { undeclaredSymbol } from './builtin/undeclaredSymbol.js'
import type { Linter } from './Linter.js'

export const noop: Linter<AstNode> = () => {}

/**
 * @param key The name of the key on the {@link AstNode} that contains the value to be validated.
 */
export function nameConvention(key: string): Linter<AstNode> {
	return (node, ctx) => {
		if (typeof (node as any)[key] !== 'string') {
			throw new Error(`Trying to access property "${key}" of node type "${node.type}"`)
		}
		const name: string = (node as any)[key]

		try {
			// SECURITY: ReDoS attack. The risk is acceptable at the moment.
			const regex = new RegExp(ctx.ruleValue as string)
			if (!name.match(regex)) {
				ctx.err.lint(
					localize(
						'linter.name-convention.illegal',
						localeQuote(name),
						localeQuote(ctx.ruleValue as string),
					),
					node,
				)
			}
		} catch (e) {
			ctx.logger.error(
				`[nameConvention linter] The value “${ctx.ruleValue}” set for rule “${ctx.ruleName}” is not a valid regular expression.`,
				e,
			)
		}
	}
}

export const quote: Linter<StringBaseNode> = (node, ctx) => {
	const config = ctx.ruleValue as QuoteConfig
	// A `StateProxy` wraps nested objects as well, and the `Set` that `unquotable.allowList` holds
	// cannot be used through a proxy, hence the dereference.
	const options = StateProxy.dereference(node.options)
	if (!options.quotes?.length) {
		// This string cannot be quoted at all. e.g. Brigadier's `word` and `greedy` strings.
		return
	}
	const mustValueBeQuoted = options.unquotable
		? [...node.value].some((c) => !isAllowedCharacter(c, options.unquotable as any))
		: true
	const isQuoteRequired = config.always || mustValueBeQuoted
	const isQuoteProhibited = config.always === false && !mustValueBeQuoted
	// The parser records the quotation mark that actually opened this string, which is more
	// reliable than reading the source, as the source may be escaped for an enclosing string.
	const currentQuote = node.quote
	if (isQuoteRequired) {
		if (currentQuote === undefined) {
			ctx.err.lint(localize('expected', localize('quote')), node, {
				codeAction: quoteAction(node, getExpectedQuote(node.value, config)),
			})
		} else if (config.type) {
			const expectedQuote = getExpectedQuote(node.value, config)
			if (currentQuote !== expectedQuote) {
				ctx.err.lint(
					config.avoidEscape
						? localize(expectedQuote === '"' ? 'quote_prefer_double' : 'quote_prefer_single')
						: localize('expected-got', localeQuote(expectedQuote), localeQuote(currentQuote)),
					node,
					{ codeAction: quoteAction(node, expectedQuote) },
				)
			}
		}
	} else if (isQuoteProhibited && currentQuote !== undefined) {
		ctx.err.lint(localize('expected', localize('unquoted-string')), node, {
			codeAction: {
				title: localize('code-action.string-unquote'),
				isPreferred: true,
				changes: [{ type: 'edit', range: Range.get(node.range), text: node.value }],
			},
		})
	}
}

/**
 * @returns The quotation mark that the `config` asks for. Falls back to the double quotation mark
 * if the config does not specify a type.
 */
function getExpectedQuote(value: string, config: QuoteConfig): Quote {
	const preferred: Quote = config.type === 'single' ? "'" : '"'
	if (config.avoidEscape && value.includes(preferred)) {
		return preferred === '"' ? "'" : '"'
	}
	return preferred
}

function quoteAction(node: StateProxy<StringBaseNode>, quote: Quote): LanguageErrorAction {
	const escaped = node.value.replace(/[\\'"]/g, (c) => (c === '\\' || c === quote ? `\\${c}` : c))
	return {
		title: localize(
			quote === '"' ? 'code-action.string-double-quote' : 'code-action.string-single-quote',
		),
		isPreferred: true,
		changes: [{ type: 'edit', range: Range.get(node.range), text: `${quote}${escaped}${quote}` }],
	}
}

/**
 * @returns Whether the `node` is the key of a {@link PairNode} that belongs to a record node of
 * the given `recordType`.
 */
function isRecordKeyOf(node: AstNode, recordType: string): boolean {
	const pair = node.parent
	return (PairNode.is(pair) && pair.key === node && pair.parent?.type === recordType)
}

export namespace configValidator {
	function getDocLink(name: string): string {
		return `https://spyglassmc.com/user/lint/${name}`
	}

	function wrapError(name: string, msg: string): string {
		return `[Invalid Linter Config] [${name}] ${
			localize('linter-config-validator.wrapper', msg, getDocLink(name))
		}`
	}

	export function nameConvention(name: string, val: unknown, logger: Logger): boolean {
		if (typeof val !== 'string') {
			logger.error(wrapError(name, localize('linter-config-validator.name-convention.type')))
			return false
		}

		try {
			// SECURITY: ReDoS attack. The risk is acceptable at the moment.
			new RegExp(val)
		} catch (e) {
			logger.error(
				wrapError(
					name,
					localize(''), // FIXME
				),
				e,
			)
			return false
		}

		return true
	}

	export function symbolLinterConfig(_name: string, value: unknown, _logger: Logger): boolean {
		return SymbolLinterConfig.is(value)
	}

	export function quoteConfig(name: string, value: unknown, logger: Logger): boolean {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			logger.error(wrapError(name, 'Expects an object'))
			return false
		}

		const { always, avoidEscape, type } = value as QuoteConfig
		if (always !== undefined && typeof always !== 'boolean') {
			logger.error(wrapError(name, 'Expects “always” to be a boolean'))
			return false
		}
		// A nullish `avoidEscape` is treated the same way as `false`.
		if (typeof (avoidEscape ?? false) !== 'boolean') {
			logger.error(wrapError(name, 'Expects “avoidEscape” to be a boolean or null'))
			return false
		}
		if (type !== undefined && type !== 'double' && type !== 'single') {
			logger.error(wrapError(name, 'Expects “type” to be either “double” or “single”'))
			return false
		}

		return true
	}

	export function stringArray(name: string, value: unknown, logger: Logger): boolean {
		if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
			logger.error(wrapError(name, 'Expects an array of strings'))
			return false
		}
		return true
	}

	export function boolean(name: string, value: unknown, logger: Logger): boolean {
		if (typeof value !== 'boolean') {
			logger.error(wrapError(name, 'Expects a boolean'))
			return false
		}
		return true
	}
}

export function registerLinters(meta: MetaRegistry) {
	meta.registerLinter('selectorSortKeys', {
		configValidator: configValidator.stringArray,
		linter: selectorSortKeys as Linter<AstNode>,
		nodePredicate: (n) => n.type === 'mcfunction:entity_selector/arguments',
	})
	meta.registerLinter('commandStringQuote', {
		configValidator: configValidator.quoteConfig,
		linter: quote as Linter<AstNode>,
		nodePredicate: (n) => n.type === 'string' && n.parent?.type === 'mcfunction:command_child',
	})
	meta.registerLinter('nbtKeyQuote', {
		configValidator: configValidator.quoteConfig,
		linter: quote as Linter<AstNode>,
		nodePredicate: (n) => n.type === 'nbt:string' && isRecordKeyOf(n, 'nbt:compound'),
	})
	meta.registerLinter('nbtPathQuote', {
		configValidator: configValidator.quoteConfig,
		linter: quote as Linter<AstNode>,
		nodePredicate: (n) => n.type === 'nbt:string' && n.parent?.type === 'nbt:path/key',
	})
	meta.registerLinter('nbtStringQuote', {
		configValidator: configValidator.quoteConfig,
		linter: quote as Linter<AstNode>,
		nodePredicate: (n) =>
			n.type === 'nbt:string'
			&& !isRecordKeyOf(n, 'nbt:compound')
			&& n.parent?.type !== 'nbt:path/key',
	})
	meta.registerLinter('selectorKeyQuote', {
		configValidator: configValidator.quoteConfig,
		linter: quote as Linter<AstNode>,
		nodePredicate: (n) =>
			n.type === 'string' && isRecordKeyOf(n, 'mcfunction:entity_selector/arguments'),
	})
	meta.registerLinter('nameOfObjective', {
		configValidator: configValidator.nameConvention,
		linter: nameConvention('value'),
		nodePredicate: (n) => n.symbol && n.symbol.category === 'objective',
	})
	meta.registerLinter('nameOfScoreHolder', {
		configValidator: configValidator.nameConvention,
		linter: nameConvention('value'),
		nodePredicate: (n) => n.symbol && n.symbol.category === 'score_holder',
	})
	meta.registerLinter('nameOfTag', {
		configValidator: configValidator.nameConvention,
		linter: nameConvention('value'),
		nodePredicate: (n) => n.symbol && n.symbol.category === 'tag',
	})
	meta.registerLinter('nameOfTeam', {
		configValidator: configValidator.nameConvention,
		linter: nameConvention('value'),
		nodePredicate: (n) => n.symbol && n.symbol.category === 'team',
	})
	meta.registerLinter('nbtBoolean', {
		configValidator: configValidator.boolean,
		linter: nbtBoolean as Linter<AstNode>,
		nodePredicate: (n) => n.type === 'nbt:byte',
	})
	meta.registerLinter('undeclaredSymbol', {
		configValidator: configValidator.symbolLinterConfig,
		linter: undeclaredSymbol,
		nodePredicate: (n) => n.symbol && !McdocCategories.includes(n.symbol.category as any),
	})
}
