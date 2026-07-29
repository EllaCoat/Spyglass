/*
 * What every language feature answers when `Project#withClientFeatureAccess` or
 * `Project#withGlobalSymbolAccess` refuses it.
 *
 * There is one entry per feature so that the whole policy is readable in one place instead of
 * being spread over the twenty handlers in `server.ts`, where a missing branch is invisible.
 */

import type * as core from '@spyglassmc/core'
import * as locales from '@spyglassmc/locales'
import * as ls from 'vscode-languageserver/node.js'

/**
 * Build the answer of a single feature to a request the project cannot serve.
 *
 * Both answers are thunks: an empty array handed out as a shared value would be one object every
 * refused request returns, and the hover text has to be resolved against the locale that was
 * loaded by the time it is asked for, not the one in place when this module was evaluated.
 *
 * @param duringAnalysis What the feature answers while an analysis is walking the corpus. Nothing
 * semantic can be produced then — the symbol table is mid-rebuild — so this is the feature's own
 * spelling of “nothing”, which the editor renders the same way it renders a real empty result.
 * @param otherwise What it answers when there is simply nothing to serve: the document is not open,
 * or the initial scan has not finished. Defaults to `undefined`, which is what every handler
 * returned for a document it could not get hold of before this gate existed.
 */
function response<T>(
	duringAnalysis: () => T,
): (reason: core.FeatureUnavailableReason) => T | undefined
function response<T>(
	duringAnalysis: () => T,
	otherwise: () => T,
): (reason: core.FeatureUnavailableReason) => T
function response<T>(
	duringAnalysis: () => T,
	otherwise: () => T | undefined = () => undefined,
): (reason: core.FeatureUnavailableReason) => T | undefined {
	return (reason) => reason === 'analysis-running' ? duringAnalysis() : otherwise()
}

/**
 * The answer of every feature whose refusal is the JSON-RPC `null` result: the ones that point at
 * a single place in the workspace, plus formatting, which either rewrites a document or leaves it
 * alone. `undefined` is how a handler spells that — `vscode-jsonrpc` writes `result: null` for a
 * handler that returned `undefined` — and it is the spelling this codebase uses for an absent
 * value throughout.
 *
 * These features answer the same thing whatever the reason. They are listed one by one below all
 * the same, so that the policy can be read off this file in full rather than by noticing which
 * features are missing from it.
 */
const noLocation = response<undefined>(() => undefined, () => undefined)

export const codeAction = response<ls.CodeAction[]>(() => [])
export const colorPresentation = response<ls.ColorPresentation[]>(() => [])
export const completion = response<ls.CompletionItem[]>(() => [])
export const declaration = noLocation
export const definition = noLocation
export const documentColor = response<ls.ColorInformation[]>(() => [])
export const documentFormatting = noLocation
export const documentHighlight = response<ls.DocumentHighlight[]>(() => [])
export const documentSymbol = response<ls.DocumentSymbol[]>(() => [])

/**
 * The one feature that says out loud what is going on. Everywhere else “temporarily unavailable”
 * and “nothing to report here” reach the editor as the same empty result, so a user who hovers
 * during an analysis and gets nothing has no way to tell that waiting would help. A hover is the
 * only one of these requests whose result is a piece of prose.
 */
export const hover = response<ls.Hover>(() => ({
	contents: {
		kind: ls.MarkupKind.PlainText,
		value: locales.localize('server.feature-unavailable.analyzing-project'),
	},
}))

export const implementation = noLocation
// The handler answered with an empty list rather than nothing for a document it could not get hold
// of, from well before this gate, so both reasons keep that answer.
export const inlayHint = response<ls.InlayHint[]>(() => [], () => [])
export const references = response<ls.Location[]>(() => [])
// As above: an empty token set is what the handler always answered when it had no document.
export const semanticTokens = response<ls.SemanticTokens>(
	() => ({ data: [] }),
	() => ({ data: [] }),
)
export const signatureHelp = noLocation
export const typeDefinition = noLocation
/**
 * A workspace symbol query names no document, so the reason can only ever be `analysis-running` in
 * practice: the request enters the same lifecycle queue the initial scan runs in and therefore
 * finds the project ready. Both answers are the empty list all the same, so that this query never
 * responds with anything but a list.
 */
export const workspaceSymbol = response<ls.SymbolInformation[]>(() => [], () => [])
