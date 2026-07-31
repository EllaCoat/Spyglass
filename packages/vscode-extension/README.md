# TSB Spyglass (Local Canary)

Unofficial fork of [Spyglass](https://github.com/SpyglassMC/Spyglass) that adds IMP-Doc support (`#>` doc comments, `@private` / `@public` / `@within` / `@internal` / `@user` visibility, `#declare`, `#alias`) so that a Datapack Helper Plus v3 project can move to Spyglass v4 without losing the annotations it depends on.

**This is not an official Spyglass build and is not affiliated with the upstream project.** It is distributed as a locally built VSIX only, never through the Marketplace or Open VSX.

| | |
|---|---|
| Extension ID | `ellacoat.tsb-spyglass` |
| Upstream ID | `SPGoding.datapack-language-server` |
| Source | <https://github.com/EllaCoat/Spyglass> |

The *Configuration*, *Features* and *Credits* sections below are upstream documentation and apply unchanged. *Commands* describes this fork, whose analysis behaviour differs from upstream.

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

### 3. Open one repository per window

A pack declares everything it needs, so IMP-Doc `@within` and `#declare` resolve within a single project. Open one repository on its own and put a `spyglass.json` at its root. This is the standard setup.

A multi-root workspace holding several packs at once also works, but it is a different case and two effects are expected there rather than defects:

- Configuration is merged with later roots winning, so a `spyglass.json` that has drifted from the others silently overrides them. Keep the copies byte-identical.
- `impDocVisibilityConflict` can fire on declarations that legitimately exist in more than one pack. The rule compares the declarations of a symbol and never looks at the number of roots, so it reports a conflict that lives inside a single pack just as well; only the ones caused by packs overlapping are specific to this setup.

All the roots of such a workspace have to be in place when the server starts. Open the `.code-workspace` file rather than assembling the workspace by hand: a folder added to a running window through *Add Folder to Workspace* is not taken into the project, and only becomes part of it after *Developer: Reload Window*.

### 4. Version policy

The version is bumped on every rebuild that changes the packaged bytes, so a given `tsb-spyglass-<version>.vsix` corresponds to exactly one build. Publishing scripts (`npm run release`) are deliberately wired to fail; use `npm run package:vsix` instead.

### 5. Analyze the project before reading its diagnostics

Once the repository is open and the server has finished starting up, run `Spyglass: Analyze Project` and let it run to the end. Until it has, the files you do not have open are not guaranteed to carry checker and linter diagnostics, and the Problems panel is a mixture: the documents you have open are checked and linted in full, closed files a previous analysis reached are restored from a warm cache, and everything else this scan read afresh shows the output of the binding stage alone. Survey the diagnostics of the whole project, and compare them against another implementation, only after that run has completed.

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

Open the Command Palette (Ctrl+Shift+P, Shift+Cmd+P on macOS, or other configured hotkey) and type `Spyglass`.

### Analyze project
`Spyglass: Analyze Project` reads, parses, binds and checks every tracked file that sits under a project root and that the configuration does not exclude, then publishes the diagnostics it finds; dependencies such as the vanilla data pack are left out. **This is how the checker and the linter are run over a whole workspace.** The initial scan already binds the corpus and publishes what the binding stage finds, and a warm cache restores the diagnostics a previous analysis produced for closed files, but a full check of every file only happens here. It reports progress and can be cancelled.

Cancelling does not undo the part that already ran, and what is left behind depends on where the run stopped. Its first pass only reads and binds, so a cancellation there updates no diagnostics at all. Its second pass publishes them file by file, so a cancellation there leaves the files it reached with their new diagnostics and the rest with whatever they showed before, or with none. Either way the run skips saving the cache on its way out, although what it published can still be written by a later autosave or by a clean shutdown of the server. The notification that follows tells the two apart — a cancelled run reports how many files of the total it analyzed, a completed one does not — but the Problems panel keeps no mark of it, so a partial result read later is indistinguishable from a finished one. Run the command again to the end before taking the panel for the whole picture.

While it runs, no feature computes a partial result from a symbol table that is mid-rebuild. A hover is the only request that says so: as long as the hover feature is enabled, it answers that the project is still being analyzed. Completion, code actions, document symbols and the rest answer with an empty result, which the editor renders exactly like a genuine absence of candidates, so completions falling silent during an analysis is expected rather than a defect.

### Reset project cache
Spyglass uses a cache to speedup the process of validating, finding references/definitions, document links, etc. However the cache may become outdated because of various reasons, which could lead to strange behaviors. `Spyglass: Reset Project Cache` regenerates it manually.

The reset rebuilds the cache, the symbol table and the file hashes, and binds every tracked file again. It then rechecks the documents you have open, linter included, but **it does not check closed documents**: their diagnostics were produced by *Analyze Project*, and the reset discards the cache entry that held them. They stay absent until the next analysis, so run *Analyze Project* afterwards to get the complete set back.

### Show output
`Spyglass: Show Output` opens the language server log, which records the project lifecycle, the timing of each stage and the reason a file failed to be checked.

### Open cache folder
If you are still experiencing problems after running `Spyglass: Reset Project Cache`, you can navigate to the cache folder by using the `Spyglass: Open Cache Folder` command and wiping the folder. This removes the downloaded vanilla data pack, project caches, etc.

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
