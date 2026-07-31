import * as core from '@spyglassmc/core'
import { fileUtil } from '@spyglassmc/core'
import { getNodeJsExternals } from '@spyglassmc/core/lib/nodejs.js'
import * as je from '@spyglassmc/java-edition'
import * as locales from '@spyglassmc/locales'
import * as mcdoc from '@spyglassmc/mcdoc'
import * as impDoc from '@spyglassmc/tsb-imp-doc'
import envPaths from 'env-paths'
import url from 'url'
import * as util from 'util'
import * as ls from 'vscode-languageserver/node.js'
import type {
	CustomInitializationOptions,
	CustomServerCapabilities,
	MyLspAnalyzeProjectResult,
	MyLspDataHackPubifyRequestParams,
} from './util/index.js'
import { toCore, toLS, unavailable } from './util/index.js'
import { LspFileWatcher } from './util/LspFileWatcher.js'

export * from './util/types.js'

if (process.argv.length === 2) {
	// When the server is launched from the cmd script, the process arguments
	// are wiped. I don't know why it happens, but this is what it is.
	// Therefore, we push a '--stdio' if the argument list is too short.
	process.argv.push('--stdio')
}

const { cache: cacheRootPath } = envPaths('spyglassmc')
const cacheRoot = fileUtil.ensureEndingSlash(url.pathToFileURL(cacheRootPath).toString())

const connection = ls.createConnection()
/**
 * The last diagnostics notification sent for each URI, as the serialized payload that went out and
 * the version it went out with.
 *
 * A publish is skipped only when both match. The version is part of the comparison because the
 * same diagnostics are published under versions that mean different things — the editor's version
 * for a client-managed document, `-1` for one read from disk, none at all for the empty set that
 * retracts a removed document's diagnostics — and an empty payload is a payload like any other:
 * the diagnostics a client displays stay on screen until an empty set that differs from what it
 * last received takes them away.
 */
const lastSentDiagnostics = new Map<string, { payload: string; version: number | undefined }>()
let capabilities!: ls.ClientCapabilities
let workspaceFolders!: ls.WorkspaceFolder[]
let projectRoots!: core.RootUriString[]
let hasShutdown = false

const initializeJavaEditionAndImpDoc: core.ProjectInitializer = async (ctx) => {
	const jeContext = (await je.initialize(ctx)) ?? {}
	const impDocContext = (await impDoc.initialize(ctx)) ?? {}
	return { ...jeContext, ...impDocContext }
}

const logger: core.Logger = {
	error: (msg: any, ...args: any[]): void => connection.console.error(util.format(msg, ...args)),
	info: (msg: any, ...args: any[]): void => connection.console.info(util.format(msg, ...args)),
	log: (msg: any, ...args: any[]): void => connection.console.log(util.format(msg, ...args)),
	warn: (msg: any, ...args: any[]): void => connection.console.warn(util.format(msg, ...args)),
}
const externals = getNodeJsExternals({ cacheRoot, logger })
let service!: core.Service

function buildSemanticTokensCapability(isDynamic: boolean): ls.SemanticTokensRegistrationOptions {
	// Always register everything for static registration, so all changes to the config can be
	// processed by the request handlers instead
	const semanticTokensConfig = service.project.config.env.feature.semanticColoring
	let disabledLanguages: string[] = []
	if (
		isDynamic && typeof semanticTokensConfig === 'object'
		&& Array.isArray(semanticTokensConfig.disabledLanguages)
	) {
		disabledLanguages = semanticTokensConfig.disabledLanguages
	}
	return {
		documentSelector: toLS.documentSelector(
			service.project.meta,
			{ disabledLanguages },
		),
		legend: toLS.semanticTokensLegend(),
		full: { delta: false },
		range: true,
	}
}

