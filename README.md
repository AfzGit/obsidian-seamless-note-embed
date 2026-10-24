# Seamless Note Embed

Seamless Note Embed makes notes you embed in Obsidian feel like part of the note you are reading. It moves their headings to the right level, adds them to the Outline, and can hide extra embed controls. The embedded note itself is never changed.

## Features

- Shift embedded headings to match the heading hierarchy of the containing note.
- Support nested embeds, section embeds such as `![[note#Heading]]`, and headings on the same line as the embed.
- Show embedded headings in Obsidian's built-in **Outline** view, at their shifted levels or their original levels when heading shifting is off.
- Expose embedded headings to metadata-cache-based outline and search plugins, including **Quiet Outline**, **Subtle TOC**, and **Another Quick Switcher**'s header search.
- Navigate to the exact rendered heading, not just the embed line, when possible.
- Optionally hide the embed line, indentation, filename, scrollbar, and open-note button.
- Optionally remove the embed height limit or justify reading-view text.
- Carry the appearance options into PDFs created with **Export to PDF**.
- Work in both Reading View and Live Preview.
- No note files are written to, and the plugin makes no network requests.

## The problem

Given `apple.md`:

```markdown
# apple 1
## apple 2
### apple 3
```

and `fruits.md`:

```markdown
# fruits 1
![[apple.md]]
## fruits 2
![[orange.md]]
```

Obsidian normally renders the embedded headings at their original levels:

```markdown
# fruits 1
# apple 1
## apple 2
### apple 3
## fruits 2
# orange 1
## orange 2
```

With this plugin, the embed is treated as part of the parent heading's section:

```markdown
# fruits 1
## apple 1
### apple 2
#### apple 3
## fruits 2
### orange 1
#### orange 2
```

In other words, every heading inside an embed is shifted by the level of the nearest heading above the embed in the containing note. An embed with no heading above it is left at its original levels. Nested embeds are cumulative as you go deeper.

## Outline and navigation

Running **Outline: Show outline** shows the note's own headings and the headings contributed by its embeds, indented under the correct parent.

Clicking an embedded heading in the outline navigates to the embed. Once the note is rendered, the plugin also scrolls to the exact shifted heading. Section embeds such as `![[note#Heading]]` work as expected; block embeds (`![[note#^block]]`) do not add headings.

### Third-party outline plugins

**Quiet Outline** and **Subtle TOC** also show the embedded headings. The plugin exposes the shifted headings through Obsidian's in-memory metadata cache, so metadata-cache-based outline plugins see them without any change to your notes. Clicking one navigates to the embed and then scrolls to the exact rendered heading.

Navigation is handled generically rather than per plugin. Embedded headings receive unique virtual line and offset values in the metadata cache, and a bridge translates those values through Obsidian's normal editor, preview, subpath-link, and CodeMirror APIs. That covers outline plugins, heading search commands such as Another Quick Switcher's **Header search in file**, and ordinary links to an embedded heading.

Quiet Outline's context menu and drag handling are disabled for embedded headings. Those entries point at the embed line in the parent note, so editing or moving them would change the embed link instead of the embedded note.

Other plugins that read `metadataCache.getFileCache(file).headings` will generally show the embedded headings too, and plugins that navigate through the common APIs above should land on the exact heading. A plugin that bypasses all of them may still stop at the embed line.

## Install

### From the community directory

When the plugin is available in the Obsidian Community directory, install it from **Settings → Community plugins → Browse** and search for **Seamless Note Embed**.

### Manual install from a release

Download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub release, then place them in:

```text
<vault>/.obsidian/plugins/seamless-note-embed/
├── main.js
├── manifest.json
└── styles.css
```

Enable **Seamless Note Embed** in **Settings → Community plugins**. The plugin folder uses the plugin ID, `seamless-note-embed`.

### From source

```bash
npm ci
npm run build
```

Copy the generated `main.js`, `manifest.json`, and `styles.css` into the plugin folder shown above. The build output is intentionally not committed to the repository; the release workflow builds it from source.

## Settings

- **Enable plugin features** — master switch for heading shifting, outline entries, navigation, and appearance changes. Turning it off restores normal Obsidian behavior.
- **Enable heading level shifting** — turns heading level shifting on or off. Embedded headings stay in the Outline and other outline plugins, but keep their original levels when this is off.
- **Apply in live preview** — also shift embeds while editing. Reading view is always supported while heading shifting is enabled.
- **Refresh now** — re-apply shifts to every open note.

The command palette also has these commands:

- **Toggle plugin on/off** — same as the master switch.
- **Toggle heading increments on/off** — same as **Enable heading level shifting**. Outline entries and navigation remain available.
- **Refresh embedded heading levels** — re-apply shifts to every open note.

On Obsidian 1.13 and later, every setting is searchable from Obsidian's settings search.

### Embed appearance

While plugin features are enabled, these optional CSS-only settings work independently of heading shifting and are all off by default:

