#> matrix:_index.d
# @private

#> 55+3 consumer matrix public declarations (Phase 4-3c freeze)
# @public
    #declare advancement matrix:advancement_public
    #declare damage_type matrix:damage_type_public
    #declare dimension matrix:dimension_public
    #declare dimension_type matrix:dimension_type_public
    #declare function matrix:function_public
    #declare item_modifier matrix:item_modifier_public
    #declare loot_table matrix:loot_table_public
    #declare predicate matrix:predicate_public
    #declare recipe matrix:recipe_public
    #declare structure matrix:structure_public
    #declare tag/block matrix:tag_block_public
    #declare tag/damage_type matrix:tag_damage_type_public
    #declare tag/entity_type matrix:tag_entity_type_public
    #declare tag/fluid matrix:tag_fluid_public
    #declare tag/function matrix:tag_function_public
    #declare tag/game_event matrix:tag_game_event_public
    #declare tag/item matrix:tag_item_public
    #declare tag/worldgen/biome matrix:tag_worldgen_biome_public
    #declare tag/worldgen/configured_carver matrix:tag_worldgen_configured_carver_public
    #declare tag/worldgen/configured_decorator matrix:tag_worldgen_configured_decorator_public
    #declare tag/worldgen/configured_feature matrix:tag_worldgen_configured_feature_public
    #declare tag/worldgen/configured_structure_feature matrix:tag_worldgen_configured_structure_feature_public
    #declare tag/worldgen/configured_surface_builder matrix:tag_worldgen_configured_surface_builder_public
    #declare tag/worldgen/density_function matrix:tag_worldgen_density_function_public
    #declare tag/worldgen/noise matrix:tag_worldgen_noise_public
    #declare tag/worldgen/noise_settings matrix:tag_worldgen_noise_settings_public
    #declare tag/worldgen/placed_feature matrix:tag_worldgen_placed_feature_public
    #declare tag/worldgen/processor_list matrix:tag_worldgen_processor_list_public
    #declare tag/worldgen/structure matrix:tag_worldgen_structure_public
    #declare tag/worldgen/structure_set matrix:tag_worldgen_structure_set_public
    #declare tag/worldgen/template_pool matrix:tag_worldgen_template_pool_public
    #declare worldgen/biome matrix:worldgen_biome_public
    #declare worldgen/configured_carver matrix:worldgen_configured_carver_public
    #declare worldgen/configured_decorator matrix:worldgen_configured_decorator_public
    #declare worldgen/configured_feature matrix:worldgen_configured_feature_public
    #declare worldgen/configured_structure_feature matrix:worldgen_configured_structure_feature_public
    #declare worldgen/configured_surface_builder matrix:worldgen_configured_surface_builder_public
    #declare worldgen/density_function matrix:worldgen_density_function_public
    #declare worldgen/flat_level_generator_preset matrix:worldgen_flat_level_generator_preset_public
    #declare worldgen/noise matrix:worldgen_noise_public
    #declare worldgen/noise_settings matrix:worldgen_noise_settings_public
    #declare worldgen/placed_feature matrix:worldgen_placed_feature_public
    #declare worldgen/processor_list matrix:worldgen_processor_list_public
    #declare worldgen/structure matrix:worldgen_structure_public
    #declare worldgen/structure_set matrix:worldgen_structure_set_public
    #declare worldgen/template_pool matrix:worldgen_template_pool_public
    #declare worldgen/world_preset matrix:worldgen_world_preset_public
    #declare bossbar matrix:bossbar_public
    #declare entity entity_public
    #declare objective objective_public
    #declare score_holder score_holder_public
    #declare storage matrix:storage_public
    #declare tag tag_public
    #declare team team_public
    #declare sequence matrix:sequence_public

