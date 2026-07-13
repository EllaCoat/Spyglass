import * as fs from 'fs'
import * as path from 'path'

export function verifyPnpmOverrides(referencedWorkspaces: Set<string>): void {
	const workspaceYamlPath = path.join(import.meta.dirname, '../pnpm-workspace.yaml')
	const workspaceYaml = fs.readFileSync(workspaceYamlPath, 'utf-8')
	const managedOverridePattern = /^\s*"@spyglassmc\/([^"]+)"\s*:\s*"([^"]+)"\s*$/gm
	const yamlManagedOverrides = new Map<string, string>()
	for (const match of workspaceYaml.matchAll(managedOverridePattern)) {
		yamlManagedOverrides.set(match[1], match[2])
	}
	for (const dep of referencedWorkspaces) {
		const spec = yamlManagedOverrides.get(dep)
		if (spec === undefined) {
			throw new Error(
				`pnpm-workspace.yaml overrides is missing "@spyglassmc/${dep}". `
					+ `Add \`"@spyglassmc/${dep}": "workspace:*"\` to the overrides block.`,
			)
		}
		if (spec !== 'workspace:*') {
			throw new Error(
				`pnpm-workspace.yaml overrides for "@spyglassmc/${dep}" is "${spec}", `
					+ `expected "workspace:*".`,
			)
		}
	}
	for (const dep of yamlManagedOverrides.keys()) {
		if (!referencedWorkspaces.has(dep)) {
			throw new Error(
				`pnpm-workspace.yaml overrides declares "@spyglassmc/${dep}", `
					+ `but no workspace package references it. Remove the stale override.`,
			)
		}
	}
}
