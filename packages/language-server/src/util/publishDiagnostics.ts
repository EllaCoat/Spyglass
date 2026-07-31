/*
 * What the server remembers of the diagnostics it has already published, and the one question it
 * asks about it: is this notification one the client has been told already?
 *
 * It lives here rather than next to the publisher in `server.ts` because getting it wrong is not
 * visible in the shape of the code — a comparison that is too eager leaves diagnostics on screen
 * that a later publish was meant to take away, which looks like a checker bug from the outside —
 * and because `server.ts` starts a language server the moment it is imported, so nothing there can
 * be read by a test.
 */

/** One diagnostics notification as it went out: its serialized payload and its version. */
export interface SentDiagnostics {
	payload: string
	version: number | undefined
}

/**
 * Whether a notification of `payload` at `version` would tell a client what `previous` already
 * told it. `previous` is `undefined` for a URI nothing has been published for yet, which is never
 * a repeat.
 *
 * The version is part of the comparison because the same diagnostics are published under versions
 * that mean different things — the editor's version for a client-managed document, `-1` for one
 * read from disk, none at all for the empty set that retracts a removed document's diagnostics —
 * and the payload is compared as it went on the wire, so an empty set is a payload like any other:
 * the diagnostics a client displays stay on screen until an empty set that differs from what it
 * last received takes them away.
 */
export function isRepeatOfLastSentDiagnostics(
	previous: SentDiagnostics | undefined,
	payload: string,
	version: number | undefined,
): boolean {
	return previous !== undefined && previous.version === version && previous.payload === payload
}
