import type { AstNode, LanguageError, ProjectData } from '@spyglassmc/core'
import {
	AstNode as AstNodeUtil,
	binder as coreBinder,
	BinderContext,
	ErrorSeverity,
	Failure,
	LinterContext,
	LinterErrorReporter,
	ParserContext,
	Source,
	StateProxy,
	SymbolUtil,
	SyncBinder,
	traversePreOrder,
	UriBinderContext,
} from '@spyglassmc/core'
import { mockProjectData } from '@spyglassmc/core/test/utils.ts'
import type { JsonFileNode } from '@spyglassmc/json'
import { parser as jsonParser } from '@spyglassmc/json'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import {
	advancementCriteria,
	registerAdvancementCriteriaBinder,
} from '../../lib/binder/advancementCriteria.js'
import { uriBinder } from '../../lib/binder/index.js'
import { argument } from '../../lib/mcfunction/parser/index.js'
import type { ArgumentTreeNode } from '../../lib/mcfunction/tree/index.js'

const AdvancementUri = 'file:///data/test/advancement/foo.json'
const FunctionUri = 'file:///data/test/function/bar.mcfunction'
const LootTableUri = 'file:///data/test/loot_table/foo.json'

const AdvancementContent =
	'{"criteria": {"type-drowning": {"trigger": "minecraft:impossible"}}, "rewards": {}}'

const EntityTreeNode: ArgumentTreeNode = {
	type: 'argument',
	parser: 'minecraft:entity',
	properties: { amount: 'multiple', type: 'entities' },
}

function setup(): ProjectData {
	return mockProjectData({ roots: ['file:///'], ctx: { loadedVersion: '1.21' } })
}

/** Defines the resource itself, the way {@link uriBinder} does for every file of a project. */
function bindUri(project: ProjectData, uri: string): void {
	const ctx = UriBinderContext.create(project)
	ctx.symbols.contributeAs('uri_binder', () => {
		uriBinder([uri], ctx)
	})
}

function parseJson(project: ProjectData, uri: string, content: string): JsonFileNode {
	const ctx = ParserContext.create(project, {
		doc: TextDocument.create(uri, 'json', 0, content),
	})
	const node = jsonParser.file(new Source(content), ctx)
	assert.notEqual(node, Failure)
	AstNodeUtil.setParents(node as JsonFileNode)
	return node as JsonFileNode
}

/** Runs the whole `json:file` binder chain, as `Project#bind` would. */
function bindJson(project: ProjectData, uri: string, content: string): void {
	const node = parseJson(project, uri, content)
	const ctx = BinderContext.create(project, {
		doc: TextDocument.create(uri, 'json', 0, content),
	})
	const binder = project.meta.getBinder<JsonFileNode>('json:file')
	assert.ok(SyncBinder.is(binder), 'The json:file binder chain is not synchronous')
	ctx.symbols.contributeAs('binder', () => {
		binder(node, ctx)
	})
}

function parseSelector(project: ProjectData, text: string): AstNode {
	const parser = argument(EntityTreeNode, [])
	assert.ok(parser)
	const ctx = ParserContext.create(project, {
		doc: TextDocument.create(FunctionUri, 'mcfunction', 0, text),
	})
	const node = parser(new Source(text), ctx)
	assert.notEqual(node, Failure)
	assert.deepEqual(ctx.err.dump(), [])
	AstNodeUtil.setParents(node as AstNode)
	return node as AstNode
}

function bindSelector(project: ProjectData, node: AstNode, text: string): void {
	const ctx = BinderContext.create(project, {
		doc: TextDocument.create(FunctionUri, 'mcfunction', 0, text),
	})
	ctx.symbols.contributeAs('binder', () => {
		coreBinder.fallbackSync(node, ctx)
	})
}

/** Runs the `undeclaredSymbol` rule over the whole tree, as `Project#lint` would. */
function lintUndeclaredSymbols(
	project: ProjectData,
	node: AstNode,
	text: string,
): readonly LanguageError[] {
	const { linter, nodePredicate } = project.meta.getLinter('undeclaredSymbol')
	const err = new LinterErrorReporter('undeclaredSymbol', ErrorSeverity.Warning)
	const ctx = LinterContext.create(project, {
		doc: TextDocument.create(FunctionUri, 'mcfunction', 0, text),
		err,
		ruleName: 'undeclaredSymbol',
		ruleValue: { report: 'warning' },
	})
	traversePreOrder(node, () => true, () => true, (child) => {
		if (nodePredicate(child)) {
			linter(StateProxy.create(child), ctx)
		}
	})
	return [...err.dump()]
}

