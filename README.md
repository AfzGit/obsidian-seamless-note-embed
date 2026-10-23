# Seamless Note Embed

An Obsidian plugin that makes embedded notes feel like part of the containing note. It shifts the headings of an embedded note so they nest under the heading that contains the embed, and it offers optional appearance controls for the embed itself. The embedded note is never modified.

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

In other words, every heading inside an embed is shifted by the level of the nearest heading above the embed in the containing note. An embed with no heading above it is left at its original levels.

Nested embeds are supported: the shift is cumulative as you go deeper.

## Outline pane

The embedded headings also appear in Obsidian's built-in **Outline** view with their shifted levels. Running `Outline: Show outline` shows the note's own headings and the headings contributed by its embeds, indented under the correct parent.

Clicking an embedded heading in the outline navigates to the embed. Once the note is rendered, the plugin also scrolls to the exact shifted heading. Section embeds such as `![[note#Heading]]` work as expected; block embeds (`![[note#^block]]`) do not add headings.

### Third-party outline plugins

**Quiet Outline** and **Subtle TOC** also show the embedded headings. The plugin exposes the shifted headings through Obsidian's in-memory metadata cache, so metadata-cache-based outline plugins see them without any change to your notes. Clicking one navigates to the embed and then scrolls to the exact rendered heading.

Navigation is handled generically rather than per plugin. Embedded headings receive unique virtual line and offset values in the metadata cache, and a bridge translates those values through Obsidian's normal editor, preview, subpath-link, and CodeMirror APIs. That covers outline plugins, heading search commands such as Another Quick Switcher's **Header search in file**, and ordinary links to an embedded heading.

Quiet Outline's context menu and drag handling are disabled for embedded headings. Those entries point at the embed line in the parent note, so editing or moving them would change the embed link instead of the embedded note.

Other plugins that read `metadataCache.getFileCache(file).headings` will generally show the embedded headings too, and plugins that navigate through the common APIs above should land on the exact heading. A plugin that bypasses all of them may still stop at the embed line.

## Install

### From source

```bash
npm install
npm run build
```

Copy these files into your vault:

```text
<vault>/.obsidian/plugins/auto-incremented-embed-headings/
├── main.js
├── manifest.json
└── styles.css
```

Then enable **Seamless Note Embed** in **Settings → Community plugins**. The plugin folder keeps its original ID (`auto-incremented-embed-headings`) so existing installations and settings continue to work.

### Development

```bash
npm install
npm run dev     # rebuild on change
npm run check   # TypeScript type check
npm test        # heading algorithm and DOM tests
```

## Settings

- **Enable heading level shifting** — turns heading shifting on or off.
- **Apply in Live Preview** — also shift embeds while editing. Reading View is always supported while heading shifting is enabled.
- **Refresh now** — re-apply shifts to every open note.

There is also a command, **Refresh embedded heading levels**, in the command palette.

### Embed appearance

These optional CSS-only settings work independently of heading shifting and are all off by default:

- **Hide embed left line** — remove the colored line Obsidian draws on the left side of embedded notes.
- **Remove embed indentation** — remove the extra left padding and indentation guides from embedded note content.
- **Hide embedded note filename** — hide the filename shown above embedded notes.
- **Hide embed scrollbar** — hide the scrollbar on the right side of embedded notes while keeping them scrollable with the mouse wheel or trackpad.
- **Hide embed open-note button** — hide the open-note button in the top-right corner of embedded notes.
- **Remove embed height limit** — let long embedded notes expand to their full height in Reading View and Live Preview instead of stopping at Obsidian's height limit. This also removes the embed scrollbar when the note fits within the old limit.
- **Justify text in Reading View** — justify paragraphs, list items, table cells, and blockquotes, including text inside embedded notes.

The line, indentation, filename, scrollbar, open-note button, and height-limit rules are scoped to notes in Reading View and Live Preview; justification applies to Reading View. Hover previews are deliberately excluded, so Ctrl-hovering a link keeps its normal indentation, filename, scrollbar, open-note button, height limit, and left line. These settings are also carried into PDFs created with **Export to PDF**. If you previously used CSS snippets for these effects, disable them; a broad snippet such as `.markdown-embed-content .markdown-preview-view { padding-left: 0 }` will still affect hover previews.

## How it works

1. After Obsidian renders a note (or an embed), the plugin finds the top-level rendered note that contains it.
2. It walks the rendered document in order, tracking the nearest heading level.
3. When it reaches an embed, it renames the rendered `<h1>`–`<h6>` elements inside that embed to their shifted levels.
4. The original heading level is remembered in a DOM attribute so repeated renders are idempotent. The plugin restores the original levels when it is disabled or unloaded.

For the Outline view, the plugin builds the same hierarchy from Obsidian's metadata cache: the note's own headings plus the headings of each embedded note, shifted recursively. It then augments the core Outline view's heading list. The Outline's existing rendering, search, folding, and navigation are reused; no separate sidebar is added.

For third-party plugins, the same virtual headings are returned through a wrapped `metadataCache.getFileCache`. The wrapper is transparent to this plugin's own code, which always reads the real cache, so embedded headings are never counted twice. Each embedded heading gets a unique fractional line and a virtual offset, which preserve outline order and give offset-based navigation a stable token. A navigation bridge maps those tokens back to the embed's real line and then scrolls to the rendered heading. Turning off heading shifting makes the wrapper return the real cache, and unloading the plugin removes the wrapper and the bridge.

In Live Preview, the parent note's headings are CodeMirror lines rather than `<h1>` tags, and long notes are virtualized. The plugin therefore reads heading positions from the editor's current source and matches each rendered embed to its source position, so off-screen embeds do not disturb the outline order.

**No vault files are written to.** Only the rendered DOM, the in-memory outline list, and a temporary in-memory metadata-cache view are changed.

## Limitations

- Heading levels are clamped at `h6`; HTML has no `h7`.
- Outline support uses Obsidian's internal Outline view methods. If a future Obsidian version changes them, the plugin leaves the view untouched and heading shifting still works, but embedded headings may disappear from the outline.
- Quiet Outline and Subtle TOC safe-editing support uses those plugins' internal methods. If a future version changes them, the headings still appear through the metadata cache, but Quiet Outline editing guards may not apply.
- Exposing virtual headings through the metadata cache means other plugins that read headings can see embedded headings too. This is intentional for outline and search support, but it may affect plugins that treat every cached heading as a real heading in the parent note. Plugins that bypass the bridged navigation APIs may stop at the embed line.
- Outline entries are rebuilt from the metadata cache, so newly typed headings and embeds appear after Obsidian updates its cache.
- Clicking an embedded outline entry jumps to the embed. Exact scrolling to the heading requires that heading to be rendered; in a long, virtualized Live Preview note it may not be available until scrolled into view.
- Block embeds do not contribute headings to the outline. Section embeds and nested embeds are supported.
- Reading View is fully supported. Live Preview uses Obsidian's internal CodeMirror view to map an embed to its source line; if that is unavailable it falls back to the visible heading lines. The fallback can be less accurate in very long, virtualized notes.
- Heading links inside an embedded note still point at the original note's headings; the plugin does not rewrite links.
