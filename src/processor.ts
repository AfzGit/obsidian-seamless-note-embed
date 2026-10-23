import type { App, MarkdownView } from "obsidian";
import {
  headingLevelFromClasses,
  headingLevelFromTagName,
  headingLevelFromText,
  shiftHeadingLevel,
} from "./headingMath";
import { HeadingAtLine, nearestPrecedingHeadingLevel, parseHeadingLines } from "./headingSource";

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
      lineAt(position: number): { number: number };
    };
  };
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
  if (codeMirrorRoot) {
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
        console.error("Auto-Incremented Embed Headings: failed to update a note", error);
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
    const leaf = this.app.workspace.activeLeaf;
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
    this.processScope(root, 0);
  }

  /**
   * Process one heading scope. `parentLevel` is the absolute heading level of
   * the embed's parent heading. Headings found in this scope are shifted by
   * that amount, and any embeds nested inside this scope inherit the last
   * shifted heading level seen.
   */
  private processScope(scope: ParentNode, parentLevel: number): void {
    let currentLevel = parentLevel;

    const visit = (node: HTMLElement): void => {
      if (isMarkdownEmbed(node)) {
        this.processEmbed(node, currentLevel);
        return;
      }

      const tagLevel = headingLevelFromTagName(node.tagName);
      if (tagLevel !== null) {
        const storedLevel = this.readStoredLevel(node);
        const originalLevel = storedLevel ?? tagLevel;

        if (parentLevel === 0) {
          // The parent note's own headings, and embeds before any heading,
          // should not be modified. If this heading was shifted previously,
          // put it back now.
          if (storedLevel !== null) {
            this.restoreHeading(node);
          }
          currentLevel = originalLevel;
        } else {
          if (storedLevel === null) {
            node.setAttribute(ORIGINAL_LEVEL_ATTRIBUTE, String(originalLevel));
          }

          const effectiveLevel = shiftHeadingLevel(originalLevel, parentLevel);
          this.applyHeadingLevel(node, effectiveLevel, originalLevel);
          currentLevel = effectiveLevel;
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

  private processEmbed(embed: HTMLElement, parentLevel: number): void {
    embed.setAttribute(SHIFT_ATTRIBUTE, String(parentLevel));

    const content = directEmbedContent(embed) ?? embed;
    this.processScope(content, parentLevel);
  }

  private processLivePreview(root: HTMLElement): void {
    const editorShifts = this.getLivePreviewShifts(root);
    let currentLevel = 0;

    const visit = (node: HTMLElement): void => {
      if (isMarkdownEmbed(node)) {
        this.processEmbed(node, editorShifts.get(node) ?? currentLevel);
        return;
      }

      let lineLevel = headingLevelFromClasses(node.classList);
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
   * and CodeMirror virtualizes long notes. Read the heading positions from the
   * editor's current source instead, then map each rendered embed back to its
   * source line.
   */
  private getLivePreviewShifts(root: HTMLElement): Map<HTMLElement, number> {
    const shifts = new Map<HTMLElement, number>();
    const view = this.findMarkdownView(root);
    if (!view) {
      return shifts;
    }

    const editorView = (view.editor as unknown as { cm?: CodeMirrorViewLike }).cm;
    if (!editorView) {
      return shifts;
    }

    let headings: HeadingAtLine[];
    try {
      headings = parseHeadingLines(view.editor.getValue().split(/\r?\n/));
    } catch {
      return shifts;
    }

    for (const embed of Array.from(root.querySelectorAll<HTMLElement>(EMBED_SELECTOR))) {
      if (embed.closest(EMBED_CONTENT_SELECTOR)) {
        continue;
      }

      try {
        const offset = editorView.posAtDOM(embed);
        const line = editorView.state.doc.lineAt(offset).number - 1;
        shifts.set(embed, nearestPrecedingHeadingLevel(headings, line));
      } catch {
        // A widget may not have a DOM position while it is being recycled.
        // The caller falls back to the nearest visible heading line.
      }
    }

    return shifts;
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

  private applyHeadingLevel(heading: HTMLElement, level: number, originalLevel: number): void {
    const replacement = this.replaceHeading(heading, level);
    replacement.setAttribute(SHIFT_ATTRIBUTE, String(level - originalLevel));
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

    const replacement = heading.ownerDocument.createElement(`h${level}`) as HTMLElement;

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
      }
    }
  }

  private restoreHeading(heading: HTMLElement): void {
    const stored = heading.getAttribute(ORIGINAL_LEVEL_ATTRIBUTE);
    const original = stored === null ? Number.NaN : Number.parseInt(stored, 10);

    const restored =
      Number.isInteger(original) && original >= 1 && original <= 6
        ? this.replaceHeading(heading, original)
        : heading;

    restored.removeAttribute(ORIGINAL_LEVEL_ATTRIBUTE);
    restored.removeAttribute(SHIFT_ATTRIBUTE);
  }

  private ensureObserver(root: HTMLElement): void {
    if (this.observers.has(root)) {
      return;
    }    const observer = new MutationObserver((records) => {
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

    for (const added of Array.from(record.addedNodes)) {
      if (!isElement(added)) {
        continue;
      }

      if (
        added.matches(HEADING_SELECTOR) ||
        added.matches(EMBED_SELECTOR) ||
        added.matches(EMBED_CONTENT_SELECTOR)
      ) {
        return true;
      }

      if (added.querySelector(`${HEADING_SELECTOR}, ${EMBED_SELECTOR}, ${EMBED_CONTENT_SELECTOR}`)) {
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
