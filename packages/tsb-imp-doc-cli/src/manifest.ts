import type { LintDiagnostic } from './reporter.js'

export interface ParseSummary {
	bytes: number
	lines: number
	parserErrors: number
}

/** A serializable summary of a symbol exported by one source file. */
export interface ExportSymbolSummary {
	category: string
	path: string[]
	key: string
	usage: ('declaration' | 'definition' | 'implementation' | 'typeDefinition')[]
	data?: unknown
	description?: string
}

export interface FileManifestEntry {
	generation: number
	sha1: string
	parse: ParseSummary
	exports: ExportSymbolSummary[]
	references: string[]
	diagnostics: LintDiagnostic[]
}

export interface PerFileManifest {
	generation: number
	files: Record<string, FileManifestEntry>
}

export function deriveSymbolKey(category: string, path: readonly string[]): string {
	return JSON.stringify({ category, path })
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isDiagnostic(value: unknown): value is LintDiagnostic {
	if (!isRecord(value)) {
		return false
	}
	return typeof value['file'] === 'string'
		&& typeof value['line'] === 'number'
		&& typeof value['col'] === 'number'
		&& (
			value['severity'] === 'error'
			|| value['severity'] === 'warning'
			|| value['severity'] === 'information'
			|| value['severity'] === 'hint'
		)
		&& typeof value['rule'] === 'string'
		&& typeof value['message'] === 'string'
}

function isExportSummary(value: unknown): value is ExportSymbolSummary {
	if (!isRecord(value)) {
		return false
	}
	return typeof value['category'] === 'string'
		&& isStringArray(value['path'])
		&& value['path'].length > 0
		&& typeof value['key'] === 'string'
		&& value['key'] === deriveSymbolKey(value['category'], value['path'])
		&& Array.isArray(value['usage'])
		&& value['usage'].every(usage =>
			usage === 'declaration'
			|| usage === 'definition'
			|| usage === 'implementation'
			|| usage === 'typeDefinition'
		)
		&& (value['description'] === undefined || typeof value['description'] === 'string')
}

function isEntry(value: unknown, generation: number): value is FileManifestEntry {
	if (!isRecord(value) || value['generation'] !== generation || !isRecord(value['parse'])) {
		return false
	}
	return typeof value['sha1'] === 'string'
		&& /^[0-9a-f]{40}$/.test(value['sha1'])
		&& typeof value['parse']['bytes'] === 'number'
		&& typeof value['parse']['lines'] === 'number'
		&& typeof value['parse']['parserErrors'] === 'number'
		&& Array.isArray(value['exports'])
		&& value['exports'].every(isExportSummary)
		&& isStringArray(value['references'])
		&& Array.isArray(value['diagnostics'])
		&& value['diagnostics'].every(isDiagnostic)
}

/** Validates the generation fence as well as the per-file schema. */
export function isPerFileManifest(
	value: unknown,
	expectedGeneration: number,
): value is PerFileManifest {
	if (
		!isRecord(value)
		|| value['generation'] !== expectedGeneration
		|| !isRecord(value['files'])
	) {
		return false
	}
	return Object.values(value['files']).every(entry => isEntry(entry, expectedGeneration))
}