function lookupCriterion(project: ProjectData, advancement: string, criterion: string) {
	return SymbolUtil.lookupTable(project.symbols.global, 'advancement', [advancement, criterion])
		.symbol
}

describe('advancementCriteria', () => {
	it('Defines the criteria of an advancement while binding it', () => {
		const project = setup()
		bindUri(project, AdvancementUri)
		const node = parseJson(project, AdvancementUri, AdvancementContent)
		const ctx = BinderContext.create(project, {
			doc: TextDocument.create(AdvancementUri, 'json', 0, AdvancementContent),
		})
		ctx.symbols.contributeAs('binder', () => {
			advancementCriteria(node, ctx)
		})

		const criterion = lookupCriterion(project, 'test:foo', 'type-drowning')
		assert.ok(SymbolUtil.isDeclared(criterion), 'The criterion was not declared')
		assert.equal(criterion!.subcategory, 'criterion')
		const location = criterion!.definition![0]
		assert.equal(location.contributor, 'binder')
		// The location has to exclude the surrounding quotes of the JSON key.
		const start = AdvancementContent.indexOf('type-drowning')
		assert.deepEqual(location.range, { start, end: start + 'type-drowning'.length })
	})

	it('Ignores files of other categories', () => {
		const project = setup()
		bindUri(project, LootTableUri)
		const node = parseJson(project, LootTableUri, AdvancementContent)
		const ctx = BinderContext.create(project, {
			doc: TextDocument.create(LootTableUri, 'json', 0, AdvancementContent),
		})
		ctx.symbols.contributeAs('binder', () => {
			advancementCriteria(node, ctx)
		})

		assert.equal(lookupCriterion(project, 'test:foo', 'type-drowning'), undefined)
	})

	it('Does not report a selector criterion whose advancement was only bound', () => {
		const project = setup()
		registerAdvancementCriteriaBinder(project.meta)
		bindUri(project, AdvancementUri)
		bindUri(project, FunctionUri)
		bindJson(project, AdvancementUri, AdvancementContent)

		const text = '@s[advancements={test:foo={type-drowning=true}}]'
		const selector = parseSelector(project, text)
		bindSelector(project, selector, text)

		assert.deepEqual(lintUndeclaredSymbols(project, selector, text), [])
	})

	it('Still reports a selector criterion that the advancement does not define', () => {
		const project = setup()
		registerAdvancementCriteriaBinder(project.meta)
		bindUri(project, AdvancementUri)
		bindUri(project, FunctionUri)
		bindJson(project, AdvancementUri, AdvancementContent)

		const text = '@s[advancements={test:foo={type-lava=true}}]'
		const selector = parseSelector(project, text)
		bindSelector(project, selector, text)

		const errors = lintUndeclaredSymbols(project, selector, text)
		assert.equal(errors.length, 1)
		assert.match(errors[0].message, /type-lava/)
	})

	it('Chains onto an already registered json:file binder instead of replacing it', () => {
		const project = setup()
		let previousCalls = 0
		project.meta.registerBinder<JsonFileNode>('json:file', () => {
			previousCalls += 1
		})
		registerAdvancementCriteriaBinder(project.meta)
		bindUri(project, AdvancementUri)
		bindJson(project, AdvancementUri, AdvancementContent)

		assert.equal(previousCalls, 1)
		assert.ok(SymbolUtil.isDeclared(lookupCriterion(project, 'test:foo', 'type-drowning')))
	})

	it('Does not dispatch back into itself when no json:file binder was registered', () => {
		const project = setup()
		registerAdvancementCriteriaBinder(project.meta)
		bindUri(project, AdvancementUri)
		bindJson(project, AdvancementUri, AdvancementContent)

		assert.ok(SymbolUtil.isDeclared(lookupCriterion(project, 'test:foo', 'type-drowning')))
	})
})
