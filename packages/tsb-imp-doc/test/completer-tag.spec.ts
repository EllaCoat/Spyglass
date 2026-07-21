import * as core from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { registerVisibilityCompleters } from '../lib/completer/visibility.js'

/**
 * P4-3b: tag completion parity。 wrapper が `tag/<category>` lookup を base
 * completer (`core.completer.resourceLocation`) と同じ label 規則 (`#` prefix /
 * implicit path / default namespace 省略 = 共有 helper
 * `normalizeResourceLocationLabels`) で処理することを pin する。
 */

interface MockSymbolInit {
	identifier: string
	/** `getVisibleSymbols` (= base completer 経路) に載せるか。 Restricted 相当は false。 */
	visible: boolean
	impDoc?: unknown
}

const CallerUri = 'file:///caller.mcfunction'

function mockSymbol(category: string, init: MockSymbolInit): Record<string, unknown> {
	return {
		category,
		identifier: init.identifier,
		path: [init.identifier],
		declaration: [{ uri: 'file:///declare.mcfunction' }],
		...(init.impDoc ? { data: { impDoc: init.impDoc } } : {}),
	}
}

function mockCtx(
	symbolsByCategory: Readonly<Record<string, readonly MockSymbolInit[]>>,
	callerFunctionID?: string,
): core.CompleterContext {
	const lookupMaps: Record<string, Record<string, unknown>> = {}
	const visibleMaps: Record<string, Record<string, unknown>> = {}
	for (const [category, inits] of Object.entries(symbolsByCategory)) {
		lookupMaps[category] = {}
		visibleMaps[category] = {}
		for (const init of inits) {
			const symbol = mockSymbol(category, init)
			lookupMaps[category][init.identifier] = symbol
			if (init.visible) {
				visibleMaps[category][init.identifier] = symbol
			}
		}
	}
	const callerCandidates = callerFunctionID
		? [{
			category: 'function',
			identifier: callerFunctionID,
			path: [callerFunctionID],
			definition: [{ uri: CallerUri }],
		}]
		: []
	return {
		doc: { uri: CallerUri },
		offset: 0,
		config: core.VanillaConfig,
		symbols: {
			lookup: (category: string) => ({ parentMap: lookupMaps[category] ?? {} }),
			getVisibleSymbols: (category: string) => visibleMaps[category] ?? {},
			getSymbolCandidatesAtUri: () => callerCandidates,
		},
	} as unknown as core.CompleterContext
}

function setupWrappedCompleter(): core.Completer<core.ResourceLocationNode> {
	const meta = new core.MetaRegistry()
	meta.registerCompleter<core.ResourceLocationNode>(
		'resource_location',
		core.completer.resourceLocation,
	)
	meta.registerCompleter<core.SymbolNode>('symbol', () => [])
	meta.registerCompleter<core.AstNode>('mcfunction:score_holder', () => [])
	registerVisibilityCompleters(meta)
	return meta.getCompleter<core.ResourceLocationNode>('resource_location')
}

function resourceNode(
	options: Record<string, unknown>,
): core.DeepReadonly<core.ResourceLocationNode> {
	return {
		type: 'resource_location',
		range: core.Range.create(0, 0),
		children: [],
		options,
	} as unknown as core.DeepReadonly<core.ResourceLocationNode>
}

function labels(items: readonly core.CompletionItem[]): string[] {
	return items.map(item => item.label).sort()
}

const WithinCaller = (caller: string, owner: string) => ({
	declarations: [{
		uri: 'file:///declare.mcfunction',
		range: { start: 0, end: 1 },
		owner,
		visibility: {
			type: 'within',
			owner,
			includeOwner: true,
			patterns: [{
				raw: caller,
				targetType: 'function',
				regex: `^${caller.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
			}],
		},
	}],
})

describe('IMP-Doc tag completion (P4-3b)', () => {
	it('adds a #namespace:path tag candidate that the base completer cannot see', () => {
		const completer = setupWrappedCompleter()
		const ctx = mockCtx({
			'tag/function': [{
				identifier: 'tsb:internal',
				visible: false,
				impDoc: WithinCaller('test:caller', 'tsb:owner'),
			}],
		}, 'test:caller')
		const node = resourceNode({ category: 'function', allowTag: true })

		const items = completer(node, ctx)
		assert.deepEqual(
			items.filter(item => item.label === '#tsb:internal').length,
			1,
			'the @within-admitted caller should receive the restricted tag exactly once',
		)
	})

	it('filters restricted tag candidates when the caller is not admitted', () => {
		const completer = setupWrappedCompleter()
		const ctx = mockCtx({
			'tag/function': [{
				identifier: 'tsb:internal',
				visible: false,
				impDoc: WithinCaller('test:caller', 'tsb:owner'),
			}],
		}, 'external:caller')
		const node = resourceNode({ category: 'function', allowTag: true })

		assert.deepEqual(
			completer(node, ctx).filter(item => item.label === '#tsb:internal'),
			[],
		)
	})

	it('does not add tag candidates when the node forbids tags', () => {
		const completer = setupWrappedCompleter()
		const ctx = mockCtx({
			'tag/function': [{
				identifier: 'tsb:internal',
				visible: false,
				impDoc: { visibility: { type: 'public' } },
			}],
		})
		const node = resourceNode({ category: 'function' })

		assert.deepEqual(
			completer(node, ctx).filter(item => item.label.startsWith('#')),
			[],
		)
	})

	it('matches the base completer exactly for implicit path and default namespace', () => {
		// 同じ pool を base (`getVisibleSymbols`) と wrapper (`lookup` + IMP-Doc
		// public) の両方に見せると、 dedupe 後の label 集合は base 単体と一致する
		// (= 共有 helper により implicit path / `minecraft:` 省略 / `#` prefix が
		// drift しないことの構造的な保証)。
		const completer = setupWrappedCompleter()
		const pool = [
			{
				identifier: 'minecraft:load/init',
				visible: true,
				impDoc: { visibility: { type: 'public' } },
			},
			{
				identifier: 'test:load/boot',
				visible: true,
				impDoc: { visibility: { type: 'public' } },
			},
			{
				identifier: 'test:other/skip',
				visible: true,
				impDoc: { visibility: { type: 'public' } },
			},
		]
		const ctx = mockCtx({ function: pool, 'tag/function': pool })
		const node = resourceNode({
			category: 'function',
			allowTag: true,
			implicitPath: 'load/',
		})

		const baseItems = core.completer.resourceLocation(node, ctx)
		const wrappedItems = completer(node, ctx)
		assert.deepEqual(labels(wrappedItems), labels(baseItems))
		assert.equal(
			new Set(wrappedItems.map(item => item.label)).size,
			wrappedItems.length,
			'duplicate labels must be deduped',
		)
		// implicit path が strip され、 default namespace 省略形も含まれる。
		assert.ok(wrappedItems.some(item => item.label === '#test:boot'))
		assert.ok(wrappedItems.some(item => item.label === '#minecraft:init'))
		assert.ok(wrappedItems.some(item => item.label === '#init'))
		assert.ok(!wrappedItems.some(item => item.label.includes('skip')))
	})
})