connection.onInitialize(async (params) => {
	const initializationOptions = params.initializationOptions as
		| CustomInitializationOptions
		| undefined

	logger.info(`[onInitialize] processId = ${JSON.stringify(params.processId)}`)
	logger.info(`[onInitialize] clientInfo = ${JSON.stringify(params.clientInfo)}`)
	logger.info(`[onInitialize] initializationOptions = ${JSON.stringify(initializationOptions)}`)

	capabilities = params.capabilities
	workspaceFolders = params.workspaceFolders ?? []
	projectRoots = workspaceFolders.map(f => core.fileUtil.ensureEndingSlash(f.uri))

	if (initializationOptions?.inDevelopmentMode) {
		await new Promise((resolve) => setTimeout(resolve, 3000))
		logger.warn(
			'Delayed 3 seconds manually. If you see this in production, it means SPGoding messed up.',
		)
	}

	try {
		await locales.loadLocale(params.locale)
	} catch (e) {
		logger.error('[loadLocale]', e)
	}

	try {
		service = new core.Service({
			isDebugging: initializationOptions?.inDevelopmentMode,
			logger,
			profilers: new core.ProfilerFactory(logger, [
				'cache#load',
				'cache#save',
				'project#analyzeProject',
				'project#init',
				'project#ready',
				'project#ready#bind',
			]),
			project: {
				defaultConfig: core.ConfigService.merge(
					core.VanillaConfig,
					initializationOptions?.defaultConfig ?? {},
				),
				cacheRoot,
				externals,
				initializers: [mcdoc.initialize, initializeJavaEditionAndImpDoc],
				projectRoots,
			},
		})
		service.project.on('documentErrored', async ({ errors, uri, version }) => {
			if (uri.startsWith('archive://')) {
				const clientUri = service.project.getClientManagedUri(uri)
				if (!clientUri) {
					return
				}
				uri = clientUri
			}

			const diagnostics = toLS.diagnostics(errors)
			const payload = JSON.stringify(diagnostics)
			const previous = lastSentDiagnostics.get(uri)
			if (previous && previous.version === version && previous.payload === payload) {
				// Notifying a client of the state it is already in is not free on its side: VS Code
				// rebuilds the problems view around the new markers, which closes a hover open over
				// one of them, which sends the requests that produced this publish all over again.
				return
			}
			// Recorded before the notification rather than after it, so that the record follows the
			// order the notifications go out in rather than the order their promises settle in.
			lastSentDiagnostics.set(uri, { payload, version })
			try {
				await connection.sendDiagnostics({ diagnostics, uri, version })
			} catch (e) {
				// Nothing reached the client, so the next publish of these very diagnostics is a
				// publish the client still needs.
				lastSentDiagnostics.delete(uri)
				console.error('[sendDiagnostics]', e)
			}
		}).on('ready', async () => {
			await connection.sendProgress(ls.WorkDoneProgress.type, 'initialize', { kind: 'end' })
		})
		await service.project.init()
	} catch (e) {
		logger.error('[new Service]', e)
	}

	let semanticTokensProvider: ls.SemanticTokensRegistrationOptions | undefined = undefined
	if (!capabilities.textDocument?.semanticTokens?.dynamicRegistration) {
		logger.info(
			"[startDynamicSemanticTokensRegistration] LanguageClient didn't permit dynamic registration for semantic tokens. Registering semantic tokens statically instead...",
		)
		semanticTokensProvider = buildSemanticTokensCapability(false)
	}

	const customCapabilities: CustomServerCapabilities = {
		analyzeProject: true,
		dataHackPubify: true,
		resetProjectCache: true,
		showCacheRoot: true,
	}

	const ans: ls.InitializeResult = {
		serverInfo: { name: 'Spyglass Language Server' },
		capabilities: {
			codeActionProvider: {},
			colorProvider: {},
			completionProvider: { triggerCharacters: service.project.meta.getTriggerCharacters() },
			declarationProvider: {},
			definitionProvider: {},
			implementationProvider: {},
			referencesProvider: {},
			typeDefinitionProvider: {},
			documentHighlightProvider: {},
			documentSymbolProvider: { label: 'Spyglass' },
			hoverProvider: {},
			inlayHintProvider: {},
			semanticTokensProvider,
			signatureHelpProvider: { triggerCharacters: [' '] },
			textDocumentSync: { change: ls.TextDocumentSyncKind.Incremental, openClose: true },
			workspaceSymbolProvider: {},
			experimental: { spyglassmc: customCapabilities },
		},
	}

	if (capabilities.workspace?.workspaceFolders) {
		ans.capabilities.workspace = {
			workspaceFolders: { supported: true, changeNotifications: true },
		}
	}

	return ans
})

