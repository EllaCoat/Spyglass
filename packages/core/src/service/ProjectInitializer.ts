import type { Project } from './Project.js'

export type ProjectChangePredicate = (this: void, uri: string) => boolean

export type ProjectInitializerContext =
	& Pick<
		Project,
		| 'cacheRoot'
		| 'config'
		| 'externals'
		| 'isDebugging'
		| 'logger'
		| 'meta'
		| 'profilers'
		| 'projectRoots'
	>
	& {
		/**
		 * Register a project-level input whose changes require the initializers to run again.
		 * The initializer's returned context determines whether the active cache and symbols
		 * must be rebuilt after the input changes.
		 */
		reinitializeOnChange(predicate: ProjectChangePredicate): void
	}

export type SyncProjectInitializer = (
	this: void,
	ctx: ProjectInitializerContext,
) => Record<string, string> | void

export type AsyncProjectInitializer = (
	this: void,
	ctx: ProjectInitializerContext,
) => PromiseLike<Record<string, string> | void>

export type ProjectInitializer = SyncProjectInitializer | AsyncProjectInitializer
