# Architecture and internals

This document explains how Seamless Note Embed works, which Obsidian internals it touches, and why the implementation looks the way it does. It is intended for future maintenance, not for normal plugin use.

## Invariants

1. **Never write to notes or source files.** The plugin changes rendered DOM, in-memory metadata, and in-memory outline state. Its only disk write is the usual plugin settings file, `data.json`.
2. **Never modify the embedded note.** Heading levels are changed by replacing rendered heading elements, not by editing Markdown.
3. **Do not double-count embeds.** Every internal read of Obsidian's metadata cache goes through the raw-cache registry, not through the wrapped public method.
4. **Be reversible.** Every monkey-patch records enough ownership information to restore the original property or delete an own property that the plugin added.
5. **Prefer graceful degradation.** If an internal API is missing or throws, the plugin should leave that integration alone and keep heading shifting working.
6. **Only note embeds consume outline indices.** Images, PDFs, missing notes, block embeds, and other non-note embeds must not shift the keys of later note embeds.

## Runtime lifecycle

`src/main.ts` starts the integrations in this order:

1. Load settings and apply CSS appearance classes.
2. Start `MetadataHeadingIntegration`, which wraps `metadataCache.getFileCache`.
3. Start `HeadingNavigationBridge`, which patches navigation APIs.
4. Create the processor and start the built-in `OutlineIntegration`.
5. Start `ThirdPartyOutlineIntegration`.
6. Register the Markdown post-processor, workspace/vault events, the refresh command, and the settings tab.
7. On layout ready, refresh all integrations.

Unload order is deliberate:

1. Remove appearance classes.
2. Destroy the navigation bridge before the metadata wrapper.
3. Destroy the metadata wrapper.
4. Destroy third-party integrations and the built-in outline integration.
5. Restore all shifted headings and destroy the processor.

The navigation bridge is removed before the metadata wrapper so no patched navigation path can resolve a virtual token after the token registry is gone. The processor is restored last so headings return to their source levels even if another integration fails.

## Module map

| File | Responsibility |
| --- | --- |
| `src/main.ts` | Plugin lifecycle, events, commands, settings application, appearance classes. |
| `src/settings.ts` | Settings model, defaults, imperative `display()` tab, declarative `getSettingDefinitions()` for Obsidian 1.13+. |
| `src/processor.ts` | Rendered DOM heading shifting for Reading View and Live Preview. |
| `src/headingMath.ts` | Pure heading-level helpers and class/tag detection. |
| `src/headingSource.ts` | Source-line heading parser used by Live Preview. |
| `src/embedData.ts` | Raw metadata access, embed resolution, section filtering. |
| `src/embedTargets.ts` | Pure link/subpath parsing, heading normalization, matching, section ranges. |
| `src/outlineHeadings.ts` | Builds the flat synthetic heading list for outlines. |
| `src/outlineKeys.ts` | Stable outline keys and metadata shape. |
| `src/metadataHeadings.ts` | Virtual headings exposed through `metadataCache.getFileCache`. |
| `src/rawMetadata.ts` | Registry for the unwrapped `getFileCache` getter. |
| `src/outline.ts` | Patches Obsidian's built-in Outline view. |
| `src/navigationBridge.ts` | Translates virtual positions to real positions and schedules exact scrolling. |
| `src/thirdPartyOutlines.ts` | Quiet Outline and Subtle TOC integration. |
| `src/headingNavigation.ts` | Shared view lookup and exact-heading scroller. |
| `styles.css` | CSS-only appearance settings and print/PDF flags. |

## Rendered heading shifting

`EmbedHeadingProcessor` works on a **render root**:

- `.markdown-preview-view` for Reading View.
- `.cm-content` for Live Preview.
- `.markdown-rendered` for views such as canvas cards that render Markdown without either usual root.

`findRenderRoot()` walks ancestors and picks the outermost matching root that is not inside `.markdown-embed-content`. An embed can contain its own preview view, so always choosing the outermost root keeps the parent note as the coordinate system.

### Reading View

`processScope()` walks child elements in document order and maintains:

- `currentLevel`: the effective level of the most recent heading.
- `embedIndex`: the index of the next note embed in this scope.

When it finds an `<h1>`–`<h6>`:

- In the root note, headings are never shifted. If a heading still has a stored original level (for example after an embed moved out from under a heading), it is restored.
- In an embed, the heading gets `data-aeih-original-level` if it does not already have one, is replaced with the shifted tag, gets `data-aeih-shift`, and gets an outline key when it can be matched to the metadata cache.

`replaceHeading()` creates a new element, copies every attribute (including namespaced attributes), moves all children, and calls `replaceWith()`. Children are moved rather than cloned so event listeners on child nodes survive.

