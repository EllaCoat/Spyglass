import type { UriBinderContext } from './Context.js'

export type UriBinder = (uris: readonly string[], ctx: UriBinderContext) => void

/**
 * Runs immediately before Project clears binder-owned locations for a URI or
 * removes every location belonging to that URI. Plugins can use this to drop
 * URI-scoped metadata that lives outside core SymbolLocation arrays.
 */
export type UriSymbolClearer = (uri: string, ctx: UriBinderContext) => void

export type UriSorterRegistration = (this: void, a: string, b: string, next: UriSorter) => number
export type UriSorter = (this: void, a: string, b: string) => number
