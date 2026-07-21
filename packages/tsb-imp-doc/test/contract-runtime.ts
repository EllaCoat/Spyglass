import * as core from '@spyglassmc/core'
import { NodeJsExternals } from '@spyglassmc/core/lib/nodejs.js'
import * as je from '@spyglassmc/java-edition'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { initialize as initializeImpDoc } from '../lib/index.js'

// Canonicalize fixture URIs with core.normalizeUri (lowercases Windows drive letters,
// like UriStore does for watched files) so that projectRoots, watcher entries, and
// assertions all compare the same URI form. See core/common/util.ts#normalizeUriPathname.
function fixtureUri(fixture: string, path: string): string {
	return core.normalizeUri(
		new URL(`./runtime/${fixture}/${path}`, import.meta.url).toString(),
	)
}

const DefaultCommands: je.dependency.McmetaCommands = {
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

class ServiceFixtureWatcher extends core.EventDispatcher<core.FileWatcherEventMap>
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

function createDefaultConfig(): core.Config {
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
	lint['impDocContractCheck'] = 'off'
	return config
}

export type ServiceRuntimeState = core.DocAndNode & { content: string }

export interface ServiceRuntimeOptions<K extends string> {
	/** Fixture project directory name under `test/runtime/`. */
	fixture: string
	/** Files to open through the Service, keyed by test-local name. Opened in key order. */
	files: Readonly<Record<K, string>>
	/**
	 * Project-level default config. The on-disk `spyglass.json` of the fixture
	 * project (if any) is merged on top of this by `ConfigService.load()`.
	 */
	defaultConfig?: core.Config
	commands?: je.dependency.McmetaCommands
	tempPrefix?: string
}

export interface ServiceRuntime<K extends string> {
	service: core.Service
	/** Opened file URIs by test-local name. */
	uris: Readonly<Record<K, string>>
	/** Client-managed doc states by test-local name. */
	states: Readonly<Record<K, ServiceRuntimeState>>
	close: () => Promise<void>
}

/**
 * Boots a full `core.Service` (Project init + ready + `onDidOpen`) over an
 * on-disk fixture project. This is the Service-integration path (spike 5):
 * config resolution, URI binding, bind order, and lint all run exactly as the
 * language server would drive them, without the JSON-RPC transport layer.
 */
export async function createServiceRuntime<K extends string>(
	options: ServiceRuntimeOptions<K>,
): Promise<ServiceRuntime<K>> {
	const fixtureRoot = core.fileUtil.ensureEndingSlash(
		core.normalizeUri(new URL(`./runtime/${options.fixture}/`, import.meta.url).toString()),
	)
	const packMcmeta = fixtureUri(options.fixture, 'pack.mcmeta')
	const uris = Object.fromEntries(
		Object.entries<string>(options.files).map((
			[name, path],
		) => [name, fixtureUri(options.fixture, path)]),
	) as Record<K, string>

	const cacheDir = await mkdtemp(
		join(tmpdir(), options.tempPrefix ?? 'spyglass-imp-doc-service-'),
	)
	const initialize: core.ProjectInitializer = async (ctx) => {
		ctx.meta.registerUriBinder(je.binder.uriBinder)
		je.mcf.initialize(ctx, options.commands ?? DefaultCommands, '1.20.4')
		const impDoc = (await initializeImpDoc(ctx)) ?? {}
		return { ...impDoc, loadedVersion: '1.20.4', errorSource: '1.20.4' }
	}
	let service: core.Service | undefined
	try {
		service = new core.Service({
			logger: {
				error: () => {},
				info: () => {},
				log: () => {},
				warn: () => {},
			},
			project: {
				cacheRoot: core.fileUtil.ensureEndingSlash(pathToFileURL(cacheDir).toString()),
				defaultConfig: options.defaultConfig ?? createDefaultConfig(),
				externals: NodeJsExternals,
				initializers: [initialize],
				projectRoots: [fixtureRoot],
			},
		})

		await service.project.init()
		await service.project.ready({
			projectRootsWatcher: new ServiceFixtureWatcher([
				packMcmeta,
				...Object.values<string>(uris),
			]),
		})

		const states = {} as Record<K, ServiceRuntimeState>
		for (const name of Object.keys(uris) as K[]) {
			const uri = uris[name]
			const content = await readFile(new URL(uri), 'utf8')
			await service.project.onDidOpen(uri, 'mcfunction', 1, content)
			const result = service.project.getClientManaged(uri)
			assert.ok(result)
			states[name] = { ...result, content }
		}

		const createdService = service
		return {
			service: createdService,
			uris,
			states,
			close: async () => {
				await createdService.project.close()
				await rm(cacheDir, { recursive: true, force: true })
			},
		}
	} catch (e) {
		// The factory must reclaim the partially initialized Project and the temp dir
		// itself: a failure here means the caller never receives the close callback,
		// and a leaked Project would otherwise keep the test process alive.
		await service?.project.close().catch(() => {})
		await rm(cacheDir, { recursive: true, force: true }).catch(() => {})
		throw e
	}
}

export const ContractRuntimeFiles = {
	target: fixtureUri('private-project', 'data/contract/functions/target.mcfunction'),
	caller: fixtureUri('private-project', 'data/contract/functions/caller.mcfunction'),
} as const

export interface ContractRuntime {
	service: core.Service
	target: core.DocAndNode & { content: string }
	caller: core.DocAndNode & { content: string }
	close: () => Promise<void>
}

export async function createContractRuntime(): Promise<ContractRuntime> {
	const runtime = await createServiceRuntime({
		fixture: 'private-project',
		files: {
			target: 'data/contract/functions/target.mcfunction',
			caller: 'data/contract/functions/caller.mcfunction',
		},
		tempPrefix: 'spyglass-imp-doc-contract-',
	})
	return {
		service: runtime.service,
		target: runtime.states.target,
		caller: runtime.states.caller,
		close: runtime.close,
	}
}