### Live Preview

Live Preview is different because:

- Parent-note headings are CodeMirror lines (`.cm-line`, `HyperMD-header-N`), not `<hN>` tags.
- CodeMirror virtualizes long documents, so off-screen heading lines may not be in the DOM.
- Embeds are widgets; their source position must be recovered from CodeMirror.

`getLivePreviewEmbedInfo()` reads the editor source with `view.editor.getValue()`, parses headings with `parseHeadingLines()`, and maps each rendered top-level embed back to a source line with `editorView.posAtDOM()` and `editorView.state.doc.lineAt()`. It then computes the nearest preceding heading level from source, not from the visible DOM. The embed index comes from the note's metadata cache, filtered to resolvable note embeds, so earlier off-screen embeds do not disturb outline keys.

`parseHeadingLines()` handles ATX headings, setext headings, fenced code blocks, YAML frontmatter, and a UTF-8 BOM. It is intentionally a small Markdown parser; it only needs heading positions and levels.

### Attributes

| Attribute | Meaning |
| --- | --- |
| `data-aeih-original-level` | Original source level of an embedded heading. Its presence means the element is tracked and must be restored. |
| `data-aeih-shift` | Effective shift amount. Used for cleanup even when the original level is not available. |
| `data-aeih-outline-key` | Stable key connecting a rendered heading to an outline entry. |

### Mutation handling

Each active root gets a `MutationObserver` watching `childList` and `subtree`. Relevant mutations schedule a `requestAnimationFrame` refresh. This makes embeds that render late (or re-render after scrolling) eventually get the correct shift without walking every note on every mutation.

`restoreWithin()` restores tracked headings and removes shift/outline attributes. `restoreAll()` runs on disable, unload, and manual refresh.

## Outline heading model

`buildOutlineHeadings()` merges headings and embeds into one event stream sorted by source line and column. Headings on the same line as an embed come first.

For each note embed:

1. Resolve the link path and subpath.
2. Stop cycles by keeping a chain of `(path, subpath)` keys.
3. Filter the target to the section rendered by a section embed.
4. Recursively append the target's headings and nested embeds.

Each synthetic heading is an `OutlineHeading`, which extends Obsidian's `HeadingCache` with an optional `aeih` metadata object:

```ts
interface OutlineEmbedMeta {
  key: string;
  rootPath: string;
  embedPath: number[];
  targetPath: string;
  targetLine: number;
  originalLevel: number;
  embedLine: number;
}
```

`key` is `JSON.stringify([rootPath, embedPath, targetPath, targetLine])`. JSON quoting avoids collisions with characters that can appear in vault paths.

### Fake positions

Synthetic headings point at the top-level embed's line:

- `position.start.line` is the embed line so the core Outline can navigate to the embed.
- `position.end.line` is `Number.MAX_SAFE_INTEGER` so the core Outline's preview-mode active-heading check does not select a fake heading. The real parent heading above the embed should stay highlighted.

The core Outline compares headings by object identity in some paths. `buildOutlineHeadings()` therefore keeps real heading objects unchanged instead of cloning them.

## Virtual metadata cache

Quiet Outline, Subtle TOC, and other plugins read headings from `metadataCache.getFileCache(file).headings`. To make embedded headings visible without writing to disk, `MetadataHeadingIntegration` wraps `getFileCache` on the app's metadata cache object.

### Raw-cache registry

The wrapper calls the original bound getter, then returns a shallow copy of the cache with `headings` replaced by the combined list. The plugin's own code must never read the wrapped method, or an embed would be counted twice. `src/rawMetadata.ts` stores the original getter in a `WeakMap<App, RawFileCacheGetter>`. `getRawFileCache()` always uses that getter when available.

### Cache fingerprint

The augmented result is cached per `TFile` in a `WeakMap`. The cache key includes the raw cache object identity and a signature made from heading levels/lines/text and embed lines/links. Obsidian normally replaces the cache object on edits, but the signature also catches in-place mutations. `refresh()` replaces the WeakMap and clears all token maps.

### Virtual positions

Synthetic headings need positions that:

- Sort in the correct outline order.
- Are unique enough for offset-based navigation.
- Never collide with real file offsets.

`virtualizeHeadings()` groups synthetic headings by their top-level embed line. For a group of `n` headings after embed line `L`, heading `i` gets:

```text
line = L + (i + 1) / (n + 1)
```

This fractional line sorts between the embed and the next real heading. The token also gets:

- `col = i`
- `offset = VIRTUAL_OFFSET_BASE + hash(filePath + "\0" + key) * VIRTUAL_OFFSET_STRIDE`
- `endOffset = offset + heading.length`

