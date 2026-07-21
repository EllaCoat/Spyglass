import * as core from '@spyglassmc/core'
import { NodeJsExternals } from '@spyglassmc/core/lib/nodejs.js'
import * as je from '@spyglassmc/java-edition'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { initialize as initializeImpDoc } from '../lib/index.js'

/**
 * P4-3b: `mcfunction:entity` usage-site soft ref binder (v3
 * `EntityArgumentParser.ts:133-142` parity、 spike 1 判断 B)。
 * - `#declare entity` 済みの plain name = reference 記録 + `node.symbol` 接続
 * - 未宣言の plain name = error なし + junk symbol も作らない (soft)
 * - selector 配下の nested binder (selector 引数の `tag` 等) は引き続き降ろす
 */

const FixtureRoot = core.fileUtil.ensureEndingSlash(
	core.normalizeUri(new URL('./runtime/private-project/', import.meta.url).toString()),
)

const Files = {
	aliases: core.normalizeUri(
		new URL(
			'./runtime/private-project/data/owner/functions/aliases.mcfunction',
			import.meta.url,
		).toString(),
	),
	entityUser: core.normalizeUri(
		new URL(
			'./runtime/private-project/data/owner/functions/entity_user.mcfunction',
			import.meta.url,
		).toString(),
	),
	orderConsumer: core.normalizeUri(
		new URL(
			'./runtime/private-project/data/order/functions/a_consumer.mcfunction',
			import.meta.url,
		).toString(),
	),
	orderDeclaration: core.normalizeUri(
		new URL(
			'./runtime/private-project/data/order/functions/z_declaration.mcfunction',
			import.meta.url,
		).toString(),
	),
} as const

const Commands: je.dependency.McmetaCommands = {
	type: 'root',
	children: {
		kill: {
			type: 'literal',
			children: {
				targets: {
					type: 'argument',
					parser: 'minecraft:entity',
					properties: { amount: 'multiple', type: 'entities' },
					executable: true,
				},
			},
		},
	},
}

class FixtureWatcher extends core.EventDispatcher<core.FileWatcherEventMap>
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
	lint['impDocPrivate'] = 'error'
	return config
}

