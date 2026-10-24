# Development, testing, and release

This document covers the local workflow and the Obsidian community-plugin requirements. For the runtime design, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Prerequisites

- Node.js **20.19+**, **22.13+**, or **24+** (the lint stack requires it; CI tests the latest Node 20, 22, and 24).
- npm.
- Obsidian for manual verification.

The repository intentionally does not commit `main.js`. Build it locally or download it from a release.

## Setup

```bash
npm ci
npm run check
npm run lint
npm test
npm run build
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | esbuild watch mode; writes `main.js` on change. |
| `npm run check` | TypeScript type check with `strict` enabled. |
| `npm run lint` | Official Obsidian plugin lint rules plus type-aware ESLint. |
| `npm test` | Bundles test entry points with esbuild and runs Node's test runner with jsdom. |
| `npm run build` | Type check and production bundle. |
| `npm version patch\|minor\|major` | Bumps `package.json`, `manifest.json`, and `versions.json`, then stages the manifests. |

## Code conventions

- TypeScript strict mode is enabled. Do not add `any` unless it is unavoidable at an internal API boundary; prefer `unknown` plus a narrow cast.
- The code style is 2 spaces, double quotes, semicolons, LF line endings, and UTF-8. `.editorconfig` records the whitespace and encoding rules.
- Keep source modules free of runtime Obsidian imports where the code is pure and testable. `embedTargets.ts`, `headingMath.ts`, `headingSource.ts`, and `outlineHeadings.ts` are deliberately runtime-import-free.
- New behavior should come with a test in `tests/`, especially around embeds, outline keys, or navigation.

## Why TypeScript 5.9 instead of 7

`eslint-plugin-obsidianmd` depends on `@typescript-eslint/typescript-estree` and `ts-api-utils`. With TypeScript 7 installed, `ts-api-utils` crashes while loading:

```text
TypeError: Cannot read properties of undefined (reading 'Intrinsic')
```

The project therefore pins `typescript` to `^5.9.3`. Revisit this only after the lint stack supports TypeScript 7.

## Lint configuration

`eslint.config.mjs` uses the official recommended configuration:

```js
import obsidianmd from "eslint-plugin-obsidianmd";
```

It ignores `node_modules`, `main.js`, build configs, tests, docs, `package-lock.json`, `versions.json`, and `tsconfig.json`, matching what the community scanner ignores. The source tree itself must stay clean.

Important details:

- The recommended config enables type-aware rules, so `parserOptions.projectService` is required.
- `eslint-comments/no-restricted-disable` forbids disabling `obsidianmd/*` rules. Fix the code instead of suppressing an Obsidian rule.
- `@typescript-eslint/no-this-alias` is disabled only for the two monkey-patching modules, where a wrapper needs both its original dynamic `this` and the integration instance. The disable/enable pair has a written reason.
- `obsidianmd/prefer-setting-definitions` is satisfied by implementing `getSettingDefinitions()` in `settings.ts` while keeping `display()` for Obsidian < 1.13.
- `obsidianmd/prefer-create-el` is satisfied by using `heading.ownerDocument.win.createEl(...)` in the processor. The jsdom tests polyfill `document.win` and `window.createEl`.

## Obsidian community plugin check

The community directory runs automated checks and a manual review. The local lint is deliberately stricter than the scanner, so a clean `npm run lint` is a good signal but not a guarantee of acceptance.

What the scanner cares about most:

- **Errors** are security and correctness rules such as `no-eval`, `no-implied-eval`, `no-unsanitized/method`, `no-unsanitized/property`, `obsidianmd/regex-lookbehind`, and `obsidianmd/no-forbidden-elements`.
- Most style, API-usage, and best-practice findings are **warnings**.
- It ignores tests, build configuration, `main.js`, `docs`, and localization/build-output directories.
- It scans `manifest.json`, source files, and `styles.css`.

Submission checklist:

1. `manifest.json` is at the repository root with `id`, `name`, `version`, `minAppVersion`, `description`, `author`, and `isDesktopOnly`.
2. `README.md` and `LICENSE` are at the repository root.
3. `versions.json` maps every released version to its `minAppVersion`.
4. The description is 250 characters or fewer, ends with a period, and does not start with "This is a plugin".
5. `fundingUrl` is present only if you accept donations.
6. `isDesktopOnly` is `false` because this plugin uses only browser/Obsidian APIs, not Node.js or Electron APIs.
7. Command IDs do not repeat the plugin ID. The command IDs are `toggle-plugin`, `toggle-heading-increments`, and `refresh-embedded-heading-levels`; Obsidian prefixes them with the plugin ID automatically.
8. No sample code remains.
9. No telemetry, network requests, dynamic ads, obfuscation, self-updating, or note/source-file writes. The plugin only saves its own settings to `data.json`.
10. A GitHub release exists with `main.js`, `manifest.json`, and optional `styles.css` as assets.
11. The release tag matches the manifest version exactly. `.npmrc` sets `tag-version-prefix=""` so `npm version` does not create a `v` prefix.
12. The plugin ID and display name are stable. The folder ID `auto-incremented-embed-headings` is intentionally kept even though the display name is **Seamless Note Embed**, because changing it would break existing installations and settings.

The initial submission is made through [community.obsidian.md](https://community.obsidian.md). After the plugin is accepted, users download later releases directly from GitHub.

## Release workflow

The GitHub Actions workflow in `.github/workflows/release.yml` runs when a tag is pushed:

1. Check out the tag.
2. `npm ci`.
3. `npm run build` (which type-checks first).
4. Attest build provenance for `main.js` and `styles.css`.
5. Create a **draft** GitHub release with `main.js`, `manifest.json`, and `styles.css`.

Typical release:

```bash
npm version minor
git push
git push --tags
```

Then open the draft release on GitHub, verify the assets, and publish it. The tag and `manifest.json` version must match.

The CI workflow in `.github/workflows/lint.yml` runs `npm ci`, `npm run lint`, `npm test`, and `npm run build` on Node 20, 22, and 24 for every push and pull request.

## Manual verification in Obsidian

1. Build with `npm run build`.
2. Copy `main.js`, `manifest.json`, and `styles.css` to:
   ```text
   <vault>/.obsidian/plugins/auto-incremented-embed-headings/
   ```
3. Enable **Seamless Note Embed** in **Settings → Community plugins**.
4. Reload the app after changing `main.js` (`Ctrl+P` → **Reload app without saving**), or toggle the plugin off and on.

Useful console checks:

```js
// The plugin instance and settings.
app.plugins.plugins["auto-incremented-embed-headings"].settings

// The virtual headings exposed to other plugins.
app.metadataCache.getFileCache(app.workspace.getActiveFile()).headings

// Rendered shifted headings.
document.querySelectorAll("[data-aeih-original-level]")

// Rendered outline keys.
document.querySelectorAll("[data-aeih-outline-key]")
```

All plugin errors are logged with the prefix `Seamless Note Embed:`.

Test at least:

- Reading View and Live Preview.
- An embed under a heading, an embed with no preceding heading, and a nested embed.
- A section embed (`![[note#Heading]]`) and a block embed (`![[note#^block]]`).
- A note containing an image/PDF embed before a note embed, to confirm media embeds do not consume outline indices.
- The built-in Outline, Quiet Outline, and Subtle TOC.
- A link to an embedded heading and Another Quick Switcher's header search.
- Hover previews with appearance settings enabled.
- PDF export with appearance settings enabled.
- Disabling the plugin: headings must return to their original levels and appearance classes must be removed.

## Common pitfalls

### Reading the wrapped metadata cache

Never call `app.metadataCache.getFileCache()` from this plugin's internals. Use `getRawFileCache()` from `rawMetadata.ts`. Reading the wrapped method would make an embedded heading look like a real heading in the parent note and double-count it.

### Scheduling scrolls from passive lookups

`Editor.posToOffset` and CodeMirror `Text.line` are used for active-heading tracking and hit-testing. Do not schedule scrolling from them. Doing so makes Subtle TOC and similar plugins fight over the viewport. Only explicit navigation APIs (`offsetToPos`, `setCursor`, `setSelection`, `scrollIntoView`, `setEphemeralState`, `applyScroll`) should schedule a scroll.

### Cloning real headings

The core Outline compares some headings by identity. Keep real `HeadingCache` objects unchanged when building the combined list; only synthetic embedded headings may be new objects.

### Counting media embeds

Only resolved note embeds occupy an index in the embed path. Images, PDFs, missing notes, and block embeds must not increment the index, or outline keys for later note embeds will be wrong.

### Restoring prototype methods

Some Obsidian methods live on prototypes. Record whether the property was an own property before patching. On restore, delete an own property that the plugin added; do not overwrite the prototype with a stale bound function.

### Multiple wrappers

If another plugin wraps a method after this plugin, leave the newer wrapper in place. `restoreAll()` checks that the current value is still this plugin's wrapper before restoring. The metadata wrapper has a similar check and keeps its raw getter registered if another wrapper is on top.

### Settings drift

`display()` and `getSettingDefinitions()` share the same row definitions. When adding a setting, update the `PluginSettings` interface, `DEFAULT_SETTINGS`, and the row list. The declarative path is used on Obsidian 1.13+; the imperative path is used on older versions.

### Hover previews

Appearance selectors are scoped to `.markdown-reading-view` and `.markdown-source-view`. Do not broaden them to `.markdown-preview-view` globally, or hover previews will lose their indentation, filename, scrollbar, and other styling.

### PDF export

Obsidian's print window receives inline custom properties from the body but not arbitrary body classes. Keep the `--aeih-print-*` flags and the `body[style*="--aeih-print-...:"] .print` selectors in `styles.css` in sync with `APPEARANCE_OPTIONS` in `main.ts`.

### jsdom tests

The processor uses `ownerDocument.win.createEl`. jsdom does not define Obsidian's `Document.win` or `window.createEl`, so each test file that imports the processor must set:

```js
dom.window.document.win = dom.window;
dom.window.createEl = (tag) => dom.window.document.createElement(tag);
```

### Future Obsidian changes

The fragile internal APIs are listed in [ARCHITECTURE.md](ARCHITECTURE.md#fragile-obsidian-internals). Keep the defensive `typeof` checks and `try/catch` blocks when touching those areas. A missing internal API should disable only that integration, not break heading shifting.