`VIRTUAL_OFFSET_BASE` is `2 ** 40`, far beyond real file sizes. `VIRTUAL_OFFSET_STRIDE` is `2 ** 16`. Hash collisions are resolved by incrementing the offset until it is free.

The integration keeps three indexes:

- `tokensByOffset`: exact offset and containing-range lookup.
- `tokensByLine`: per-file fractional line lookup.
- `tokensByFile`: cleanup when a file's headings are rebuilt.

`resolveVirtualOffset()`, `resolveVirtualLine()`, and `resolveVirtualSubpath()` are the public lookup points used by the navigation bridge.

### Wrapper removal

`stop()` only removes the wrapper if it is still the installed one. If another plugin wrapped `getFileCache` after this plugin, the plugin leaves that wrapper in place and keeps its raw getter registered, because removing it would make internal reads recurse through the other wrapper. This is a deliberate compromise: the other plugin keeps working, and this plugin avoids infinite recursion.

## Built-in Outline integration

`OutlineIntegration` patches each open Outline view's own or prototype methods:

- `getHeadings()` returns the combined synthetic list built from raw metadata.
- `update()` calls the original and then decorates the rendered items.
- `createItemDom()` decorates newly created items.
- `findActiveHeading()` returns `null` for synthetic headings so a fake heading does not stay highlighted while scrolling.

The patch records whether each method was an own property before patching. On restore, an own property is restored; a method that came from the prototype is deleted, not overwritten. This matters because the core Outline keeps these methods on its prototype.

The integration also adds capture-phase listeners:

- `click`: lets the core handler run, then schedules an exact scroll to the shifted heading.
- `mouseover`: stops the core hover preview for synthetic items, because the fake heading does not exist in the parent note.
- `dragstart`: prevents dragging synthetic items, which would move or edit the embed link.

`HeadingScroller` looks up the rendered element by `data-aeih-outline-key`, prefers an element with non-zero client rects, and retries for up to 40 × 50 ms while Obsidian renders the embed. A new scroll request increments a token and cancels older retries.

## Navigation bridge

`HeadingNavigationBridge` exists because virtual lines and offsets are not real editor positions. It patches the common navigation surfaces and translates virtual positions back to real ones.

| Patched API | Behavior |
| --- | --- |
| `WorkspaceLeaf.openFile` | After the file opens, flush any pending exact-scroll request for that path. |
| `MarkdownView.setEphemeralState` | Maps virtual subpaths, lines, and cursors to real positions, then schedules the exact heading scroll. |
| `Editor.offsetToPos` | Maps a virtual offset to the embed line and schedules a scroll. |
| `Editor.posToOffset` | Maps a virtual line back to its virtual offset, **without** scheduling a scroll. |
| `Editor.setCursor` | Maps a virtual position to the embed line and schedules a scroll. |
| `Editor.setSelection` | Maps either endpoint and schedules a scroll. |
| `Editor.scrollIntoView` | Maps the range and schedules a scroll. |
| Preview renderer `applyScroll` / `applyScrollDelayed` | Maps the virtual line to the embed line and schedules an exact scroll. |
| CodeMirror `Text.line` | Maps fractional virtual lines to real 1-based lines, **without** scheduling a scroll. |

### Active vs passive mappings

`posToOffset` and `Text.line` are deliberately passive. Plugins such as Subtle TOC use them while tracking the active heading or hit-testing. Treating those lookups as navigation requests would make multiple plugins fight over the viewport and cause scroll hijacking. Only APIs that represent an explicit navigation request schedule a scroll.

### Pending scrolls

Some navigation paths finish with `leaf.openFile(..., { eState })`, which scrolls to the embed line after the bridge's first request. `rememberPending()` stores the target token per file for up to 5 seconds. `flushPending()` re-applies the exact scroll after the leaf opens the file. A new navigation for the same file replaces the pending token.

`resolveLine()` tries the exact fractional line and then `line - 1`, because some callers round or add one to line numbers.

### Patch installation and removal

`installOnPrototypeOrObject()` prefers an own method, then a prototype method, then a late-bound own method. `installMethod()` records:

- target object
- property key
- whether the target had an own property
- original value
- wrapper value

`restoreAll()` walks patches in reverse and only restores a property if it still points at this plugin's wrapper. If another plugin wrapped it later, this plugin leaves the newer wrapper in place rather than clobbering it.

## Third-party outline integrations

`ThirdPartyOutlineIntegration` does not implement navigation itself. It only attaches metadata and prevents destructive edits; navigation flows through the generic bridge.

### Quiet Outline

Plugin ID: `obsidian-quiet-outline`.