connection.onInitialized(async () => {
	if (capabilities.textDocument?.formatting?.dynamicRegistration) {
		void connection.client.register(
			ls.DocumentFormattingRequest.type,
			{ documentSelector: [{ language: 'mcdoc' }] },
		)
	}
	if (capabilities.workspace?.didChangeConfiguration?.dynamicRegistration) {
		void connection.client.register(
			ls.DidChangeConfigurationNotification.type,
			{ section: ['spyglassmc'] },
		)
	}

	// In case the initializationOptions were incomplete (for example because the client doesn't support them)
	await updateEditorConfiguration()

	startDynamicSemanticTokensRegistration()

	// Initializes LspFileWatcher only when client supports didChangeWatchedFiles notifications.
	const fileWatcher = capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration
		? new LspFileWatcher({
			capabilities,
			connection,
			externals,
			locations: projectRoots,
			logger,
			predicate: (uri) => !service.project.shouldExclude(uri),
		})
			.on('ready', () => logger.info('[FileWatcher] ready'))
			.on('add', (uri) => logger.info('[FileWatcher] added', uri))
			.on('change', (uri) => logger.info('[FileWatcher] changed', uri))
			.on('unlink', (uri) => logger.info('[FileWatcher] unlinked', uri))
			.on('error', (e) => logger.error('[FileWatcher]', e))
		: undefined

	if (fileWatcher) {
		// Listen for config changes and reconcile the internal state of the file watcher if
		// `env.exclude` has changed.
		service.project.on('configChanged', async ({ oldConfig, newConfig }) => {
			const oldExclude = new Set(oldConfig.env.exclude)
			const newExclude = new Set(newConfig.env.exclude)
			if (oldExclude.size === newExclude.size && oldExclude.isSubsetOf(newExclude)) {
				// `env.exclude` has not changed. Skip.
				return
			}

			logger.info('[FileWatcher] env.exclude config has changed. Reconciling...')
			for (const root of projectRoots) {
				await fileWatcher.reconcile(root)
			}
		})
	}

	await service.project.ready({
		projectRootsWatcher: fileWatcher,
	})

	if (capabilities.workspace?.workspaceFolders) {
		connection.workspace.onDidChangeWorkspaceFolders(async () => {
			// FIXME
			// service.rawRoots = (await connection.workspace.getWorkspaceFolders() ?? []).map(r => r.uri)
		})
	}
})

function startDynamicSemanticTokensRegistration() {
	// If the client permits it, semantic tokens are registered dynamically, such that if they are disabled in the config, the language client
	// knows that Spyglass won't be providing tokens instead of just receiving an empty tokens list.
	// This could otherwise cause problems with other language servers if the client decides to override their semantic tokens
	// with the empty tokens list provided by Spyglass.

	if (!capabilities.textDocument?.semanticTokens?.dynamicRegistration) {
		return
	}

	let dynamicSemanticTokensDiposable: Promise<ls.Disposable> | undefined = undefined

	function registerDynamicSemanticTokens() {
		if (dynamicSemanticTokensDiposable !== undefined) {
			return
		}
		logger.info('[registerDynamicSemanticTokens] Registering dynamic semantic tokens')
		dynamicSemanticTokensDiposable = connection.client.register(
			ls.SemanticTokensRegistrationType.type,
			buildSemanticTokensCapability(true),
		)
	}

	function unregisterDynamicSemanticTokens() {
		logger.info('[unregisterDynamicSemanticTokens] Unregistering dynamic semantic tokens')
		void dynamicSemanticTokensDiposable?.then(disposable => disposable.dispose())
		dynamicSemanticTokensDiposable = undefined
	}

	if (service.project.config.env.feature.semanticColoring) {
		registerDynamicSemanticTokens()
	}

	function didConfigChange(
		oldSemanticTokensConfig: boolean | { disabledLanguages?: string[] },
		newSemanticTokensConfig: boolean | { disabledLanguages?: string[] },
	): boolean {
		if (oldSemanticTokensConfig === newSemanticTokensConfig) {
			return false
		}
		if (
			typeof oldSemanticTokensConfig !== 'object'
			|| typeof newSemanticTokensConfig !== 'object'
		) {
			return true
		}
		if (
			!oldSemanticTokensConfig.disabledLanguages
			&& !newSemanticTokensConfig.disabledLanguages
		) {
			return false
		}
		if (
			Array.isArray(oldSemanticTokensConfig.disabledLanguages)
			&& Array.isArray(newSemanticTokensConfig.disabledLanguages)
			&& oldSemanticTokensConfig.disabledLanguages.length
				=== newSemanticTokensConfig.disabledLanguages.length
			&& oldSemanticTokensConfig.disabledLanguages.every((language, index) =>
				language === newSemanticTokensConfig.disabledLanguages!![index]
			)
		) {
			return false
		}
		return true
	}

	service.project.on('configChanged', ({ oldConfig, newConfig }) => {
		const oldSemanticTokensConfig = oldConfig.env.feature.semanticColoring
		const newSemanticTokensConfig = newConfig.env.feature.semanticColoring

		if (!didConfigChange(oldSemanticTokensConfig, newSemanticTokensConfig)) {
			return
		}

		if (oldSemanticTokensConfig) {
			unregisterDynamicSemanticTokens()
		}
		if (newSemanticTokensConfig) {
			registerDynamicSemanticTokens()
		}
	})
}

