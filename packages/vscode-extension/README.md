# TSB Spyglass (Local Canary)

Unofficial fork of [Spyglass](https://github.com/SpyglassMC/Spyglass) that adds IMP-Doc support (`#>` doc comments, `@private` / `@public` / `@within` / `@internal` / `@user` visibility, `#declare`, `#alias`) so that a Datapack Helper Plus v3 project can move to Spyglass v4 without losing the annotations it depends on.

**This is not an official Spyglass build and is not affiliated with the upstream project.** It is distributed as a locally built VSIX only, never through the Marketplace or Open VSX.

| | |
|---|---|
| Extension ID | `ellacoat.tsb-spyglass` |
| Upstream ID | `SPGoding.datapack-language-server` |
| Source | <https://github.com/EllaCoat/Spyglass> |

Everything below the *Required setup* section is upstream documentation and applies unchanged.

## Installing

```
code --install-extension tsb-spyglass-<version>.vsix
```

Or: Extensions view → `...` menu → *Install from VSIX…*.

This extension declares `MinecraftCommands.syntax-mcfunction` in `extensionDependencies`, and VS Code resolves that dependency from the Marketplace while installing the VSIX. Install `syntax-mcfunction` once while online before attempting an offline VSIX install.

## Required setup

### 1. Do not run this alongside upstream Spyglass

The fork keeps the upstream command IDs and configuration namespace (`spyglassmc.*`) and registers the same language IDs. With both enabled in one window the two language servers compete for the same documents, so **disable or uninstall `SPGoding.datapack-language-server`** before enabling this one.

Extensions view → search `Spyglass` → upstream entry → *Disable*, or *Disable (Workspace)* to keep the fork scoped to one project.

### 2. Turn off extension auto-update

A locally installed VSIX has no Marketplace counterpart, so VS Code will not replace it on its own. Disabling auto-update guarantees that a future Marketplace extension sharing the publisher name cannot overwrite the canary build:

```json
{
  "extensions.autoUpdate": false
}
```

### 3. Open the project as a multi-root workspace

IMP-Doc `@within` and `#declare` resolution needs every referenced pack inside the same project. Open the Core and Asset repositories together as a multi-root workspace and put a byte-identical `spyglass.json` at the root of each folder. Configuration is merged with later roots winning, so a drifting copy silently overrides the other one.

### 4. Version policy

The version is bumped on every rebuild that changes the packaged bytes, so a given `tsb-spyglass-<version>.vsix` corresponds to exactly one build. Publishing scripts (`npm run release`) are deliberately wired to fail; use `npm run package:vsix` instead.

## Configuration
> Full documentation: https://spyglassmc.com/user/config

By default, Spyglass will look for a `pack.mcmeta` file containing a `pack_format` value. The Minecraft release version matching that pack format will be used to determine the vanilla data pack, validation schemas for JSON and NBT, command-specific checks, etc.

If you wish to override the detected version, for example when working in multi-version packs, create a `spyglass.json` file at the workspace root containing:
```json
{
   "env": {
      "gameVersion": "1.20.6"
   }
}
```

If you want resource location completions to always include the default `minecraft:` namespace, use the following config:
```json
{
   "lint": {
      "idOmitDefaultNamespace": false
   }
}
```

## Features

### Semantic coloring
All command arguments are colored semantically. This extension includes [syntax-mcfunction](https://marketplace.visualstudio.com/items?itemName=MinecraftCommands.syntax-mcfunction) as a dependency to get instant coloring feedback.

![Semantic coloring example](https://raw.githubusercontent.com/SpyglassMC/Spyglass/main/packages/vscode-extension/img/semantic-coloring.png)

### Diagnostics
Spyglass provides real-time diagnostics about your commands and JSON files. It can show syntax errors as Minecraft does, and even give you more detailed warnings.

![Diagnostics example](https://raw.githubusercontent.com/SpyglassMC/Spyglass/main/packages/vscode-extension/img/diagnostics.gif)

### Code completions
The extension can compute completions as you type commands. Completions will automatically show when typing certain characters. Alternatively you can use Ctrl + Space (or other configured hotkey) to show completions manually.

![Completions in an NBT tag](https://raw.githubusercontent.com/SpyglassMC/Spyglass/main/packages/vscode-extension/img/nbt-tag-completions.gif)
![Completions in an NBT path](https://raw.githubusercontent.com/SpyglassMC/Spyglass/main/packages/vscode-extension/img/nbt-path-completions.gif)
![Completions in a loot table file](https://raw.githubusercontent.com/SpyglassMC/Spyglass/main/packages/vscode-extension/img/loot-table-completions.gif)

### Definition links
You can navigate to functions, advancements, loot tables, and other resources by Ctrl-clicking on their namespaced IDs. This even works for vanilla resources.

![Document links example](https://raw.githubusercontent.com/SpyglassMC/Spyglass/main/packages/vscode-extension/img/document-link.gif)

### Peek references
You can find all the references of objectives, tags, data storages, functions, and other resources in the workspace by pressing Shift + F12 or other configured key.

![Peek references example](https://raw.githubusercontent.com/SpyglassMC/Spyglass/main/packages/vscode-extension/img/peek-references.png)

## Commands
> Full documentation: https://spyglassmc.com/user/commands

### Reset project cache
Spyglass uses a cache to speedup the process of validating, finding references/definitions, document links, etc. However the cache may become outdated because of various reasons, which could lead to strange behaviors. You can use the `Spyglass: Reset Project Cache` command to regenerate the cache manually. You can open the command prompt using Ctrl+Shift+P (or other configured hotkey).

### Open cache folder
If you are still experiencing problems after running the above command, you can navigate to the cache folder by using the `Spyglass: Open Cache Folder` command and wiping the folder. This removes the downloaded vanilla data pack, project caches, etc.

## Credits
This extension is only possible thanks to all the contributors that have worked on this project!

* <img src="https://avatars.githubusercontent.com/u/13565346?v=4&size=12"> [Afro](https://github.com/TheAfroOfDoom)
* <img src="https://avatars.githubusercontent.com/u/38361803?v=4&size=12"> [Calverin](https://github.com/Calverin)
* <img src="https://avatars.githubusercontent.com/u/46134240?v=4&size=12"> [ChenCMD](https://github.com/ChenCMD)
* <img src="https://avatars.githubusercontent.com/u/10163794?v=4&size=12"> [Jacobjso](https://github.com/jacobsjo)
* <img src="https://avatars.githubusercontent.com/u/17352009?v=4&size=12"> [Misode](https://github.com/misode)
* <img src="https://avatars.githubusercontent.com/u/12068027?v=4&size=12"> [Mulverine](https://github.com/MulverineX)
* <img src="https://avatars.githubusercontent.com/u/12124394?v=4&size=12"> [NeunEinser](https://github.com/NeunEinser)
* <img src="https://avatars.githubusercontent.com/u/26015841?v=4" width="12"> [Nicoder](https://github.com/Nico314159)
* <img src="https://avatars.githubusercontent.com/u/15277496?v=4&size=12"> [Spgoding](https://github.com/SPGoding)
* <img src="https://avatars.githubusercontent.com/u/13611030?v=4&size=12"> [Trivaxy](https://github.com/Trivaxy)
* <img src="https://avatars.githubusercontent.com/u/24430071?v=4" width="12"> [Vberlier](https://github.com/vberlier)

Additionally, thanks to all the translators, beta testers, and bug reporters!

The original Spyglass logo was provided by [BlackNight0315](https://github.com/BlackNight0315).
The current logo is provided by [asd988](https://github.com/asd988).
