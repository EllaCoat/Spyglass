/* eslint-disable no-restricted-syntax -- LegacyCategorySpec intentionally uses null for no v4 mapping. */
export interface LegacyCategorySpec {
	readonly id: string
	readonly family: 'namespaced' | 'entity-like' | 'plain-variable' | 'alias'
	readonly v4Category: string | null
	readonly namespaced: boolean
	readonly nativeSupport: 'native' | 'mapped' | 'plugin-local' | 'not-in-v4'
}

type CategoryWithId<Id extends string, V4Category extends string | null> =
	& LegacyCategorySpec
	& { readonly id: Id; readonly v4Category: V4Category }

function category<
	const Id extends string,
	const V4Category extends string | null,
>(
	id: Id,
	family: LegacyCategorySpec['family'],
	v4Category: V4Category,
	namespaced: boolean,
	nativeSupport: LegacyCategorySpec['nativeSupport'],
): CategoryWithId<Id, V4Category> {
	return { id, family, v4Category, namespaced, nativeSupport }
}

function nativeNamespaced<const Id extends string>(
	id: Id,
): CategoryWithId<Id, Id> {
	return category(id, 'namespaced', id, true, 'native')
}

function missingNamespaced<const Id extends string>(
	id: Id,
): CategoryWithId<Id, null> {
	return category(id, 'namespaced', null, true, 'not-in-v4')
}

export const LEGACY_FILE_TYPES = [
	nativeNamespaced('advancement'),
	nativeNamespaced('damage_type'),
	nativeNamespaced('dimension'),
	nativeNamespaced('dimension_type'),
	nativeNamespaced('function'),
	nativeNamespaced('item_modifier'),
	nativeNamespaced('loot_table'),
	nativeNamespaced('predicate'),
	nativeNamespaced('recipe'),
	nativeNamespaced('structure'),
] as const satisfies readonly LegacyCategorySpec[]

export const LEGACY_TAG_FILE_TYPES = [
	nativeNamespaced('tag/block'),
	nativeNamespaced('tag/damage_type'),
	nativeNamespaced('tag/entity_type'),
	nativeNamespaced('tag/fluid'),
	nativeNamespaced('tag/function'),
	nativeNamespaced('tag/game_event'),
	nativeNamespaced('tag/item'),
	nativeNamespaced('tag/worldgen/biome'),
	nativeNamespaced('tag/worldgen/configured_carver'),
	missingNamespaced('tag/worldgen/configured_decorator'),
	nativeNamespaced('tag/worldgen/configured_feature'),
	nativeNamespaced('tag/worldgen/configured_structure_feature'),
	nativeNamespaced('tag/worldgen/configured_surface_builder'),
	nativeNamespaced('tag/worldgen/density_function'),
	nativeNamespaced('tag/worldgen/noise'),
	nativeNamespaced('tag/worldgen/noise_settings'),
	nativeNamespaced('tag/worldgen/placed_feature'),
	nativeNamespaced('tag/worldgen/processor_list'),
	nativeNamespaced('tag/worldgen/structure'),
	nativeNamespaced('tag/worldgen/structure_set'),
	nativeNamespaced('tag/worldgen/template_pool'),
] as const satisfies readonly LegacyCategorySpec[]

export const LEGACY_WORLDGEN_FILE_TYPES = [
	nativeNamespaced('worldgen/biome'),
	nativeNamespaced('worldgen/configured_carver'),
	missingNamespaced('worldgen/configured_decorator'),
	nativeNamespaced('worldgen/configured_feature'),
	nativeNamespaced('worldgen/configured_structure_feature'),
	nativeNamespaced('worldgen/configured_surface_builder'),
	nativeNamespaced('worldgen/density_function'),
	nativeNamespaced('worldgen/flat_level_generator_preset'),
	nativeNamespaced('worldgen/noise'),
	nativeNamespaced('worldgen/noise_settings'),
	nativeNamespaced('worldgen/placed_feature'),
	nativeNamespaced('worldgen/processor_list'),
	nativeNamespaced('worldgen/structure'),
	nativeNamespaced('worldgen/structure_set'),
	nativeNamespaced('worldgen/template_pool'),
	nativeNamespaced('worldgen/world_preset'),
] as const satisfies readonly LegacyCategorySpec[]

export const LEGACY_MISC_TYPES = [
	nativeNamespaced('bossbar'),
	category('entity', 'entity-like', 'entity', false, 'native'),
	category('objective', 'plain-variable', 'objective', false, 'native'),
	category('score_holder', 'entity-like', 'score_holder', false, 'native'),
	nativeNamespaced('storage'),
	category('tag', 'plain-variable', 'tag', false, 'native'),
	category('team', 'plain-variable', 'team', false, 'native'),
	category('sequence', 'plain-variable', 'random_sequence', false, 'mapped'),
] as const satisfies readonly LegacyCategorySpec[]

export const LEGACY_ALIAS_TYPES = [
	category('alias/entity', 'alias', 'alias/entity', false, 'plugin-local'),
	category('alias/uuid', 'alias', 'alias/uuid', false, 'plugin-local'),
	category('alias/vector', 'alias', 'alias/vector', false, 'plugin-local'),
] as const satisfies readonly LegacyCategorySpec[]

export const LEGACY_DECLARABLE_TYPES = [
	...LEGACY_FILE_TYPES,
	...LEGACY_TAG_FILE_TYPES,
	...LEGACY_WORLDGEN_FILE_TYPES,
	...LEGACY_MISC_TYPES,
] as const satisfies readonly LegacyCategorySpec[]

type LegacyFileTypeSpec =
	| (typeof LEGACY_FILE_TYPES)[number]
	| (typeof LEGACY_TAG_FILE_TYPES)[number]
	| (typeof LEGACY_WORLDGEN_FILE_TYPES)[number]

export type LegacyFileTypeId = LegacyFileTypeSpec['id']
export type LegacyDeclarableTypeId = (typeof LEGACY_DECLARABLE_TYPES)[number]['id']
export type LegacyAliasTypeId = (typeof LEGACY_ALIAS_TYPES)[number]['id']
export type LegacyCategoryId = LegacyDeclarableTypeId | LegacyAliasTypeId

export const LEGACY_FILE_TYPE_IDS: readonly LegacyFileTypeId[] = [
	...LEGACY_FILE_TYPES.map(spec => spec.id),
	...LEGACY_TAG_FILE_TYPES.map(spec => spec.id),
	...LEGACY_WORLDGEN_FILE_TYPES.map(spec => spec.id),
]

export const LEGACY_WITHIN_TARGET_IDS: readonly (LegacyFileTypeId | '*')[] = [
	...LEGACY_FILE_TYPE_IDS,
	'*',
]

const LegacyFileTypeIdSet: ReadonlySet<string> = new Set(LEGACY_FILE_TYPE_IDS)
const LegacyWithinTargetIdSet: ReadonlySet<string> = new Set(LEGACY_WITHIN_TARGET_IDS)
const LegacyCategoryById: ReadonlyMap<string, LegacyCategorySpec> = new Map(
	[...LEGACY_DECLARABLE_TYPES, ...LEGACY_ALIAS_TYPES]
		.map(spec => [spec.id, spec] as const),
)

export function isLegacyFileType(id: string): id is LegacyFileTypeId {
	return LegacyFileTypeIdSet.has(id)
}

export function isLegacyWithinTarget(
	id: string,
): id is LegacyFileTypeId | '*' {
	return LegacyWithinTargetIdSet.has(id)
}

export function getLegacyCategorySpec(
	id: string,
): LegacyCategorySpec | undefined {
	return LegacyCategoryById.get(id)
}