connection.onDidOpenTextDocument(
	({ textDocument: { text, uri, version, languageId: languageID } }) => {
		return service.project.onDidOpen(uri, languageID, version, text)
	},
)
connection.onDidChangeTextDocument(({ contentChanges, textDocument: { uri, version } }) => {
	return service.project.onDidChange(uri, contentChanges, version)
})
connection.onDidCloseTextDocument(({ textDocument: { uri } }) => {
	return service.project.onDidClose(uri)
})

connection.onCodeAction(({ textDocument: { uri }, range }) => {
	return service.project.withClientFeatureAccess(uri, (access) => {
		if (!service.project.config.env.feature.codeActions) {
			return undefined
		}
		if (access.kind !== 'checked') {
			return unavailable.codeAction(access.reason)
		}
		const { doc, node } = access
		const codeActions = service.getCodeActions(node, doc, toCore.range(range, doc))
		return codeActions.map(a => toLS.codeAction(a, doc))
	})
})

connection.onColorPresentation(({ textDocument: { uri }, color, range }) => {
	return service.project.withClientFeatureAccess(uri, (access) => {
		if (access.kind !== 'checked') {
			return unavailable.colorPresentation(access.reason)
		}
		const { doc, node } = access
		const presentation = service.getColorPresentation(
			node,
			doc,
			toCore.range(range, doc),
			toCore.color(color),
		)
		return toLS.colorPresentationArray(presentation, doc)
	})
})
connection.onDocumentColor(({ textDocument: { uri } }) => {
	return service.project.withClientFeatureAccess(uri, (access) => {
		if (!service.project.config.env.feature.colors) {
			return undefined
		}
		if (access.kind !== 'checked') {
			return unavailable.documentColor(access.reason)
		}
		const { doc, node } = access
		const info = service.getColorInfo(node, doc)
		return toLS.colorInformationArray(info, doc)
	})
})

connection.onCompletion(({ textDocument: { uri }, position, context }) => {
	return service.project.withClientFeatureAccess(uri, (access) => {
		if (!service.project.config.env.feature.completions) {
			return undefined
		}
		if (access.kind !== 'checked') {
			return unavailable.completion(access.reason)
		}
		const { doc, node } = access
		const offset = toCore.offset(position, doc)
		const items = service.complete(node, doc, offset, context?.triggerCharacter)
		return items.map((item) =>
			toLS.completionItem(
				item,
				doc,
				offset,
				capabilities.textDocument?.completion?.completionItem?.insertReplaceSupport,
			)
		)
	})
})

connection.onRequest(
	'spyglassmc/dataHackPubify',
	({ initialism }: MyLspDataHackPubifyRequestParams) => {
		return service.dataHackPubify(initialism)
	},
)

