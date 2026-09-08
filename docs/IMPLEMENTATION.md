# Base Path Updater Implementation Notes

[English](IMPLEMENTATION.md) · [简体中文](IMPLEMENTATION.zh-CN.md)

## Goals and scope

This plugin keeps fixed path references in `.base` files valid after folders are moved or renamed. The first release keeps the original event-driven approach while adding structured recognition, serialized processing, write-ahead snapshots, and conflict protection. Ordinary note edits do not trigger work, and the plugin does not take over Obsidian's link updating.

User-facing documentation is in the [README](../README.md). This document explains implementation decisions and maintenance practices.

## Research basis

The following official resources were consulted during development:

- [Build a plugin](https://docs.obsidian.md/Plugins/Getting%20started/Build%20a%20plugin): plugin entry points, manifests, and local loading.
- [Official sample project](https://github.com/obsidianmd/obsidian-sample-plugin): project structure using TypeScript, esbuild, and an external `obsidian` dependency. This project did not copy sample business code.
- [Vault API](https://docs.obsidian.md/Plugins/Vault): protected updates to current file content through `Vault.process()`.
- [Events](https://docs.obsidian.md/Plugins/Events): event registration and host-managed cleanup through `registerEvent()`.
- [Load time](https://docs.obsidian.md/plugins/guides/load-time): file creation events during startup and delaying the initial index until layout is ready.
- [Bases syntax](https://help.obsidian.md/bases/syntax): expressions in global and view-level `filters`, nested `and/or/not`, and `formulas`.
- [Bases functions](https://help.obsidian.md/bases/functions): string and path function semantics.

These sources support maintaining `.base` files directly without registering new Bases views or depending on private APIs from third-party plugins.

## Module structure

| File                   | Responsibility                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `src/main.ts`          | Plugin lifecycle, file index, serialized tasks, persistence, and undo                 |
| `src/base-document.ts` | Locates expressions that may be changed in YAML and patches their source ranges       |
| `src/expressions.ts`   | Expression tokenization, fixed-path recognition, path boundaries, and string escaping |
| `src/history.ts`       | History data structures, size accounting, validation, and undo conditions             |
| `src/ui.ts`            | History modal, path differences, undo entry points, and error feedback                |
| `src/i18n.ts`          | English/Chinese UI messages, error formatting, and localized dates                    |
| `src/errors.ts`        | Failure codes and parameters, exception serialization, and legacy message migration   |
| `tests/`               | Pure-function tests and lifecycle tests using a simulated Obsidian API                |

`src/write-coordinator.ts` coordinates outstanding writes in the same host so plugin reloads do not read stale history.

## Events and indexing

1. Load and validate plugin `data.json`. If it cannot be read or has an unsupported format, pause automatic writes to avoid overwriting old history.
2. Register events. On `onLayoutReady()`, call `vault.getFiles()` once and store `.base` `TFile` objects in a `Set` without pre-reading their contents.
3. Maintain the index incrementally when files are created, deleted, or renamed. Folder moves keep the `TFile` object references while the host updates their current paths.
4. Capture `oldPath`, `newPath`, and the candidate file list immediately on a folder `rename` event, then add the work to the promise queue.
5. Read candidate Bases sequentially and parse/write only files with matching content. Ordinary file renames update the index and history paths but do not scan content.
6. After unload, stop checks at async read/save boundaries and process callbacks prevent further writes. A write already submitted to the host cannot be cancelled, so a replacement instance waits for outstanding writes before reading history. A global Symbol stores a WeakMap of pending writes across module reloads; completed entries are removed.

Automatic updates and undo share one queue to prevent consecutive moves or repeated clicks from overwriting one another. There is no timer and ordinary `modify` events are not observed.

## Path and YAML rewriting

The plugin does not replace text across an entire file or serialize the whole YAML document again.

- First check whether the source contains the old path. If the text contains a backslash, still parse it so escaped YAML or expression paths are not missed.
- Parse nodes and source ranges with the `yaml` library. Invalid YAML is recorded and skipped.
- Traverse only the values of root `filters`, `views[*].filters`, and root `formulas`. Filters are handled recursively through `and/or/not`.
- Use complete string tokens to distinguish literals from code. Recognize `file.inFolder(constant)`, `file.path.startsWith(constant)`, `file.path == constant`, and the reversed equality comparison.
- Check left and right boundaries to exclude `this.file`, other property chains, and dynamic concatenation. This is not a complete expression compiler; an expression containing `/` outside strings is skipped as a whole, so division or regular expressions in that expression are not processed.
- Match only `path === oldPath` or `path.startsWith(oldPath + '/')`. Preserve vault-relative paths, case, and trailing slashes without fuzzy inference.
- Replace only the source range of the matching YAML scalar. Encode the new value as a YAML double-quoted string while preserving surrounding indentation, unrelated lines, comments, and line endings. Block scalars that match are converted to quoted strings while preserving header comments.
- Do not modify scalars with anchors or custom tags. Do not resolve aliases, so shared values cannot accidentally affect display names or other non-target fields.
- Validate the updated YAML again before returning the result.

`startsWith("Work")` has normal string-prefix semantics and may also match `Workshop`. The plugin changes only explicit path constants and does not rewrite the filter's logic; the README recommends using `"Work/"`.

## Writes, history, and undo

Each folder change creates an operation containing its timestamp, old and new folder paths, complete before-and-after snapshots for each affected Base, path differences, and errors. History is stored as `version: 2` in the plugin's `data.json`.

Plugin failures store a stable `code` and any required `params`. Operation failures store the event-time file path separately and are translated when displayed. System and third-party errors use `external` with the original message. Paths, Base content, and snapshots are never translated.

Loading supports `version: 1`: exact known Chinese plugin messages become structured failures, while unknown text is preserved verbatim. Migration leaves the input object and snapshots unchanged. It happens in memory and is persisted on the next normal history save. Corrupt data, unknown versions, or unknown failure codes pause automatic writes. Older plugin builds cannot read v2 history and will refuse it after a downgrade; do not relabel v2 data as v1.

## UI language

The public `getLanguage()` API selects simplified Chinese for Chinese locales and English otherwise. Commands, menus, settings, notifications, modal statuses, and errors share centralized translations. Language changes follow Obsidian's reload flow to register commands and search metadata again. Each history render uses the current language; dates use the same locale and the local time zone.

Settings definitions include both English and Chinese search terms. Command names use the selected language while command IDs remain stable. Obsidian 1.13+ uses declarative settings; older versions use `display()`. Both share translations and history actions without duplicating business logic.

## Write ordering and conflict protection

For each file, the write order is:

1. Read the file and calculate candidate changes.
2. Check that the active operation plus its candidate snapshot fits on its own before adding it or evicting older records beyond 30 operations or the total capacity budget. Skip candidates that cannot fit. If every candidate was rejected for capacity, only show a skip notice without consuming a history slot or saving the journal; all existing records are retained, even at the 30-operation limit.
3. **Save history successfully before modifying the Base.** Pause later tasks if storage fails.
4. Use `vault.process()` and check inside the callback that the current content still exactly matches the read snapshot; otherwise skip it as a conflict.
5. Summarize processing errors and save history.

This is a recoverable per-file operation, not an atomic transaction across multiple files. A failure in one file does not prevent other files from being processed, so a partial update is possible.

Undo also uses `vault.process()` to compare complete contents:

- If the current content equals `after`, restore `before`.
- If the current content equals `before`, treat it as already restored or as a write that never happened; do not write again.
- Otherwise mark a conflict and preserve the current file.
- If the original file was deleted or is no longer a `.base` file, do not restore or recreate it. Deletions observed during runtime are persisted so undo cannot target a new file at the same path.

The write-ahead snapshot can show whether a write happened after a process interruption. A history entry marked as recorded means that a verifiable snapshot exists; it does not promise that an interrupted transaction completed. After a restart, current content is checked. A file deleted and recreated with identical content while the plugin was disabled cannot be identified by path alone.

History updates Base and parent-folder paths when the plugin observes their renames; moves while it is disabled cannot be tracked. Undo never moves folders and history is not a replacement for a complete backup.

Complete snapshots provide strict conflict protection, but even a user change to a comment causes undo to skip the file. The first release chooses conservative skipping instead of risking an incorrect partial reverse replacement.

## Performance boundaries

Startup performs one file-list traversal; ordinary edits do not read Base contents. Each folder change performs I/O proportional to the total size of candidate Bases, and parsing occurs only for files that may contain a match. Sequential reads and writes avoid large bursts of I/O; there is no content cache or continuously parsed index.

At most 30 operations are retained, with a 5 MiB snapshot budget. Small metadata such as error messages may make the final JSON slightly exceed the budget. Size is measured in UTF-8 bytes. Because each file's snapshot is saved before its write, a large batch of matches incurs extra serialization and disk cost; there is currently no performance claim for large vaults. A separate log file may be considered after real usage data is available, rather than adding complexity prematurely.

## Development and build

Use Node.js 22.12+ (the validation environment used Node.js 24) and npm:

```sh
npm ci
npm run check
npm run dev
```

`npm run check` runs the automated tests, TypeScript check, and production build. `npm run dev` watches the source and generates the root `main.js` used for local plugin development.

```sh
npm run build
npm run format:check
```

Production installation files are written to `dist/base-path-updater/` and contain `main.js`, `manifest.json`, and `styles.css`. `obsidian` is provided by the host, while `yaml` is bundled with the plugin; the plugin makes no network requests. Source code, build configuration, and the lockfile are tracked in Git, while dependencies, build outputs, and history data are ignored. Before a release, update the manifest author, version, and `versions.json`.

For tag-triggered releases, see the [release guide](RELEASING.md) (Chinese).

## Validation and manual acceptance

Automated tests cover path boundaries, nested filters, quotes and escapes, CRLF, block scalars, comments, anchor protection, skipped dynamic expressions, invalid YAML, queue ordering, concurrent edits before writes, history-save failures, undo after restart, deletion protection, and stopping on unload. The host is represented by a simulated API; this is not the same as end-to-end testing in the real Obsidian client.

Recommended acceptance checks in a test vault:

1. Create `Work/Research/Notes.md` and a Base containing the three conditions from the README, including a view-level filter.
2. Rename `Research` and confirm that the filter still finds the note and that history shows the path change.
3. Move the entire `Work` folder into another directory and then move it twice more; confirm that Bases inside the moved folder are updated correctly.
4. Open history and undo from newest to oldest. Confirm that only Base content is restored and folder locations do not change.
5. Edit a comment in one Base before undoing. Confirm that the file is skipped while other files can still be restored.
6. Restart Obsidian, inspect history, and undo. Check the ribbon menu, command palette, and settings entry points.
7. Create, delete, and rename `.base` files and confirm that the index follows them; ordinary note edits should not create history.
8. Check light and dark themes and the mobile modal. The plugin does not use desktop-only APIs, but mobile still requires testing on a real device.
9. Start Obsidian in English and Chinese and inspect commands, menus, notifications, history statuses, and errors. On 1.13+, search settings for `history`, `undo`, `更新历史`, and `撤回`; on older versions, check the settings button. After changing language, known plugin failures in existing history should follow the UI language while external messages and snapshots remain unchanged.

## Possible future improvements

Based on actual needs, consider more path functions, embedded Bases, file-level moves, a manual repair preview, and a precise expression syntax tree. Add false-positive tests alongside any new supported syntax, and do not automatically rewrite ordinary path strings as references.
