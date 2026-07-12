import * as core from '@spyglassmc/core'
import { NodeJsExternals } from '@spyglassmc/core/lib/nodejs.js'
import * as je from '@spyglassmc/java-edition'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { initialize as initializeImpDoc } from '../lib/index.js'

const FixtureRoot = core.fileUtil.ensureEndingSlash(
	new URL('./runtime/private-project/', import.meta.url).toString(),
)
const PackMcmeta = new URL('./runtime/private-project/pack.mcmeta', import.meta.url).toString()

export const ContractRuntimeFiles = {
	target: new URL(
		'./runtime/private-project/data/contract/functions/target.mcfunction',
		import.meta.url,
	).toString(),
	caller: new URL(
		'./runtime/private-project/data/contract/functions/caller.mcfunction',
		import.meta.url,
	).toString(),
} as const

const Commands: je.dependency.McmetaCommands = {
	type: 'root',
	children: {
		function: {
			type: 'literal',
			children: {
				name: {
					type: 'argument',
					parser: 'minecraft:function',
					executable: true,
				},
			},
		},
	},
}

class ContractFixtureWatcher extends core.EventDispatcher<core.FileWatcherEventMap>
	implements core.FileWatcher
{
	readonly watchedFiles = new core.UriStore()

	constructor(uris: readonly string[]) {
		super()
		for (const uri of uris) {
			this.watchedFiles.add(uri)
		}
	}

	async ready(): Promise<void> {}
	async close(): Promise<void> {}
}

function createConfig(): core.Config {
	const config = core.ConfigService.merge(core.VanillaConfig, {
		env: {
			dependencies: [],
			exclude: [],
			gameVersion: '1.20.4',
		},
	})
	const lint = config.lint as unknown as Record<string, unknown>
	for (const rule of Object.keys(lint)) {
		delete lint[rule]
	}
	lint.impDocContractCheck = 'off'
	return config
}

export interface ContractRuntime {
	service: core.Service
	target: core.DocAndNode & { content: string }
	caller: core.DocAndNode & { content: string }
	close: () => Promise<void>
}

export async function createContractRuntime(): Promise<ContractRuntime> {
	const cacheDir = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-contract-'))
	const initialize: core.ProjectInitializer = async (ctx) => {
		ctx.meta.registerUriBinder(je.binder.uriBinder)
		je.mcf.initialize(ctx, Commands, '1.20.4')
		const impDoc = (await initializeImpDoc(ctx)) ?? {}
		return { ...impDoc, loadedVersion: '1.20.4', errorSource: '1.20.4' }
	}
	const service = new core.Service({
		logger: {
			error: () => {},
			info: () => {},
			log: () => {},
			warn: () => {},
		},
		project: {
			cacheRoot: core.fileUtil.ensureEndingSlash(pathToFileURL(cacheDir).toString()),
			defaultConfig: createConfig(),
			externals: NodeJsExternals,
			initializers: [initialize],
			projectRoots: [FixtureRoot],
		},
	})

	await service.project.init()
	await service.project.ready({
		projectRootsWatcher: new ContractFixtureWatcher([
			PackMcmeta,
			...Object.values(ContractRuntimeFiles),
		]),
	})

	const states = {} as Record<'target' | 'caller', core.DocAndNode & { content: string }>
	for (const name of ['target', 'caller'] as const) {
		const uri = ContractRuntimeFiles[name]
		const content = await readFile(new URL(uri), 'utf8')
		await service.project.onDidOpen(uri, 'mcfunction', 1, content)
		const result = service.project.getClientManaged(uri)
		assert.ok(result)
		states[name] = { ...result, content }
	}

	return {
		service,
		...states,
		close: async () => {
			await service.project.close()
			await rm(cacheDir, { recursive: true, force: true })
		},
	}
}