- Only the `markdown` and `embed-markdown-file` navigator IDs are treated as note navigators. Kanban, Canvas, PDF, and other subclasses are left alone.
- `getHeaders()` is wrapped to attach `aeih` metadata to each header when the combined heading list and the plugin's header list have the same length. If Quiet Outline filters or reorders headings, metadata is left alone rather than attached to the wrong entry.
- `onRightClick()` is disabled for synthetic headings; editing at a fake line would replace the embed link.
- `handleDrop()` is disabled when either endpoint is synthetic; dragging would move the embed link.
- `updateNav()` and `updateNavAndRefresh()` are wrapped to re-patch a navigator that Quiet Outline replaces.

### Subtle TOC

Plugin ID: `subtle-toc`.

- `overlay.refresh()` is wrapped to attach metadata and refresh active state.
- `overlay.updateActive()` and `overlay.navigate()` are wrapped to keep synthetic headings safe and to schedule exact navigation.
- A short timer coalesces navigation.

## Settings and appearance

`src/settings.ts` has one source of truth for setting rows. Both APIs use the same row definitions:

- `display()` renders `Setting` objects into the tab for Obsidian < 1.13.
- `getSettingDefinitions()` returns declarative definitions for Obsidian 1.13+, which also makes settings searchable.

Toggles call `saveSettings()` and then either `reapplySettings()` (heading shifting) or `applyAppearanceSettings()` (CSS-only options). The refresh button calls `refreshHeadingLevels()`.

`src/main.ts` maps each appearance option to a body class and a print flag:

| Setting | Class | Print flag |
| --- | --- | --- |
| Hide embed left line | `aeih-hide-embed-line` | `--aeih-print-hide-embed-line` |
| Remove embed indentation | `aeih-hide-embed-indent` | `--aeih-print-hide-embed-indent` |
| Hide embedded note filename | `aeih-hide-embed-title` | `--aeih-print-hide-embed-title` |
| Hide embed scrollbar | `aeih-hide-embed-scrollbar` | `--aeih-print-hide-embed-scrollbar` |
| Hide embed open-note button | `aeih-hide-embed-open-button` | `--aeih-print-hide-embed-open-button` |
| Remove embed height limit | `aeih-remove-embed-limit` | `--aeih-print-remove-embed-limit` |
| Justify text in reading view | `aeih-justify-preview` | `--aeih-print-justify-preview` |

The class is applied to `document.body` for the live app. The print flag is set with `body.setCssProps({ [flag]: "1" })` and removed with `body.style.removeProperty(flag)`. `styles.css` uses `body[style*="--aeih-print-...:"] .print ...` selectors because Obsidian's PDF export copies inline custom properties but not arbitrary body classes.

All live selectors are scoped to `.markdown-reading-view` or `.markdown-source-view`, so hover previews (`.popover.hover-popover`) keep their normal appearance.

## Fragile Obsidian internals

The following are not public, stable APIs and should be checked when Obsidian updates:

- `metadataCache.getFileCache` property shape and wrapping behavior.
- Core Outline view methods `getHeadings`, `update`, `createItemDom`, `findActiveHeading`, `cachedHeadingDom`.
- `MarkdownView.setEphemeralState`, `previewMode.renderer`, `editor`, `editMode.editor`.
- Editor methods `offsetToPos`, `posToOffset`, `setCursor`, `setSelection`, `scrollIntoView`.
- CodeMirror `view.editor.cm`, `posAtDOM`, `state.doc.lineAt`, `Text.line`.
- Quiet Outline plugin ID, navigator IDs, `getHeaders`, `onRightClick`, `handleDrop`, `updateNav`, `updateNavAndRefresh`.
- Subtle TOC plugin ID, overlay `refresh`, `updateActive`, `navigate`.
- DOM classes such as `.markdown-embed`, `.markdown-embed-content`, `.markdown-preview-view`, `.cm-content`, `.markdown-rendered`.

The code uses optional methods, `typeof` checks, `try/catch`, and feature detection so a missing internal API disables only that integration. When changing these areas, keep the same defensive style and add a test with a fake object that omits the optional members.

## Tests

The tests bundle selected TypeScript modules with esbuild into `tests/.tmp` and run them under Node's test runner with jsdom. They cover:

- heading level math and source parsing
- embed link/subpath resolution
- Reading View and Live Preview DOM shifting
- section and nested embeds
- outline heading order and keys
- virtual metadata positions and navigation
- built-in Outline patching
- Quiet Outline and Subtle TOC integration

Because the production code uses Obsidian's `ownerDocument.win.createEl`, the jsdom setup defines `dom.window.document.win = dom.window` and a small `window.createEl` polyfill. Keep those lines when adding a new jsdom test file that imports the processor.
