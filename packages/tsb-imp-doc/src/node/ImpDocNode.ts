import type { AstNode } from '@spyglassmc/core'

export interface ImpDocValue {
	raw: string
	range: AstNode['range']
}

export interface ImpDocAnnotationBase extends AstNode {
	value: ImpDocValue
	children?: ImpDocAnnotation[]
}

/** An annotation which is not part of the Phase 2 function contract. */
export interface ImpDocGenericAnnotation extends ImpDocAnnotationBase {
	type: 'impDoc:annotation'
}

export type ImpDocContractDirection = 'input' | 'output'

export type ImpDocContractChannel =
	| 'args'
	| 'storage'
	| 'score'
	| 'tag'
	| 'executor'
	| 'result'
	| 'unknown'

/**
 * Known input spellings get literal types while custom Legacy subtypes remain
 * lossless. `as player` is normalized to `as_player`.
 */
export type ImpDocInputKind = 'args' | 'as_player' | (string & {})

/** A `Key: Type` declaration. Nested keys model indented NBT-shaped fields. */
export interface ImpDocContractField {
	raw: ImpDocValue
	key: ImpDocValue
	optional: boolean
	valueType?: ImpDocValue
	children?: ImpDocContractField[]
}

/**
 * One normalized contract clause. The original annotation tree remains on the
 * typed annotation node, while `raw` and all component ranges make this view
 * safe for hover, diagnostics, and future type-expression parsing.
 */
export interface ImpDocContractEntry {
	direction: ImpDocContractDirection
	channel: ImpDocContractChannel
	kind: string
	raw: ImpDocValue
	target?: ImpDocValue
	path?: ImpDocValue
	fields: ImpDocContractField[]
}

export interface ImpDocInput extends ImpDocAnnotationBase {
	type: 'impDoc:input'
	kind?: ImpDocInputKind
	entries: ImpDocContractEntry[]
}

export interface ImpDocOutput extends ImpDocAnnotationBase {
	type: 'impDoc:output'
	kind?: string
	entries: ImpDocContractEntry[]
}

export interface ImpDocApi extends ImpDocAnnotationBase {
	type: 'impDoc:api'
	audience: 'api'
}

export type ImpDocExecutorKind = 'player' | 'entity' | 'server' | 'unknown'

export interface ImpDocUser extends ImpDocAnnotationBase {
	type: 'impDoc:user'
	executor: {
		kind: ImpDocExecutorKind
		explicit: boolean
		raw?: ImpDocValue
	}
}

export interface ImpDocDeprecated extends ImpDocAnnotationBase {
	type: 'impDoc:deprecated'
	message?: ImpDocValue
}

export type ImpDocContractAnnotation =
	| ImpDocInput
	| ImpDocOutput
	| ImpDocApi
	| ImpDocUser
	| ImpDocDeprecated

/**
 * Normalized function-contract view. Arrays deliberately retain duplicate
 * markers so P2b can characterize or diagnose them without reparsing raw text.
 */
export interface ImpDocContract {
	inputs: ImpDocInput[]
	outputs: ImpDocOutput[]
	apis: ImpDocApi[]
	users: ImpDocUser[]
	deprecated: ImpDocDeprecated[]
}

export type ImpDocAnnotation =
	| ImpDocGenericAnnotation
	| ImpDocContractAnnotation

export interface ImpDocDeclarationLine {
	indent: string
	range: AstNode['range']
	raw: string
}

export type ImpDocDeclarationCategory = 'tag' | 'storage' | 'score_holder'

export interface ImpDocDeclarationNode extends AstNode {
	type: 'impDoc:declaration'
	category: ImpDocDeclarationCategory
	categoryRange: AstNode['range']
	name: ImpDocValue
}

export interface ImpDocDeclarationBlock {
	declarations: ImpDocDeclarationNode[]
	lines: ImpDocDeclarationLine[]
	range: AstNode['range']
}

export type WithinTargetType = '*' | 'function'

/**
 * Symbol.data/cache に保存するため RegExp ではなく文字列で保持する。
 * 実行時は共有 `matchesVisibility()` が `new RegExp(regex)` で評価する。
 */
export interface WithinPattern {
	/** annotation に書かれた原文 */
	raw: string
	/** Legacy の対象 file type。 Tier A の consumer は function と * を扱う。 */
	targetType: WithinTargetType
	/** ^...$ を含む RegExp source */
	regex: string
}

export type ImpDocVisibility =
	| { type: 'public' }
	| { type: 'private'; owner: string }
	| {
		type: 'within'
		owner: string
		patterns: readonly WithinPattern[]
	}

export interface ImpDocDeclarationSource {
	uri: string
	range: AstNode['range']
	owner: string
}

export interface ImpDocNode extends AstNode {
	type: 'impDoc'
	annotations: ImpDocAnnotation[]
	contract: ImpDocContract
	declaration?: ImpDocDeclarationBlock
	functionID?: ImpDocValue
	plainText: string
	raw: string
	visibility?: ImpDocVisibility
}

export namespace ImpDocNode {
	export function is(node: AstNode | undefined): node is ImpDocNode {
		return node?.type === 'impDoc'
	}

	export function flattenAnnotations(
		annotations: readonly ImpDocAnnotation[],
		prefix: readonly ImpDocValue[] = [],
	): ImpDocValue[][] {
		const ans: ImpDocValue[][] = []
		for (const annotation of annotations) {
			const values = [...prefix, annotation.value]
			if (annotation.children?.length) {
				ans.push(...flattenAnnotations(annotation.children, values))
			} else {
				ans.push(values)
			}
		}
		return ans
	}

	export function getDescription(node: ImpDocNode): string {
		return node.plainText + '\n\n'
			+ flattenAnnotations(node.annotations)
				.map(values => values.map(value => value.raw).join(' '))
				.join('\n\n')
	}
}

export interface ImpDocSymbolData {
	visibility?: ImpDocVisibility
	declaration?: ImpDocDeclarationSource
	/**
	 * P1a characterization / downstream compatibility 用の shortcut。
	 * SoT は `visibility`、 Step 3 以降で撤去候補。
	 */
	privateOwner?: string
}

export function getImpDocSymbolData(data: unknown): ImpDocSymbolData | undefined {
	if (!data || typeof data !== 'object') {
		return undefined
	}
	const value = (data as { impDoc?: unknown }).impDoc
	return value && typeof value === 'object' ? value as ImpDocSymbolData : undefined
}
