# Auto-Incremented Embed Headings

An Obsidian plugin that shifts the headings of an embedded note so they nest under the heading that contains the embed. The embedded note itself is never modified.

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

Then enable **Auto-Incremented Embed Headings** in **Settings → Community plugins**.

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
- **Justify text in Reading View** — justify paragraphs, list items, table cells, and blockquotes, including text inside embedded notes.

The line, indentation, and filename rules are scoped to notes in Reading View and Live Preview; justification applies to Reading View. Hover previews are deliberately excluded, so Ctrl-hovering a link keeps its normal indentation, filename, and left line. All four options also apply to PDFs created with **Export to PDF**. If you previously used CSS snippets for these effects, disable them; a broad snippet such as `.markdown-embed-content .markdown-preview-view { padding-left: 0 }` will still affect hover previews.

## How it works

1. After Obsidian renders a note (or an embed), the plugin finds the top-level rendered note that contains it.
2. It walks the rendered document in order, tracking the nearest heading level.
3. When it reaches an embed, it renames the rendered `<h1>`–`<h6>` elements inside that embed to their shifted levels.
4. The original heading level is remembered in a DOM attribute so repeated renders are idempotent. The plugin restores the original levels when it is disabled or unloaded.

For the Outline view, the plugin builds the same hierarchy from Obsidian's metadata cache: the note's own headings plus the headings of each embedded note, shifted recursively. It then augments the core Outline view's heading list. The Outline's existing rendering, search, folding, and navigation are reused; no separate sidebar is added.

In Live Preview, the parent note's headings are CodeMirror lines rather than `<h1>` tags, and long notes are virtualized. The plugin therefore reads heading positions from the editor's current source and matches each rendered embed to its source position, so off-screen embeds do not disturb the outline order.

**No vault files are written to.** Only the rendered DOM and the in-memory outline list are changed.

## Limitations

- Heading levels are clamped at `h6`; HTML has no `h7`.
- Outline support uses Obsidian's internal Outline view methods. If a future Obsidian version changes them, the plugin leaves the view untouched and heading shifting still works, but embedded headings may disappear from the outline.
- Outline entries are rebuilt from the metadata cache, so newly typed headings and embeds appear after Obsidian updates its cache.
- Clicking an embedded outline entry jumps to the embed. Exact scrolling to the heading requires that heading to be rendered; in a long, virtualized Live Preview note it may not be available until scrolled into view.
- Block embeds do not contribute headings to the outline. Section embeds and nested embeds are supported.
- Reading View is fully supported. Live Preview uses Obsidian's internal CodeMirror view to map an embed to its source line; if that is unavailable it falls back to the visible heading lines. The fallback can be less accurate in very long, virtualized notes.
- Heading links inside an embedded note still point at the original note's headings; the plugin does not rewrite links.
