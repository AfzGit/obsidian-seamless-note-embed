import type { App, EmbedCache, HeadingCache, MarkdownView } from "obsidian";
import { filterSection, getFileData, resolveEmbedData } from "./embedData";
import { findMatchingHeading, splitLinktext } from "./embedTargets";
import {
  headingLevelFromClasses,
  headingLevelFromTagName,
  headingLevelFromText,
  shiftHeadingLevel,
} from "./headingMath";
import { HeadingAtLine, nearestPrecedingHeadingLevel, parseHeadingLines } from "./headingSource";
import { OUTLINE_KEY_ATTRIBUTE, makeOutlineKey } from "./outlineKeys";

export const ORIGINAL_LEVEL_ATTRIBUTE = "data-aeih-original-level";
const SHIFT_ATTRIBUTE = "data-aeih-shift";

const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6";
const EMBED_SELECTOR = ".markdown-embed";
const EMBED_CONTENT_SELECTOR = ".markdown-embed-content";
const PREVIEW_ROOT_SELECTOR = ".markdown-preview-view";
const CM_ROOT_SELECTOR = ".cm-content";
const RENDERED_ROOT_SELECTOR = ".markdown-rendered";
const TRACKED_SELECTOR = `[${ORIGINAL_LEVEL_ATTRIBUTE}], [${SHIFT_ATTRIBUTE}]`;

export interface HeadingShiftSettings {
  enabled: boolean;
  livePreview: boolean;
}

interface CodeMirrorViewLike {
  posAtDOM(node: Node, offset?: number): number;
  state: {
    doc: {
      lineAt(position: number): { number: number; from?: number };
    };
  };
}

/**
 * The source-note context for one rendered heading scope.
 *
 * The root note's scope is untracked. Each embed creates a new scope with the
 * target note's metadata so rendered heading elements can be matched back to
 * their cache entries and given stable outline keys.
 */
interface HeadingScopeContext {
  isRoot: boolean;
  rootPath: string | null;
  sourcePath: string | null;
  embedPath: number[];
  headings: HeadingCache[] | null;
  cursor: { value: number };
  /**
   * Source heading positions for this scope. Reading View may virtualize the
   * heading above an embed out of the DOM, so this is used to compute the
   * embed's parent level from source instead of the visible DOM.
   */
  sourceHeadings?: HeadingAtLine[] | null;
  /** Resolvable note embeds in this scope, in source order. */
  noteEmbeds?: EmbedCache[] | null;
  /** Cursor for matching rendered nested embeds to their source entries. */
  embedCursor?: { value: number };
  /** Source line for top-level Reading View embeds, when the renderer exposes it. */
  embedLines?: Map<HTMLElement, number>;
}

interface LivePreviewEmbedInfo {
  level: number;
  /** Index in the note's metadata embed list, so keys match the outline. */
  index: number;
}

interface PreviewSectionLike {
  start?: { line?: number; col?: number; offset?: number } | null;
  level?: number;
  el?: HTMLElement | null;
}

interface PreviewRendererLike {
  sections?: PreviewSectionLike[];
}

function isElement(value: unknown): value is HTMLElement {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { nodeType?: number }).nodeType === 1
  );
}

function isMarkdownEmbed(element: HTMLElement): boolean {
  return element.classList.contains("markdown-embed");
}

/**
 * Walk ancestors and return the outermost element with the requested class.
 * An embedded note may contain its own `.markdown-preview-view` element, so
 * always processing the outermost one keeps the parent note as the root.
 */
function outermostWithClass(element: HTMLElement, className: string): HTMLElement | null {
  let current: HTMLElement | null = element;
  let outermost: HTMLElement | null = null;

  while (current) {
    if (current.classList.contains(className)) {
      outermost = current;
    }
    current = current.parentElement;
  }

  return outermost;
}

/**
 * Find the top-level rendered note that contains `element`. This is the
 * coordinate system used to decide how much an embed must be shifted.
 */
