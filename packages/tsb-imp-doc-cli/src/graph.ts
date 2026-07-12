import { deriveSymbolKey, type PerFileManifest } from './manifest.js'

export interface DependencyGraph {
	generation: number
	/** Source file to referenced symbol keys. */
	references: Record<string, string[]>
	/** Referenced symbol key to source files that reference it. */
	dependents: Record<string, string[]>
}

function sortedUnique(values: Iterable<string>): string[] {
	return [...new Set(values)].sort()
}

export function toSymbolKey(category: string, path: readonly string[]): string {
	return deriveSymbolKey(category, path)
}

export function createDependencyGraph(
	manifest: PerFileManifest,
	generation = manifest.generation,
): DependencyGraph {
	const references: Record<string, string[]> = {}
	const dependents = new Map<string, Set<string>>()
	for (
		const [file, entry] of Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b))
	) {
		references[file] = sortedUnique(entry.references)
		for (const symbol of references[file]) {
			const files = dependents.get(symbol) ?? new Set<string>()
			files.add(file)
			dependents.set(symbol, files)
		}
	}
	return {
		generation,
		references,
		dependents: Object.fromEntries(
			[...dependents.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([symbol, files]) => [symbol, sortedUnique(files)]),
		),
	}
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isStringArrayRecord(value: unknown): value is Record<string, string[]> {
	return !!value
		&& typeof value === 'object'
		&& !Array.isArray(value)
		&& Object.values(value).every(isStringArray)
}

export function isDependencyGraph(
	value: unknown,
	expectedGeneration: number,
): value is DependencyGraph {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false
	}
	const graph = value as Partial<DependencyGraph>
	return graph.generation === expectedGeneration
		&& isStringArrayRecord(graph.references)
		&& isStringArrayRecord(graph.dependents)
}

export function isDependencyGraphConsistent(
	graph: DependencyGraph,
	manifest: PerFileManifest,
): boolean {
	return JSON.stringify(graph) === JSON.stringify(
		createDependencyGraph(manifest, graph.generation),
	)
}

/**
 * Expands changed files to co-exporters and transitive reverse dependencies.
 * Co-exporters are included so clearing a symbol cannot retain metadata from an
 * unchanged duplicate declaration.
 */
export function expandAffectedFiles(
	changedFiles: Iterable<string>,
	newExportKeys: Iterable<string>,
	manifest: PerFileManifest,
	graph: DependencyGraph,
): Set<string> {
	const affected = new Set<string>()
	const pendingFiles: string[] = []
	const pendingSymbols = [...newExportKeys]
	const visitedSymbols = new Set<string>()
	const exporters = new Map<string, Set<string>>()

	for (const [file, entry] of Object.entries(manifest.files)) {
		for (const exported of entry.exports) {
			const files = exporters.get(exported.key) ?? new Set<string>()
			files.add(file)
			exporters.set(exported.key, files)
		}
	}

	const addFile = (file: string) => {
		if (!affected.has(file)) {
			affected.add(file)
			pendingFiles.push(file)
		}
	}
	for (const file of changedFiles) {
		addFile(file)
	}

	while (pendingFiles.length > 0 || pendingSymbols.length > 0) {
		while (pendingFiles.length > 0) {
			const file = pendingFiles.shift()!
			for (const exported of manifest.files[file]?.exports ?? []) {
				pendingSymbols.push(exported.key)
			}
		}
		const symbol = pendingSymbols.shift()
		if (symbol === undefined || visitedSymbols.has(symbol)) {
			continue
		}
		visitedSymbols.add(symbol)
		for (const file of graph.dependents[symbol] ?? []) {
			addFile(file)
		}
		for (const file of exporters.get(symbol) ?? []) {
			addFile(file)
		}
	}

	return affected
}
