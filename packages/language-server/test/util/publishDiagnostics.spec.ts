import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SentDiagnostics } from '../../lib/util/publishDiagnostics.js'
import { isRepeatOfLastSentDiagnostics } from '../../lib/util/publishDiagnostics.js'

/** A payload with something in it, serialized the way the publisher serializes one. */
const Reported = JSON.stringify([{ message: 'something is wrong' }])
/** The payload that retracts whatever a client is displaying for a URI. */
const Empty = JSON.stringify([])

/**
 * The three kinds of version a publish carries, and what each of them says about the content the
 * diagnostics describe. They reach the publisher for the same URI over the life of a session, so
 * none of them may stand in for another.
 */
const Versions = [
	['the version of an editor buffer', 7],
	['the version of content read from disk', -1],
	['no version at all', undefined],
] as const

function sent(payload: string, version: number | undefined): SentDiagnostics {
	return { payload, version }
}

describe('publishDiagnostics', () => {
	describe('isRepeatOfLastSentDiagnostics()', () => {
		it('Should treat a notification with nothing before it as new', () => {
			// The first publish for a URI is the one a client has nothing of yet.
			for (const [name, version] of Versions) {
				assert.equal(isRepeatOfLastSentDiagnostics(undefined, Reported, version), false, name)
				assert.equal(isRepeatOfLastSentDiagnostics(undefined, Empty, version), false, name)
			}
		})

		it('Should treat the same payload at the same version as a repeat', () => {
			for (const [name, version] of Versions) {
				assert.equal(
					isRepeatOfLastSentDiagnostics(sent(Reported, version), Reported, version),
					true,
					name,
				)
			}
		})

		it('Should treat the same payload at another version as new', () => {
			// Every ordered pair of the three, so that neither the equality nor its direction can
			// hold for two kinds of version that only look alike.
			for (const [previousName, previousVersion] of Versions) {
				for (const [name, version] of Versions) {
					if (previousVersion === version) {
						continue
					}
					assert.equal(
						isRepeatOfLastSentDiagnostics(sent(Reported, previousVersion), Reported, version),
						false,
						`${previousName} followed by ${name}`,
					)
				}
			}
		})

		it('Should treat the retraction of a reported payload as new', () => {
			// The publish a client cannot do without: what it displays stays on screen until an
			// empty set takes it away, so this is the comparison that must never say “already sent”.
			for (const [name, version] of Versions) {
				assert.equal(
					isRepeatOfLastSentDiagnostics(sent(Reported, version), Empty, version),
					false,
					name,
				)
			}
		})

		it('Should treat a payload reported after a retraction as new', () => {
			for (const [name, version] of Versions) {
				assert.equal(
					isRepeatOfLastSentDiagnostics(sent(Empty, version), Reported, version),
					false,
					name,
				)
			}
		})

		it('Should treat the same empty payload at the same version as a repeat', () => {
			for (const [name, version] of Versions) {
				assert.equal(
					isRepeatOfLastSentDiagnostics(sent(Empty, version), Empty, version),
					true,
					name,
				)
			}
		})

		it('Should treat the same empty payload at another version as new', () => {
			for (const [previousName, previousVersion] of Versions) {
				for (const [name, version] of Versions) {
					if (previousVersion === version) {
						continue
					}
					assert.equal(
						isRepeatOfLastSentDiagnostics(sent(Empty, previousVersion), Empty, version),
						false,
						`${previousName} followed by ${name}`,
					)
				}
			}
		})

		it('Should treat a different payload at the same version as new', () => {
			// One diagnostic replaced by another of the same count: the comparison reads the payload
			// rather than its size.
			const other = JSON.stringify([{ message: 'something else is wrong' }])
			for (const [name, version] of Versions) {
				assert.equal(
					isRepeatOfLastSentDiagnostics(sent(Reported, version), other, version),
					false,
					name,
				)
			}
		})
	})
})
