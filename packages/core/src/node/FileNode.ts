import type { AstNode } from '../node/index.js'
import type { LanguageError } from '../source/index.js'
import type { SymbolTable } from '../symbol/index.js'

export interface FileNode<CN extends AstNode> extends AstNode {
	readonly type: 'file'
	readonly children: CN[]
	locals: SymbolTable
	parserErrors: readonly LanguageError[]
	/**
	 * Only exists when the file has been bound.
	 */
	binderErrors?: readonly LanguageError[]
	/**
	 * Only exists when the file has been checked.
	 */
	checkerErrors?: readonly LanguageError[]
	/**
	 * Only exists when the file has been checked.
	 */
	linterErrors?: readonly LanguageError[]
	/**
	 * Only exists when the checker threw for the file, which leaves {@link checkerErrors} unset and
	 * the errors of this node a subset of what the file should report. Removed again as soon as a
	 * checker runs to completion for it.
	 */
	checkerFailed?: true
}
export namespace FileNode {
	export function getErrors(node: FileNode<any>): LanguageError[] {
		return [
			...node.parserErrors,
			...(node.binderErrors ?? []),
			...(node.checkerErrors ?? []),
			...(node.linterErrors ?? []),
		]
	}
}