export function findRenderRoot(element: HTMLElement): HTMLElement | null {
  const preview = outermostWithClass(element, "markdown-preview-view");
  if (preview && !preview.closest(EMBED_CONTENT_SELECTOR)) {
    return preview;
  }

  const codeMirrorRoot = element.closest<HTMLElement>(CM_ROOT_SELECTOR);
  if (codeMirrorRoot && !codeMirrorRoot.closest(EMBED_CONTENT_SELECTOR)) {
    return codeMirrorRoot;
  }

  const rendered = outermostWithClass(element, "markdown-rendered");
  if (rendered && !rendered.closest(EMBED_CONTENT_SELECTOR)) {
    return rendered;
  }

  return null;
}

function directEmbedContent(embed: HTMLElement): HTMLElement | null {
  for (const child of Array.from(embed.children)) {
    if (isElement(child) && child.classList.contains("markdown-embed-content")) {
      return child;
    }
  }

  return null;
}

/**
 * Applies the heading shift to the rendered DOM. It never writes to the vault,
 * so embedded notes are left untouched on disk.
 */
export class EmbedHeadingProcessor {
  private readonly observers = new Map<HTMLElement, MutationObserver>();
  private readonly frames = new Map<HTMLElement, number>();
  private destroyed = false;

  constructor(
    private readonly app: App,
    private readonly getSettings: () => HeadingShiftSettings,
  ) {}