connection.onDeclaration(({ textDocument: { uri }, position }) => {
	return service.project.withClientFeatureAccess(uri, async (access) => {
		if (access.kind !== 'checked') {
			return unavailable.declaration(access.reason)
		}
		const { doc, node } = access
		const ans = await service.getSymbolLocations(node, doc, toCore.offset(position, doc), [
			'declaration',
			'definition',
		])
		return toLS.locationLink(ans, doc, capabilities.textDocument?.declaration?.linkSupport)
	})
})
connection.onDefinition(({ textDocument: { uri }, position }) => {
	return service.project.withClientFeatureAccess(uri, async (access) => {
		if (access.kind !== 'checked') {
			return unavailable.definition(access.reason)
		}
		const { doc, node } = access
		const ans = await service.getSymbolLocations(node, doc, toCore.offset(position, doc), [
			'definition',
			'declaration',
			'implementation',
			'typeDefinition',
		])
		return toLS.locationLink(ans, doc, capabilities.textDocument?.definition?.linkSupport)
	})
})
connection.onImplementation(({ textDocument: { uri }, position }) => {
	return service.project.withClientFeatureAccess(uri, async (access) => {
		if (access.kind !== 'checked') {
			return unavailable.implementation(access.reason)
		}
		const { doc, node } = access
		const ans = await service.getSymbolLocations(node, doc, toCore.offset(position, doc), [
			'implementation',
			'definition',
		])
		return toLS.locationLink(ans, doc, capabilities.textDocument?.implementation?.linkSupport)
	})
})
connection.onReferences(({ textDocument: { uri }, position, context: { includeDeclaration } }) => {
	return service.project.withClientFeatureAccess(uri, async (access) => {
		if (access.kind !== 'checked') {
			return unavailable.references(access.reason)
		}
		const { doc, node } = access
		const ans = await service.getSymbolLocations(
			node,
			doc,
			toCore.offset(position, doc),
			includeDeclaration ? undefined : ['reference'],
		)
		return toLS.locationLink(ans, doc, false)
	})
})
connection.onTypeDefinition(({ textDocument: { uri }, position }) => {
	return service.project.withClientFeatureAccess(uri, async (access) => {
		if (access.kind !== 'checked') {
			return unavailable.typeDefinition(access.reason)
		}
		const { doc, node } = access
		const ans = await service.getSymbolLocations(node, doc, toCore.offset(position, doc), [
			'typeDefinition',
		])
		return toLS.locationLink(ans, doc, capabilities.textDocument?.typeDefinition?.linkSupport)
	})
})

connection.onDocumentHighlight(({ textDocument: { uri }, position }) => {
	return service.project.withClientFeatureAccess(uri, async (access) => {
		if (!service.project.config.env.feature.documentHighlighting) {
			return undefined
		}
		if (access.kind !== 'checked') {
			return unavailable.documentHighlight(access.reason)
		}
		const { doc, node } = access
		const ans = await service.getSymbolLocations(
			node,
			doc,
			toCore.offset(position, doc),
			undefined,
			true,
		)
		return toLS.documentHighlight(ans)
	})
})

connection.onDocumentSymbol(({ textDocument: { uri } }) => {
	return service.project.withClientFeatureAccess(uri, (access) => {
		if (access.kind !== 'checked') {
			return unavailable.documentSymbol(access.reason)
		}
		const { doc, node } = access
		// The global table is read from inside the callback, which is the whole point of holding
		// the lifecycle operation open around it.
		return toLS.documentSymbolsFromTables(
			[service.project.symbols.global, ...core.AstNode.getLocalsToLeaves(node)],
			doc,
			capabilities.textDocument?.documentSymbol?.hierarchicalDocumentSymbolSupport,
			capabilities.textDocument?.documentSymbol?.symbolKind?.valueSet,
		)
	})
})

connection.onHover(({ textDocument: { uri }, position }) => {
	return service.project.withClientFeatureAccess(uri, (access) => {
		if (!service.project.config.env.feature.hover) {
			return undefined
		}
		if (access.kind !== 'checked') {
			return unavailable.hover(access.reason)
		}
		const { doc, node } = access
		const ans = service.getHover(node, doc, toCore.offset(position, doc))
		return ans ? toLS.hover(ans, doc) : undefined
	})
})

connection.languages.inlayHint.on(({ textDocument: { uri }, range }) => {
	return service.project.withClientFeatureAccess(uri, (access) => {
		if (access.kind !== 'checked') {
			return unavailable.inlayHint(access.reason)
		}
		const { doc, node } = access
		const hints = service.getInlayHints(node, doc, toCore.range(range, doc))
		return toLS.inlayHints(hints, doc)
	})
})

