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
└── manifest.json
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

- **Enable heading level shifting** — turns the plugin on or off.
- **Apply in Live Preview** — also shift embeds while editing. Reading View is always supported while the plugin is enabled.
- **Refresh now** — re-apply shifts to every open note.

There is also a command, **Refresh embedded heading levels**, in the command palette.

## How it works

1. After Obsidian renders a note (or an embed), the plugin finds the top-level rendered note that contains it.
2. It walks the rendered document in order, tracking the nearest heading level.
3. When it reaches an embed, it renames the rendered `<h1>`–`<h6>` elements inside that embed to their shifted levels.
4. The original heading level is remembered in a DOM attribute so repeated renders are idempotent. The plugin restores the original levels when it is disabled or unloaded.

In Live Preview, the parent note's headings are CodeMirror lines rather than `<h1>` tags, and long notes are virtualized. The plugin therefore reads heading positions from the editor's current source to determine the shift for each embed.

**No vault files are written to.** Only the rendered DOM is changed.

## Limitations

- Heading levels are clamped at `h6`; HTML has no `h7`.
- Obsidian's built-in **Outline** pane is built from the current file's metadata, which does not include embeds. This plugin changes the rendered heading hierarchy; outline/TOC tools that read the rendered document will see the shifted levels.
- Reading View is fully supported. Live Preview uses Obsidian's internal CodeMirror view to map an embed to its source line; if that is unavailable it falls back to the visible heading lines. The fallback can be less accurate in very long, virtualized notes.
- Heading links inside an embedded note still point at the original note's headings; the plugin does not rewrite links.