describe('IMP-Doc entity usage-site binder (P4-3b)', () => {
	let project: core.Project | undefined
	let cacheDir: string | undefined
	let entityUser: (core.DocAndNode & { content: string }) | undefined

	before(async () => {
		cacheDir = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-entity-'))
		const packMcmeta = core.normalizeUri(
			new URL('./runtime/private-project/pack.mcmeta', import.meta.url).toString(),
		)
		project = new core.Project({
			cacheRoot: core.fileUtil.ensureEndingSlash(
				pathToFileURL(cacheDir).toString(),
			),
			defaultConfig: createConfig(),
			externals: NodeJsExternals,
			initializers: [async (ctx) => {
				ctx.meta.registerUriBinder(je.binder.uriBinder)
				je.mcf.initialize(ctx, Commands, '1.20.4')
				await initializeImpDoc(ctx)
				// Make the consumer-before-declaration fixture order explicit instead of
				// relying on watcher insertion stability.
				ctx.meta.setUriSorter((a, b, next) => a.localeCompare(b) || next(a, b))
				return { loadedVersion: '1.20.4', errorSource: '1.20.4' }
			}],
			logger: {
				error: () => {},
				info: () => {},
				log: () => {},
				warn: () => {},
			},
			projectRoots: [FixtureRoot],
		})

		await project.init()
		await project.ready({
			projectRootsWatcher: new FixtureWatcher([packMcmeta, ...Object.values(Files)]),
		})

		const content = await readFile(fileURLToPath(Files.entityUser), 'utf8')
		await project.onDidOpen(Files.entityUser, 'mcfunction', 1, content)
		const result = project.getClientManaged(Files.entityUser)
		assert.ok(result)
		entityUser = { ...result, content }
	})

	after(async () => {
		await project?.close()
		if (cacheDir) {
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})

	it('records a soft reference for a declared entity name', () => {
		assert.ok(project && entityUser)
		const symbol = project.symbols.lookup('entity', ['runtime_entity']).symbol
		assert.ok(symbol, 'the #declare entity symbol should exist')

		const nameStart = entityUser.content.indexOf('runtime_entity')
		assert.notEqual(nameStart, -1)
		assert.ok(
			symbol.reference?.some(location =>
				location.uri === Files.entityUser
				&& location.range?.start === nameStart
				&& location.range?.end === nameStart + 'runtime_entity'.length
			),
			'the plain-name usage should be recorded as a reference',
		)
	})

	it('resolves a cache-backed consumer bound before its declaration without opening or rebinding it', () => {
		assert.ok(project)
		assert.equal(project.getClientManaged(Files.orderConsumer), undefined)
		const symbol = project.symbols.lookup('entity', ['deferred_entity']).symbol
		assert.ok(symbol, 'the later #declare entity symbol should exist')
		assert.ok(
			symbol.reference?.some(location => location.uri === Files.orderConsumer),
			'the consumer-first usage should be resolved after declaration bind',
		)
	})

	it('wires node.symbol so the core hover / definition / references consumers work', () => {
		assert.ok(project && entityUser)
		const nameStart = entityUser.content.indexOf('runtime_entity')
		const node = core.AstNode.findDeepestChild({
			node: entityUser.node,
			needle: nameStart + 1,
			predicate: () => true,
		})
		let head: core.AstNode | undefined = node as core.AstNode | undefined
		while (head && !head.symbol) {
			head = head.parent
		}
		assert.ok(head, 'a node covering the name should carry the bound symbol')
		assert.ok(head.symbol)
		assert.equal(head.symbol.category, 'entity')
		assert.equal(head.symbol.identifier, 'runtime_entity')
	})

	it('still binds nested selector-argument symbols below mcfunction:entity', () => {
		assert.ok(project && entityUser)
		const symbol = project.symbols.lookup('tag', ['RuntimeTag']).symbol
		assert.ok(symbol, 'selector argument binders must keep running under the entity binder')
		assert.ok(
			symbol.reference?.some(location => location.uri === Files.entityUser),
		)
	})

	it('reports no error and creates no symbol for an undeclared plain name', async () => {
		assert.ok(project)
		const uri = core.normalizeUri(
			new URL(
				'./runtime/private-project/data/owner/functions/entity_soft.mcfunction',
				import.meta.url,
			).toString(),
		)
		await project.onDidOpen(
			uri,
			'mcfunction',
			1,
			'#> owner:entity_soft\n# @public\n\nkill nobody\n',
		)
		const state = project.getClientManaged(uri)
		assert.ok(state)
		assert.deepEqual(state.node.binderErrors ?? [], [])
		assert.deepEqual(state.node.linterErrors ?? [], [])
		assert.equal(project.symbols.lookup('entity', ['nobody']).symbol, undefined)
		await project.onDidClose(uri)
	})

	it('does not apply strict private lint to a restricted entity reference', async () => {
		assert.ok(project)
		const uri = core.normalizeUri(
			new URL(
				'./runtime/private-project/data/external/functions/restricted_entity_user.mcfunction',
				import.meta.url,
			).toString(),
		)
		const content = '#> external:restricted_entity_user\n# @public\n\nkill restricted_entity\n'
		await project.onDidOpen(uri, 'mcfunction', 1, content)
		const state = project.getClientManaged(uri)
		assert.ok(state)

		const symbol = project.symbols.lookup('entity', ['restricted_entity']).symbol
		assert.ok(symbol)
		// SymbolVisibility.Restricted = 3 (const enum、 数値照合)。
		assert.equal(symbol.visibility, 3, 'positive control: the entity must be restricted')
		assert.ok(
			symbol.reference?.some(location => location.uri === uri),
			'positive control: the restricted entity usage must be bound as a reference',
		)
		assert.deepEqual(state.node.linterErrors ?? [], [])
		await project.onDidClose(uri)
	})

	it('keeps the public entity usage free of visibility violations', () => {
		assert.ok(entityUser)
		assert.deepEqual(entityUser.node.linterErrors ?? [], [])
	})
})