let isAnalyzingProject = false
connection.onRequest(
	'spyglassmc/analyzeProject',
	async (token: ls.CancellationToken): Promise<MyLspAnalyzeProjectResult | undefined> => {
		if (isAnalyzingProject) {
			return undefined
		}
		isAnalyzingProject = true

		const abortController = new AbortController()
		token.onCancellationRequested(() => abortController.abort())

		let reporter: ls.WorkDoneProgressServerReporter | undefined
		if (capabilities.window?.workDoneProgress) {
			reporter = await connection.window.createWorkDoneProgress()
			reporter.token.onCancellationRequested(() => abortController.abort())
			reporter.begin(
				locales.localize('server.progress.analyze-project.title'),
				0,
				undefined,
				true,
			)
		}

		let lastPercentage = 0
		try {
			return await service.project.analyzeProject({
				onProgress: (done, total, phase) => {
					// Both phases walk the whole file list, so each of them owns half of the
					// bar instead of running it from 0 to 100 twice.
					const percentage = (phase === 'prepare' ? 0 : 50)
						+ Math.floor(done / total * 50)
					if (percentage > lastPercentage) {
						lastPercentage = percentage
						reporter?.report(percentage, `${done}/${total}`)
					}
				},
				signal: abortController.signal,
			})
		} finally {
			reporter?.done()
			isAnalyzingProject = false
		}
	},
)

connection.onRequest('spyglassmc/resetProjectCache', async (): Promise<void> => {
	return service.project.reset()
})

connection.onRequest('spyglassmc/showCacheRoot', async (): Promise<void> => {
	return service.project.showCacheRoot()
})

connection.languages.semanticTokens.on(({ textDocument: { uri } }) => {
	return service.project.withClientFeatureAccess(uri, (access) => {
		if (!service.project.config.env.feature.semanticColoring) {
			return { data: [] }
		}
		if (access.kind !== 'checked') {
			return unavailable.semanticTokens(access.reason)
		}
		const { doc, node } = access
		const tokens = service.colorize(node, doc)
		return toLS.semanticTokens(
			tokens,
			doc,
			capabilities.textDocument?.semanticTokens?.multilineTokenSupport,
		)
	})
})
connection.languages.semanticTokens.onRange(({ textDocument: { uri }, range }) => {
	return service.project.withClientFeatureAccess(uri, (access) => {
		if (!service.project.config.env.feature.semanticColoring) {
			return { data: [] }
		}
		if (access.kind !== 'checked') {
			return unavailable.semanticTokens(access.reason)
		}
		const { doc, node } = access
		const tokens = service.colorize(node, doc, toCore.range(range, doc))
		return toLS.semanticTokens(
			tokens,
			doc,
			capabilities.textDocument?.semanticTokens?.multilineTokenSupport,
		)
	})
})

connection.onSignatureHelp(({ textDocument: { uri }, position }) => {
	return service.project.withClientFeatureAccess(uri, (access) => {
		if (!service.project.config.env.feature.signatures) {
			return undefined
		}
		if (access.kind !== 'checked') {
			return unavailable.signatureHelp(access.reason)
		}
		const { doc, node } = access
		const help = service.getSignatureHelp(node, doc, toCore.offset(position, doc))
		return toLS.signatureHelp(help)
	})
})

connection.onWorkspaceSymbol(({ query }) => {
	return service.project.withGlobalSymbolAccess((access) => {
		if (access.kind !== 'readable') {
			return unavailable.workspaceSymbol(access.reason)
		}
		return toLS.symbolInformationArrayFromTable(
			access.symbols,
			query,
			capabilities.textDocument?.documentSymbol?.symbolKind?.valueSet,
		)
	})
})

connection.onDocumentFormatting(({ textDocument: { uri }, options }) => {
	return service.project.withClientFeatureAccess(uri, (access) => {
		if (!service.project.config.env.feature.formatting) {
			return undefined
		}
		if (access.kind !== 'checked') {
			return unavailable.documentFormatting(access.reason)
		}
		const { doc, node } = access
		if (node.parserErrors.length !== 0) {
			// Don't format if there are errors.
			return undefined
		}
		let text = service.format(node, doc, options.tabSize, options.insertSpaces)
		if (options.insertFinalNewline && text.charAt(text.length - 1) !== '\n') {
			text += '\n'
		}
		return [toLS.textEdit(node.range, text, doc)]
	})
})

connection.onDidChangeConfiguration(updateEditorConfiguration)
async function updateEditorConfiguration() {
	const settings = await connection.workspace.getConfiguration({ section: 'spyglassmc' })
	const config = core.PartialConfig.buildConfigFromEditorSettingsSafe(settings)
	await service.project.onEditorConfigurationUpdate(config)
}

connection.onShutdown(async (): Promise<void> => {
	await service.project.close()
	hasShutdown = true
})
connection.onExit((): void => {
	connection.dispose()
	if (!hasShutdown) {
		console.error(
			'The server has not finished the shutdown request before receiving the exit request.',
		)
		process.exitCode = 1
	}
})

connection.listen()
