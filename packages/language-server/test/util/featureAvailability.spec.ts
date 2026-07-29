import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as ls from 'vscode-languageserver/node.js'
import * as unavailable from '../../lib/util/featureAvailability.js'

/**
 * Features whose refusal is an empty list. Everything an editor renders as a list of things — the
 * completions, the code actions, the highlights — says “I have nothing for you” the same way,
 * whether the reason is that there is nothing or that the project is busy rebuilding.
 */
const ListShaped = [
	['codeAction', unavailable.codeAction],
	['colorPresentation', unavailable.colorPresentation],
	['completion', unavailable.completion],
	['documentColor', unavailable.documentColor],
	['documentHighlight', unavailable.documentHighlight],
	['documentSymbol', unavailable.documentSymbol],
	['inlayHint', unavailable.inlayHint],
	['references', unavailable.references],
	['workspaceSymbol', unavailable.workspaceSymbol],
] as const

/**
 * Features that answer a single place in the workspace, or the absence of one — plus formatting,
 * which either rewrites the document or leaves it alone. Their refusal reaches the editor as the
 * JSON-RPC `null` result, which is what `vscode-jsonrpc` writes for a handler that answered
 * `undefined`.
 */
const LocationShaped = [
	['declaration', unavailable.declaration],
	['definition', unavailable.definition],
	['documentFormatting', unavailable.documentFormatting],
	['implementation', unavailable.implementation],
	['signatureHelp', unavailable.signatureHelp],
	['typeDefinition', unavailable.typeDefinition],
] as const

/**
 * Features that answered something other than nothing for a document they could not get hold of,
 * from before this gate existed. Both reasons keep that answer, so the gate changes what these
 * report to the editor in no case at all.
 */
const AlwaysAnswering = [
	['inlayHint', unavailable.inlayHint, []],
	['semanticTokens', unavailable.semanticTokens, { data: [] }],
	['workspaceSymbol', unavailable.workspaceSymbol, []],
] as const

describe('featureAvailability', () => {
	describe('while an analysis is running', () => {
		it('Should answer every list-shaped feature with an empty list', () => {
			for (const [name, respond] of ListShaped) {
				assert.deepEqual(respond('analysis-running'), [], name)
			}
		})

		it('Should answer every location-shaped feature with the null result', () => {
			for (const [name, respond] of LocationShaped) {
				assert.equal(respond('analysis-running'), undefined, name)
			}
		})

		it('Should answer semantic tokens with an empty token list', () => {
			assert.deepEqual(unavailable.semanticTokens('analysis-running'), { data: [] })
		})

		it('Should answer a hover with text saying why', () => {
			const hover = unavailable.hover('analysis-running')

			// The one feature that can say what is going on rather than looking like an empty
			// result. A missing locale entry makes `localize` hand back the key it was given, which
			// is why the text is compared against it.
			assert.ok(hover, 'the hover was refused with nothing to show')
			const contents = hover.contents as ls.MarkupContent
			assert.equal(contents.kind, ls.MarkupKind.PlainText)
			assert.ok(contents.value.length > 0, 'the hover carried an empty message')
			assert.notEqual(
				contents.value,
				'server.feature-unavailable.analyzing-project',
				'the locale has no entry for the message, so the raw key reached the editor',
			)
		})

		it('Should build a fresh result for every refusal', () => {
			// A single shared array would be one object handed to every refused request, which a
			// caller that sorts or appends to what it received would then corrupt for all of them.
			assert.notEqual(
				unavailable.completion('analysis-running'),
				unavailable.completion('analysis-running'),
			)
		})
	})

	describe('when there is nothing to serve', () => {
		it('Should answer nothing where the handler always answered nothing', () => {
			for (const [name, respond] of [...ListShaped, ...LocationShaped]) {
				if (AlwaysAnswering.some(([alwaysAnswering]) => alwaysAnswering === name)) {
					continue
				}
				assert.equal(respond('project-not-ready'), undefined, name)
			}
		})

		it('Should keep the answer of the features that never answered nothing', () => {
			for (const [name, respond, expected] of AlwaysAnswering) {
				assert.deepEqual(respond('project-not-ready'), expected, name)
			}
		})

		it('Should not tell a hover that an analysis is why', () => {
			assert.equal(unavailable.hover('project-not-ready'), undefined)
		})
	})
})