#> 55+3 consumer matrix restricted declarations (Phase 4-3c freeze)
# @within function matrix:allowed/**
    #declare advancement matrix:advancement_restricted
    #declare damage_type matrix:damage_type_restricted
    #declare dimension matrix:dimension_restricted
    #declare dimension_type matrix:dimension_type_restricted
    #declare function matrix:function_restricted
    #declare item_modifier matrix:item_modifier_restricted
    #declare loot_table matrix:loot_table_restricted
    #declare predicate matrix:predicate_restricted
    #declare recipe matrix:recipe_restricted
    #declare structure matrix:structure_restricted
    #declare tag/block matrix:tag_block_restricted
    #declare tag/damage_type matrix:tag_damage_type_restricted
    #declare tag/entity_type matrix:tag_entity_type_restricted
    #declare tag/fluid matrix:tag_fluid_restricted
    #declare tag/function matrix:tag_function_restricted
    #declare tag/game_event matrix:tag_game_event_restricted
    #declare tag/item matrix:tag_item_restricted
    #declare tag/worldgen/biome matrix:tag_worldgen_biome_restricted
    #declare tag/worldgen/configured_carver matrix:tag_worldgen_configured_carver_restricted
    #declare tag/worldgen/configured_decorator matrix:tag_worldgen_configured_decorator_restricted
    #declare tag/worldgen/configured_feature matrix:tag_worldgen_configured_feature_restricted
    #declare tag/worldgen/configured_structure_feature matrix:tag_worldgen_configured_structure_feature_restricted
    #declare tag/worldgen/configured_surface_builder matrix:tag_worldgen_configured_surface_builder_restricted
    #declare tag/worldgen/density_function matrix:tag_worldgen_density_function_restricted
    #declare tag/worldgen/noise matrix:tag_worldgen_noise_restricted
    #declare tag/worldgen/noise_settings matrix:tag_worldgen_noise_settings_restricted
    #declare tag/worldgen/placed_feature matrix:tag_worldgen_placed_feature_restricted
    #declare tag/worldgen/processor_list matrix:tag_worldgen_processor_list_restricted
    #declare tag/worldgen/structure matrix:tag_worldgen_structure_restricted
    #declare tag/worldgen/structure_set matrix:tag_worldgen_structure_set_restricted
    #declare tag/worldgen/template_pool matrix:tag_worldgen_template_pool_restricted
    #declare worldgen/biome matrix:worldgen_biome_restricted
    #declare worldgen/configured_carver matrix:worldgen_configured_carver_restricted
    #declare worldgen/configured_decorator matrix:worldgen_configured_decorator_restricted
    #declare worldgen/configured_feature matrix:worldgen_configured_feature_restricted
    #declare worldgen/configured_structure_feature matrix:worldgen_configured_structure_feature_restricted
    #declare worldgen/configured_surface_builder matrix:worldgen_configured_surface_builder_restricted
    #declare worldgen/density_function matrix:worldgen_density_function_restricted
    #declare worldgen/flat_level_generator_preset matrix:worldgen_flat_level_generator_preset_restricted
    #declare worldgen/noise matrix:worldgen_noise_restricted
    #declare worldgen/noise_settings matrix:worldgen_noise_settings_restricted
    #declare worldgen/placed_feature matrix:worldgen_placed_feature_restricted
    #declare worldgen/processor_list matrix:worldgen_processor_list_restricted
    #declare worldgen/structure matrix:worldgen_structure_restricted
    #declare worldgen/structure_set matrix:worldgen_structure_set_restricted
    #declare worldgen/template_pool matrix:worldgen_template_pool_restricted
    #declare worldgen/world_preset matrix:worldgen_world_preset_restricted
    #declare bossbar matrix:bossbar_restricted
    #declare entity entity_restricted
    #declare objective objective_restricted
    #declare score_holder score_holder_restricted
    #declare storage matrix:storage_restricted
    #declare tag tag_restricted
    #declare team team_restricted
    #declare sequence matrix:sequence_restricted

#> 55+3 consumer matrix alias declarations (Phase 4-3c freeze)
# @public
    #alias vector matrix_alias_vector 1.0 2.0 3.0
    #alias entity matrix_alias_entity @e[tag=MatrixAliasEntity, limit=1]
    #alias uuid matrix_alias_uuid 12345678-1234-5678-1234-567812345678
