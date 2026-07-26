import * as core from '@spyglassmc/core'
import * as json from '@spyglassmc/json'
import { dissectUri } from './index.js'

/**
 * Enters the keys of the `criteria` object of an advancement as `definition`s of
 * `advancement/<identifier>.<criterion>` symbols.
 *
 * The `#[criterion(definition=true)]` mcdoc attribute enters the very same symbols, but mcdoc
 * attributes are only applied by the mcdoc runtime checker, which in turn only runs for files that
 * are opened or changed. Binding, on the other hand, runs for every file of the project, so without
 * this binder a criterion referenced from e.g. an entity selector resolves to nothing until its
 * advancement has been checked, which surfaces as a false `undeclaredSymbol` diagnostic.
 */
export const advancementCriteria: core.SyncBinder<json.JsonFileNode> = (node, ctx) => {
	const parts = dissectUri(ctx.doc.uri, ctx)
	if (!parts || !parts.ok || parts.category !== 'advancement') {
		return
	}
	const root = node.children[0]
	if (!json.JsonObjectNode.is(root)) {
		return
	}
	const criteria = root.children.find((pair) => pair.key?.value === 'criteria')?.value
	if (!json.JsonObjectNode.is(criteria)) {
		return
	}
	const identifier = `${parts.namespace}:${parts.identifier}`
	// Entering a member requires the advancement symbol itself to exist, otherwise `enter()` throws.
	// The URI binder creates it for every resource file of the project, but that is not guaranteed
	// for e.g. a file that is excluded from the project, so the parent is checked instead of assumed.
	ctx.symbols.query(ctx.doc, 'advancement', identifier).ifKnown(() => {
		for (const pair of criteria.children) {
			const key = pair.key
			if (!key?.value) {
				continue
			}
			ctx.symbols.query(ctx.doc, 'advancement', identifier, key.value).enter({
				data: { subcategory: 'criterion' },
				usage: {
					type: 'definition',
					// Exclude the surrounding quotes, matching the range that the mcdoc runtime
					// checker reports for the same symbol.
					range: core.Range.translate(key.range, 1, -1),
					fullRange: pair,
				},
			})
		}
	})
}

/**
 * Chains {@link advancementCriteria} onto the binder that is currently registered for `json:file`.
 *
 * `MetaRegistry#registerBinder` replaces per node type, and `json:file` already carries a binder
 * (see `../json/binder/index.ts`, which defines translation keys of `lang` files), so registering
 * naively would silently drop it.
 *
 * Must be called after every other `json:file` binder has been registered.
 */
export function registerAdvancementCriteriaBinder(meta: core.MetaRegistry): void {
	// `MetaRegistry#getBinder` falls back to the asynchronous `core.binder.fallback` when nothing is
	// registered. That fallback dispatches on the node it is given, so calling it from here would
	// re-enter this very binder forever. Only a synchronous binder is chained, which
	// `core.binder.fallback` never is, and nothing is lost by skipping it: at binding time a JSON
	// tree holds no node that has a binder of its own, as the nodes that do (`resource_location` and
	// `symbol`) are only attached later, by the mcdoc runtime checker.
	const previous = meta.getBinder<json.JsonFileNode>('json:file')
	meta.registerBinder<json.JsonFileNode>(
		'json:file',
		core.SyncBinder.create<json.JsonFileNode>((node, ctx) => {
			if (core.SyncBinder.is(previous)) {
				previous(node, ctx)
			}
			advancementCriteria(node, ctx)
		}),
	)
}