  schedule(root: HTMLElement): void {
    if (this.destroyed) {
      return;
    }

    if (!root.isConnected) {
      this.disconnectRoot(root);
      return;
    }

    this.ensureObserver(root);

    if (this.frames.has(root)) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      this.frames.delete(root);
      try {
        this.refresh(root);
      } catch (error) {
        console.error("Seamless Note Embed: failed to update a note", error);
      }
    });
    this.frames.set(root, frame);
  }

  refresh(root: HTMLElement): void {
    if (this.destroyed) {
      return;
    }

    if (!root.isConnected) {
      this.disconnectRoot(root);
      return;
    }

    const settings = this.getSettings();
    if (!settings.enabled) {
      this.restoreWithin(root);
      return;
    }

    if (root.classList.contains("cm-content")) {
      if (settings.livePreview) {
        this.processLivePreview(root);
      } else {
        this.restoreWithin(root);
      }
      return;
    }

    this.processReadingView(root);
  }

  refreshAll(): void {
    if (!this.getSettings().enabled) {
      this.restoreAll();
      return;
    }

    this.pruneDisconnectedRoots();
    const roots = new Set<HTMLElement>();

    for (const preview of Array.from(document.querySelectorAll<HTMLElement>(PREVIEW_ROOT_SELECTOR))) {
      const root = outermostWithClass(preview, "markdown-preview-view");
      if (root && !root.closest(EMBED_CONTENT_SELECTOR)) {
        roots.add(root);
      }
    }

    for (const root of Array.from(document.querySelectorAll<HTMLElement>(CM_ROOT_SELECTOR))) {
      if (!root.closest(EMBED_CONTENT_SELECTOR)) {
        roots.add(root);
      }
    }

    // Some views (for example canvas cards) render markdown without either of
    // the usual roots. They are still safe to process as long as they are not
    // the contents of another embed.
    for (const rendered of Array.from(document.querySelectorAll<HTMLElement>(RENDERED_ROOT_SELECTOR))) {
      if (
        rendered.closest(EMBED_CONTENT_SELECTOR) ||
        rendered.closest(PREVIEW_ROOT_SELECTOR) ||
        rendered.closest(CM_ROOT_SELECTOR)
      ) {
        continue;
      }

      const root = outermostWithClass(rendered, "markdown-rendered");
      if (root) {
        roots.add(root);
      }
    }

    // Include roots in popout windows and other documents that the main
    // document query above cannot see. Every scheduled root is observed, so
    // this is also a convenient registry of already-active notes.
    for (const root of this.observers.keys()) {
      if (root.isConnected) {
        roots.add(root);
      }
    }

    for (const root of roots) {
      this.schedule(root);
    }
  }

  /**
   * Refresh only the editor that currently has focus. `editor-change` fires
   * often, so avoid walking every open note on each keystroke.
   */
  refreshActiveEditor(): void {
    const leaf = this.app.workspace.getMostRecentLeaf?.();
    const view = leaf?.view;
    if (!view || view.getViewType() !== "markdown") {
      return;
    }

    const root = view.containerEl.querySelector<HTMLElement>(CM_ROOT_SELECTOR);
    if (root) {
      this.schedule(root);
    }
  }

  restoreAll(): void {
    for (const root of this.observers.keys()) {
      this.restoreWithin(root);
    }
    this.restoreWithin(document.body);
  }

  destroy(): void {
    this.destroyed = true;

    for (const frame of this.frames.values()) {
      window.cancelAnimationFrame(frame);
    }
    this.frames.clear();

    for (const observer of this.observers.values()) {
      observer.disconnect();
    }
    this.observers.clear();
  }

  private processReadingView(root: HTMLElement): void {
    const view = this.findMarkdownView(root);
    const rootFile = view?.file;
    const rootPath = rootFile?.path ?? null;
    const fileData = rootFile ? getFileData(this.app, rootFile) : null;

    this.processScope(root, 0, {
      isRoot: true,
      rootPath,
      sourcePath: rootPath,
      embedPath: [],
      headings: null,
      cursor: { value: 0 },
      sourceHeadings: this.getReadingViewSourceHeadings(view),
      noteEmbeds: fileData
        ? this.getNoteEmbeds(fileData.path, fileData.embeds)
        : [],
      embedCursor: { value: 0 },
      embedLines: this.getReadingViewEmbedLines(root, view),
    });
  }

  /**
   * Process one heading scope. `parentLevel` is the absolute heading level of
   * the embed's parent heading. Headings found in this scope are shifted by
   * that amount, and any embeds nested inside this scope inherit the last
   * shifted heading level seen.
   */
  private processScope(
    scope: ParentNode,
    parentLevel: number,
    context: HeadingScopeContext,
  ): void {
    let currentLevel = parentLevel;
    let embedIndex = 0;

    const visit = (node: HTMLElement): void => {
      if (isMarkdownEmbed(node)) {
        const counted = this.processEmbed(
          node,
          currentLevel,
          parentLevel,
          context,
          embedIndex,
        );
        if (counted) {
          embedIndex += 1;
        }
        return;
      }

      const tagLevel = headingLevelFromTagName(node.tagName);
      if (tagLevel !== null) {
        const storedLevel = this.readStoredLevel(node);
        const originalLevel = storedLevel ?? tagLevel;
        let container = node;

        if (context.isRoot) {
          // The parent note's own headings are never shifted. If this heading
          // was shifted previously (for example, an embed moved out from under
          // a heading), put it back now.
          if (storedLevel !== null) {
            container = this.restoreHeading(node);
          }
          currentLevel = originalLevel;
        } else {
          // Embedded headings are tracked even when the shift is zero, because
          // they still need an outline key.
          if (storedLevel === null) {
            node.setAttribute(ORIGINAL_LEVEL_ATTRIBUTE, String(originalLevel));
          }

          const effectiveLevel = shiftHeadingLevel(originalLevel, parentLevel);
          container = this.applyHeadingLevel(node, effectiveLevel, originalLevel);
          currentLevel = effectiveLevel;
          this.assignOutlineKey(container, originalLevel, context);
        }

        // An embed can be part of a heading's rendered content. Visiting the
        // heading's children keeps the DOM's embed indices aligned with the
        // metadata-based outline (which counts such embeds under the heading).
        for (const child of Array.from(container.children)) {
          if (isElement(child)) {
            visit(child);
          }
        }
        return;
      }

      for (const child of Array.from(node.children)) {
        if (isElement(child)) {
          visit(child);
        }
      }
    };

    for (const child of Array.from(scope.children)) {
      if (isElement(child)) {
        visit(child);
      }
    }
  }

  private processEmbed(
    embed: HTMLElement,
    parentLevel: number,
    scopeParentLevel: number,
    parentContext: HeadingScopeContext,
    embedIndex: number,
  ): boolean {
    let sourcePath = parentContext.sourcePath;
    let headings: HeadingCache[] | null = null;
    let noteEmbeds: EmbedCache[] = [];
    let counted = false;
    const src = embed.getAttribute("src");

    if (src && sourcePath && this.app.metadataCache) {
      try {
        const resolved = resolveEmbedData(this.app, src, sourcePath);
        if (resolved) {
          // Only note embeds occupy an index in the outline's embed path.
          // Media embeds are not `.markdown-embed` elements, and unresolved
          // links are skipped by the outline builder as well.
          counted = true;
          const section = filterSection(resolved.data, resolved.subpath);
          sourcePath = resolved.data.path;
          headings = section ? section.headings : [];
          noteEmbeds = section
            ? this.getNoteEmbeds(sourcePath, section.embeds)
            : [];
        }
      } catch (error) {
        console.error(
          "Seamless Note Embed: failed to resolve an embedded note",
          error,
        );
      }
    }

    // Reading View virtualizes off-screen sections, so the heading above an
    // embed may not be in the DOM. Prefer the source position for note embeds;
    // the visible DOM remains the fallback for canvas cards and tests. Do not
    // consume a source embed slot for media or unresolved links.
    const sourceLine = counted
      ? this.resolveEmbedSourceLine(embed, parentContext, embedIndex)
      : null;
    const sourceParentLevel =
      sourceLine !== null && parentContext.sourceHeadings
        ? shiftHeadingLevel(
            nearestPrecedingHeadingLevel(parentContext.sourceHeadings, sourceLine),
            scopeParentLevel,
          )
        : null;
    const effectiveParentLevel = sourceParentLevel ?? parentLevel;
    embed.setAttribute(SHIFT_ATTRIBUTE, String(effectiveParentLevel));

    const content = directEmbedContent(embed) ?? embed;
    this.processScope(content, effectiveParentLevel, {
      isRoot: false,
      rootPath: parentContext.rootPath,
      sourcePath,
      embedPath: [...parentContext.embedPath, embedIndex],
      headings,
      cursor: { value: 0 },
      sourceHeadings: headings
        ? headings.map((heading) => ({
            line: heading.position.start.line,
            level: heading.level,
          }))
        : null,
      noteEmbeds,
      embedCursor: { value: 0 },
    });

    return counted;
  }

  /**
   * Read source heading positions from the Reading View renderer. Obsidian
   * keeps a section list for the whole note even when only part of it is in
   * the DOM, which is exactly what is needed for a virtualized parent heading.
   */
  private getReadingViewSourceHeadings(
    view: MarkdownView | null,
  ): HeadingAtLine[] | null {
    const renderer = this.getPreviewRenderer(view);
    const sections = renderer?.sections;
    if (Array.isArray(sections)) {
      const headings: HeadingAtLine[] = [];
      for (const section of sections) {
        const line = section.start?.line;
        const level = section.level;
        if (
          typeof line === "number" &&
          typeof level === "number" &&
          level >= 1 &&
          level <= 6
        ) {
          headings.push({ line, level });
        }
      }

      if (headings.length > 0) {
        return headings.sort((left, right) => left.line - right.line);
      }
    }

    const file = view?.file;
    if (!file) {
      return null;
    }

    const data = getFileData(this.app, file);
    return data
      ? data.headings.map((heading) => ({
          line: heading.position.start.line,
          level: heading.level,
        }))
      : null;
  }

  /**
   * Map each rendered top-level embed to its source line. The renderer keeps
   * section elements for virtualized content, so this works even when the
   * embed's parent heading is not currently mounted.
   */
  private getReadingViewEmbedLines(
    root: HTMLElement,
    view: MarkdownView | null,
  ): Map<HTMLElement, number> {
    const lines = new Map<HTMLElement, number>();
    const renderer = this.getPreviewRenderer(view);
    const sections = renderer?.sections;
    if (!Array.isArray(sections) || sections.length === 0) {
      return lines;
    }

    const sectionByElement = new Map<HTMLElement, PreviewSectionLike>();
    for (const section of sections) {
      if (section.el) {
        sectionByElement.set(section.el, section);
      }
    }

    for (const embed of Array.from(root.querySelectorAll<HTMLElement>(EMBED_SELECTOR))) {
      if (embed.closest(EMBED_CONTENT_SELECTOR)) {
        continue;
      }

      let current: HTMLElement | null = embed;
      while (current && current !== root) {
        const section = sectionByElement.get(current);
        const line = section?.start?.line;
        if (typeof line === "number") {
          lines.set(embed, line);
          break;
        }
        current = current.parentElement;
      }
    }

    return lines;
  }

  private getPreviewRenderer(view: MarkdownView | null): PreviewRendererLike | null {
    if (!view) {
      return null;
    }

    try {
      const previewMode = view.previewMode as unknown as
        | { renderer?: unknown }
        | undefined;
      const renderer = previewMode?.renderer;
      return typeof renderer === "object" && renderer !== null
        ? renderer
        : null;
    } catch {
      return null;
    }
  }

  /** Resolvable note embeds in source order, matching outline indices. */
  private getNoteEmbeds(
    sourcePath: string | null,
    embeds: readonly EmbedCache[],
  ): EmbedCache[] {
    if (!sourcePath) {
      return [];
    }

    const noteEmbeds: EmbedCache[] = [];
    for (const embed of embeds) {
      try {
        if (resolveEmbedData(this.app, embed.link, sourcePath)) {
          noteEmbeds.push(embed);
        }
      } catch {
        // A temporarily unresolved embed is not part of the rendered note
        // embed sequence.
      }
    }

    return noteEmbeds.sort(
      (left, right) =>
        left.position.start.line - right.position.start.line ||
        left.position.start.col - right.position.start.col,
    );
  }

  /**
   * Find the source line of a rendered embed. Top-level Reading View embeds
   * come from the renderer's section list. Nested embeds are matched against
   * their containing note's source embeds by link, with a cursor so duplicate
   * links keep their order when earlier embeds are virtualized away.
   */
  private resolveEmbedSourceLine(
    embed: HTMLElement,
    context: HeadingScopeContext,
    embedIndex: number,
  ): number | null {
    const explicit = context.embedLines?.get(embed);
    if (typeof explicit === "number") {
      return explicit;
    }

    const noteEmbeds = context.noteEmbeds;
    if (!noteEmbeds || noteEmbeds.length === 0) {
      return null;
    }

    const cursor = context.embedCursor ?? { value: 0 };
    const start = Math.max(0, cursor.value);
    const src = embed.getAttribute("src");

    if (src) {
      for (let index = start; index < noteEmbeds.length; index++) {
        if (this.embedLinkMatches(noteEmbeds[index].link, src, context.sourcePath)) {
          cursor.value = index + 1;
          return noteEmbeds[index].position.start.line;
        }
      }
    }

    const fallback =
      embedIndex >= 0 && embedIndex < noteEmbeds.length ? embedIndex : start;
    if (fallback >= 0 && fallback < noteEmbeds.length) {
      cursor.value = fallback + 1;
      return noteEmbeds[fallback].position.start.line;
    }

    return null;
  }

  private embedLinkMatches(
    cachedLink: string,
    renderedLink: string,
    sourcePath: string | null,
  ): boolean {
    if (cachedLink === renderedLink) {
      return true;
    }

    try {
      const cached = splitLinktext(cachedLink);
      const rendered = splitLinktext(renderedLink);
      if (cached.subpath !== rendered.subpath) {
        return false;
      }

      if (
        cached.path === rendered.path ||
        cached.path.replace(/\.md$/i, "") === rendered.path.replace(/\.md$/i, "")
      ) {
        return true;
      }

      if (!sourcePath || !this.app.metadataCache) {
        return false;
      }

      const cachedFile = this.app.metadataCache.getFirstLinkpathDest(
        cached.path,
        sourcePath,
      );
      const renderedFile = this.app.metadataCache.getFirstLinkpathDest(
        rendered.path,
        sourcePath,
      );
      return !!cachedFile && cachedFile === renderedFile;
    } catch {
      return false;
    }
  }

  private assignOutlineKey(
    heading: HTMLElement,
    originalLevel: number,
    context: HeadingScopeContext,
  ): void {
    if (
      context.isRoot ||
      !context.rootPath ||
      !context.sourcePath ||
      !context.headings ||
      context.headings.length === 0
    ) {
      heading.removeAttribute(OUTLINE_KEY_ATTRIBUTE);
      return;
    }

    const text = heading.getAttribute("data-heading") ?? heading.textContent ?? "";
    const match = findMatchingHeading(
      context.headings,
      context.cursor.value,
      text,
      originalLevel,
    );

    if (!match) {
      heading.removeAttribute(OUTLINE_KEY_ATTRIBUTE);
      return;
    }

    heading.setAttribute(
      OUTLINE_KEY_ATTRIBUTE,
      makeOutlineKey({
        rootPath: context.rootPath,
        embedPath: context.embedPath,
        targetPath: context.sourcePath,
        targetLine: match.heading.position.start.line,
      }),
    );
    context.cursor.value = match.index + 1;
  }

  private processLivePreview(root: HTMLElement): void {
    const embedInfo = this.getLivePreviewEmbedInfo(root);
    const view = this.findMarkdownView(root);
    const rootPath = view?.file?.path ?? null;
    const context: HeadingScopeContext = {
      isRoot: true,
      rootPath,
      sourcePath: rootPath,
      embedPath: [],
      headings: null,
      cursor: { value: 0 },
    };

    let currentLevel = 0;
    let fallbackEmbedIndex = -1;

    const visit = (node: HTMLElement): void => {
      if (isMarkdownEmbed(node)) {
        const info = embedInfo.get(node);
        let index = info?.index;
        if (index === undefined) {
          index = fallbackEmbedIndex;
          fallbackEmbedIndex -= 1;
        }
        const level = info?.level ?? currentLevel;
        this.processEmbed(node, level, level, context, index);
        return;
      }

      let lineLevel = headingLevelFromClasses(Array.from(node.classList));
      if (
        lineLevel === null &&
        node.classList.contains("cm-line") &&
        !node.classList.contains("HyperMD-codeblock")
      ) {
        lineLevel = headingLevelFromText(node.textContent ?? "");
      }

      if (lineLevel !== null) {
        currentLevel = lineLevel;
      } else {
        const tagLevel = headingLevelFromTagName(node.tagName);
        if (tagLevel !== null) {
          currentLevel = tagLevel;
        }
      }

      for (const child of Array.from(node.children)) {
        if (isElement(child)) {
          visit(child);
        }
      }
    };

    for (const child of Array.from(root.children)) {
      if (isElement(child)) {
        visit(child);
      }
    }
  }

  /**
   * In Live Preview the outer headings are CodeMirror lines, not `<h1>` tags,
   * and CodeMirror virtualizes long notes. Read heading positions from the
   * editor's current source instead, then map each rendered embed back to its
   * source line. The returned index comes from the note's metadata cache, so it
   * still matches the outline when earlier embeds are scrolled out of view.
   */
  private getLivePreviewEmbedInfo(root: HTMLElement): Map<HTMLElement, LivePreviewEmbedInfo> {
    const info = new Map<HTMLElement, LivePreviewEmbedInfo>();
    const view = this.findMarkdownView(root);
    if (!view) {
      return info;
    }

    const editorView = (view.editor as unknown as { cm?: CodeMirrorViewLike }).cm;
    if (!editorView) {
      return info;
    }

    let headings: HeadingAtLine[];
    try {
      headings = parseHeadingLines(view.editor.getValue().split(/\r?\n/));
    } catch {
      return info;
    }

    let rootEmbeds: Array<{ line: number; col: number }> = [];
    const rootFile = view.file;
    if (rootFile && this.app.metadataCache) {
      try {
        const fileData = getFileData(this.app, rootFile);
        if (fileData) {
          const noteEmbeds: EmbedCache[] = [];

          for (const embed of fileData.embeds) {
            try {
              // Media embeds do not render as `.markdown-embed`, so they must
              // not occupy an index in the outline's embed path.
              if (!resolveEmbedData(this.app, embed.link, rootFile.path)) {
                continue;
              }
            } catch {
              continue;
            }

            noteEmbeds.push(embed);
          }

          rootEmbeds = noteEmbeds
            .sort(
              (left, right) =>
                left.position.start.line - right.position.start.line ||
                left.position.start.col - right.position.start.col,
            )
            .map((embed) => ({
              line: embed.position.start.line,
              col: embed.position.start.col,
            }));
        }
      } catch {
        rootEmbeds = [];
      }
    }

    let fallbackIndex = -1;

    for (const embed of Array.from(root.querySelectorAll<HTMLElement>(EMBED_SELECTOR))) {
      if (embed.closest(EMBED_CONTENT_SELECTOR)) {
        continue;
      }

      try {
        const offset = editorView.posAtDOM(embed);
        const lineInfo = editorView.state.doc.lineAt(offset);
        const line = lineInfo.number - 1;
        const col =
          typeof lineInfo.from === "number" ? offset - lineInfo.from : null;

        let index = -1;
        let bestDistance = Number.POSITIVE_INFINITY;

        for (let candidateIndex = 0; candidateIndex < rootEmbeds.length; candidateIndex++) {
          const candidate = rootEmbeds[candidateIndex];
          if (candidate.line !== line) {
            continue;
          }

          const distance =
            col === null ? 0 : Math.abs(candidate.col - col);
          if (distance < bestDistance) {
            bestDistance = distance;
            index = candidateIndex;
          }
        }

        if (index === -1) {
          index = fallbackIndex;
          fallbackIndex -= 1;
        }

        info.set(embed, {
          level: nearestPrecedingHeadingLevel(headings, line),
          index,
        });
      } catch {
        // A widget may not have a DOM position while it is being recycled.
        // The caller falls back to the nearest visible heading line.
      }
    }

    return info;
  }

  private findMarkdownView(element: HTMLElement): MarkdownView | null {
    let match: MarkdownView | null = null;

    this.app.workspace.iterateAllLeaves((leaf) => {
      if (match) {
        return;
      }

      if (leaf.view.getViewType() === "markdown" && leaf.view.containerEl.contains(element)) {
        match = leaf.view as MarkdownView;
      }
    });

    return match;
  }

  private readStoredLevel(heading: HTMLElement): number | null {
    const stored = heading.getAttribute(ORIGINAL_LEVEL_ATTRIBUTE);
    if (stored === null) {
      return null;
    }

    const parsed = Number.parseInt(stored, 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 6) {
      return parsed;
    }

    heading.removeAttribute(ORIGINAL_LEVEL_ATTRIBUTE);
    return null;
  }

  private applyHeadingLevel(
    heading: HTMLElement,
    level: number,
    originalLevel: number,
  ): HTMLElement {
    const replacement = this.replaceHeading(heading, level);
    replacement.setAttribute(SHIFT_ATTRIBUTE, String(level - originalLevel));
    return replacement;
  }

  /**
   * Changing an element's tag requires creating a new element. All attributes
   * and children (and therefore any event listeners attached to children) are
   * preserved.
   */
  private replaceHeading(heading: HTMLElement, level: number): HTMLElement {
    if (headingLevelFromTagName(heading.tagName) === level) {
      return heading;
    }

    const win = heading.ownerDocument.win as Window & {
      createEl: (tag: string) => HTMLElement;
    };
    const replacement = win.createEl(`h${level}`);

    for (const attribute of Array.from(heading.attributes)) {
      if (attribute.namespaceURI) {
        replacement.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
      } else {
        replacement.setAttribute(attribute.name, attribute.value);
      }
    }

    while (heading.firstChild) {
      replacement.appendChild(heading.firstChild);
    }

    heading.replaceWith(replacement);
    return replacement;
  }

  private restoreWithin(root: HTMLElement): void {
    const elements: HTMLElement[] = [];

    if (root.matches(TRACKED_SELECTOR)) {
      elements.push(root);
    }
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(TRACKED_SELECTOR))) {
      elements.push(element);
    }

    for (const element of elements) {
      if (element.hasAttribute(ORIGINAL_LEVEL_ATTRIBUTE)) {
        this.restoreHeading(element);
      } else {
        element.removeAttribute(SHIFT_ATTRIBUTE);
        element.removeAttribute(OUTLINE_KEY_ATTRIBUTE);
      }
    }
  }

  private restoreHeading(heading: HTMLElement): HTMLElement {
    const stored = heading.getAttribute(ORIGINAL_LEVEL_ATTRIBUTE);
    const original = stored === null ? Number.NaN : Number.parseInt(stored, 10);

    const restored =
      Number.isInteger(original) && original >= 1 && original <= 6
        ? this.replaceHeading(heading, original)
        : heading;

    restored.removeAttribute(ORIGINAL_LEVEL_ATTRIBUTE);
    restored.removeAttribute(SHIFT_ATTRIBUTE);
    restored.removeAttribute(OUTLINE_KEY_ATTRIBUTE);
    return restored;
  }

  private ensureObserver(root: HTMLElement): void {
    if (this.observers.has(root)) {
      return;
    }

    const observer = new MutationObserver((records) => {
      if (!root.isConnected) {
        this.disconnectRoot(root);
        return;
      }

      if (records.some((record) => this.isRelevantMutation(record))) {
        this.schedule(root);
      }
    });

    observer.observe(root, { childList: true, subtree: true });
    this.observers.set(root, observer);
  }

  private isRelevantMutation(record: MutationRecord): boolean {
    if (record.type !== "childList") {
      return false;
    }

    const containsRelevantElement = (node: Node): boolean => {
      if (!isElement(node)) {
        return false;
      }

      if (
        node.matches(HEADING_SELECTOR) ||
        node.matches(EMBED_SELECTOR) ||
        node.matches(EMBED_CONTENT_SELECTOR)
      ) {
        return true;
      }

      return !!node.querySelector(
        `${HEADING_SELECTOR}, ${EMBED_SELECTOR}, ${EMBED_CONTENT_SELECTOR}`,
      );
    };

    // Removals matter too: deleting an embed changes the source indices of the
    // embeds after it, which are part of their outline keys.
    for (const node of Array.from(record.addedNodes)) {
      if (containsRelevantElement(node)) {
        return true;
      }
    }
    for (const node of Array.from(record.removedNodes)) {
      if (containsRelevantElement(node)) {
        return true;
      }
    }

    return false;
  }

  private disconnectRoot(root: HTMLElement): void {
    const observer = this.observers.get(root);
    if (observer) {
      observer.disconnect();
      this.observers.delete(root);
    }

    const frame = this.frames.get(root);
    if (frame !== undefined) {
      window.cancelAnimationFrame(frame);
      this.frames.delete(root);
    }
  }

  private pruneDisconnectedRoots(): void {
    for (const [root, observer] of Array.from(this.observers.entries())) {
      if (root.isConnected) {
        continue;
      }

      observer.disconnect();
      this.observers.delete(root);

      const frame = this.frames.get(root);
      if (frame !== undefined) {
        window.cancelAnimationFrame(frame);
        this.frames.delete(root);
      }
    }
  }
}