- **Hide embed left line** — remove the colored line Obsidian draws on the left side of embedded notes.
- **Remove embed indentation** — remove the extra left padding and indentation guides from embedded note content.
- **Hide embedded note filename** — hide the filename shown above embedded notes.
- **Hide embed scrollbar** — hide the scrollbar on the right side of embedded notes while keeping them scrollable with the mouse wheel or trackpad.
- **Hide embed open-note button** — hide the open-note button in the top-right corner of embedded notes.
- **Remove embed height limit** — let long embedded notes expand to their full height in reading view and live preview instead of stopping at Obsidian's height limit. This also removes the embed scrollbar when the note fits within the old limit.
- **Justify text in reading view** — justify paragraphs, list items, table cells, and blockquotes, including text inside embedded notes.

The line, indentation, filename, scrollbar, open-note button, and height-limit rules are scoped to notes in Reading View and Live Preview; justification applies to Reading View. Hover previews are deliberately excluded, so Ctrl-hovering a link keeps its normal indentation, filename, scrollbar, open-note button, height limit, and left line. These settings are also carried into PDFs created with **Export to PDF**. If you previously used CSS snippets for these effects, disable them; a broad snippet such as `.markdown-embed-content .markdown-preview-view { padding-left: 0 }` will still affect hover previews.

## How it works

1. After Obsidian renders a note (or an embed), the plugin finds the top-level rendered note that contains it.
2. It walks the rendered document in order, tracking the nearest heading level.
3. When it reaches an embed, it renames the rendered `<h1>`–`<h6>` elements inside that embed to their shifted levels.
4. The original heading level is remembered in a DOM attribute so repeated renders are idempotent. The plugin restores the original levels when it is disabled or unloaded.

For the Outline view, the plugin builds the same hierarchy from Obsidian's metadata cache: the note's own headings plus the headings of each embedded note, shifted recursively. It then augments the core Outline view's heading list. The Outline's existing rendering, search, folding, and navigation are reused; no separate sidebar is added.

For third-party plugins, the same virtual headings are returned through a wrapped `metadataCache.getFileCache`. The wrapper is transparent to this plugin's own code, which always reads the real cache, so embedded headings are never counted twice. Each embedded heading gets a unique fractional line and a virtual offset, which preserve outline order and give offset-based navigation a stable token. A navigation bridge maps those tokens back to the embed's real line and then scrolls to the rendered heading. Turning off heading shifting keeps the wrapper and outline entries active but leaves embedded headings at their original levels. Turning off plugin features removes the appearance classes, restores normal heading levels, and stops the navigation, outline, and third-party patches.

In Reading View, Obsidian can virtualize the heading above an embed out of the DOM while the embed itself is still rendered. The plugin therefore reads heading positions and embed source lines from the preview renderer's section list, so a virtualized parent heading still shifts the embed correctly.

In Live Preview, the parent note's headings are CodeMirror lines rather than `<h1>` tags, and long notes are virtualized. The plugin therefore reads heading positions from the editor's current source and matches each rendered embed to its source position, so off-screen embeds do not disturb the outline order.

**No note files are written to.** Only the rendered DOM, the in-memory outline list, and a temporary in-memory metadata-cache view are changed. The plugin's own settings are stored in its `data.json`, as usual.

## Compatibility and limitations

- Requires Obsidian 1.5.0 or later. Obsidian 1.13 and later use the declarative settings API; older versions use the imperative settings tab.
- Heading levels are clamped at `h6`; HTML has no `h7`.
- Outline support uses Obsidian's internal Outline view methods. If a future Obsidian version changes them, the plugin leaves the view untouched and heading shifting still works, but embedded headings may disappear from the outline.
- Quiet Outline and Subtle TOC safe-editing support uses those plugins' internal methods. If a future version changes them, the headings still appear through the metadata cache, but Quiet Outline editing guards may not apply.
- Exposing virtual headings through the metadata cache means other plugins that read headings can see embedded headings too. This is intentional for outline and search support, but it may affect plugins that treat every cached heading as a real heading in the parent note. Plugins that bypass the bridged navigation APIs may stop at the embed line.
- Outline entries are rebuilt from the metadata cache, so newly typed headings and embeds appear after Obsidian updates its cache.
- Clicking an embedded outline entry jumps to the embed. Exact scrolling to the heading requires that heading to be rendered; in a long, virtualized Live Preview note it may not be available until scrolled into view.
- Block embeds do not contribute headings to the outline. Section embeds and nested embeds are supported.
- Reading View is fully supported, including when Obsidian virtualizes a parent heading out of the DOM; the plugin reads the preview renderer's source sections in that case. Live Preview uses Obsidian's internal CodeMirror view to map an embed to its source line; if that is unavailable it falls back to the visible heading lines. The fallback can be less accurate in very long, virtualized notes.
- Heading links inside an embedded note still point at the original note's headings; the plugin does not rewrite links.

## Privacy

The plugin does not collect telemetry, make network requests, or modify your notes. All work happens in memory and in the rendered DOM; the only file it writes is its own settings file, `data.json`.

## Development

```bash
npm ci
npm run dev     # rebuild on change
npm run check   # TypeScript type check
npm run lint    # official Obsidian plugin lint rules
npm test        # heading algorithm and DOM tests
npm run build   # type check and production bundle
```

Node.js 20.19+, 22.13+, or 24+ is required by the lint stack. Version bumps use `npm version patch|minor|major`, which updates `manifest.json` and `versions.json` through `version-bump.mjs`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the internals and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the development, testing, and release workflow.

## License

MIT
