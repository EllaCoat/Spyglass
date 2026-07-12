import type {
	AstNode,
	Config,
	ErrorSeverity as ErrorSeverityType,
	Linter,
	Logger,
} from '@spyglassmc/core'
import { ErrorSeverity } from '@spyglassmc/core'

export type ImpDocContractCheckSeverity =
	| 'off'
	| 'information'
	| 'warning'
	| 'error'

declare module '@spyglassmc/core' {
	interface LinterConfig {
		/** Semantic checks for typed IMP-Doc function contracts. Defaults to off. */
		impDocContractCheck?: ImpDocContractCheckSeverity
	}
}

const ContractCheckSeverities = new Set<unknown>([
	'off',
	'information',
	'warning',
	'error',
])

export function contractConfigValidator(
	ruleName: string,
	value: unknown,
	logger: Logger,
): boolean {
	// Core destructures severity shorthand (`warning`, etc.) to the linter rule
	// value `true` before validation. The checker still reads the original value.
	if (value === true || ContractCheckSeverities.has(value)) {
		return true
	}
	logger.error(
		`[Invalid Linter Config] [${ruleName}] Expected one of “off”, “information”, “warning”, or “error”`,
	)
	return false
}

/** Validation-only registration; semantic diagnostics run in checker phase. */
export const contractCheckLinter: Linter<AstNode> = () => {}

export function getContractCheckSeverity(
	config: Config,
): ErrorSeverityType | undefined {
	const value = config.lint.impDocContractCheck ?? 'off'
	switch (value) {
		case 'off':
			return undefined
		case 'information':
			return ErrorSeverity.Information
		case 'warning':
			return ErrorSeverity.Warning
		case 'error':
			return ErrorSeverity.Error
	}
}
