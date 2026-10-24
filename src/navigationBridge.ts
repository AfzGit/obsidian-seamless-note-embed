import type { App, TFile } from "obsidian";
import { HeadingScroller } from "./headingNavigation";
import type {
  MetadataHeadingIntegration,
  VirtualHeadingToken,
} from "./metadataHeadings";

type AnyFunction = (...args: unknown[]) => unknown;

interface MarkdownViewLike {
  file?: TFile | null;
  contentEl?: HTMLElement;
  getViewType?: () => string;
  editor?: unknown;
  editMode?: { editor?: unknown } | null;
  previewMode?: { renderer?: unknown } | null;
}

interface PatchRecord {
  target: object;
  key: string;
  hadOwn: boolean;
  original: unknown;
  wrapper: unknown;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function asRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/**
 * Translates the virtual positions exposed through the metadata cache back
 * into real editor/preview positions, and schedules an exact scroll to the
 * rendered heading.
 *
 * This is deliberately implemented against the common Obsidian/CodeMirror
 * APIs rather than against individual plugins:
 * - `MarkdownView.setEphemeralState` covers outline clicks and subpath links.
 * - `Editor.offsetToPos`/`setCursor`/`setSelection` cover offset-based search
 *   plugins such as Another Quick Switcher's header search.
 * - The preview renderer's `applyScroll` covers plugins that scroll directly.
 * - CodeMirror's `Text.line` maps virtual line lookups for plugins that bypass
 *   the Obsidian Editor, but deliberately does not treat those lookups as
 *   navigation requests.
 */
export class HeadingNavigationBridge {
  private readonly scroller: HeadingScroller;
  private readonly patches: PatchRecord[] = [];
  private readonly editorViews = new WeakMap<object, MarkdownViewLike>();
  private readonly rendererViews = new WeakMap<object, MarkdownViewLike>();
  private readonly docViews = new WeakMap<object, MarkdownViewLike>();
  private readonly pending = new Map<
    string,
    { token: VirtualHeadingToken; at: number }
  >();
  private active = false;
  private destroyed = false;

  constructor(
    private readonly app: App,
    private readonly metadata: MetadataHeadingIntegration,
  ) {
    this.scroller = new HeadingScroller(app);
  }

  start(): void {
    if (this.destroyed) {
      return;
    }

    this.active = true;
    this.patchAll();
  }

  stop(): void {
    this.active = false;
    this.scroller.cancel();
    this.restoreAll();
  }

  destroy(): void {
    this.stop();
    this.destroyed = true;
  }

  onLayoutChange(): void {
    this.patchAll();
  }

  refresh(): void {
    this.patchAll();
  }

  onSettingsChanged(): void {
    this.scroller.cancel();
    this.patchAll();
  }

  /**
   * Schedule an exact scroll for a virtual heading line. This is for plugins
   * whose navigation path only performs a CodeMirror line lookup, which is
   * intentionally treated as passive by the bridge.
   */
  navigateToLine(file: TFile, line: number): boolean {
    if (!this.active) {
      return false;
    }

    const token = this.resolveLine(file, line);
    if (!token) {
      return false;
    }

    this.rememberPending(token);
    this.scroller.schedule(file, token.meta.key);
    return true;
  }

  private patchAll(): boolean {
    if (!this.active || this.destroyed) {
      return false;
    }

    let changed = this.patchLeaf();
    for (const view of this.getMarkdownViews()) {
      changed = this.patchMarkdownView(view) || changed;
      changed = this.patchEditor(view) || changed;
      changed = this.patchRenderer(view) || changed;
      changed = this.patchCodeMirror(view) || changed;
    }

    return changed;
  }

  private patchLeaf(): boolean {
    const workspace = this.app.workspace as unknown as {
      activeLeaf?: object | null;
      iterateAllLeaves?: (callback: (leaf: object) => void) => void;
    };

    let leaf = workspace.activeLeaf ?? null;
    if (!leaf && typeof workspace.iterateAllLeaves === "function") {
      workspace.iterateAllLeaves((candidate) => {
        leaf = leaf ?? candidate;
      });
    }

    if (!leaf) {
      return false;
    }

    const integration = this;
    return this.installOnPrototypeOrObject(
      leaf,
      "openFile",
      (original) => {
        return function (
          this: object,
          file: unknown,
          ...args: unknown[]
        ): unknown {
          const result = original.call(this, file, ...args);
          if (
            result &&
            typeof (result as { then?: unknown }).then === "function"
          ) {
            return (result as Promise<unknown>).then((value) => {
              integration.flushPending(file);
              return value;
            });
          }

          integration.flushPending(file);
          return result;
        };
      },
    );
  }

  private getMarkdownViews(): MarkdownViewLike[] {
    const workspace = this.app.workspace as unknown as {
      getLeavesOfType?: (type: string) => Array<{ view?: unknown }>;
      iterateAllLeaves?: (callback: (leaf: { view?: unknown }) => void) => void;
    };

    const views: MarkdownViewLike[] = [];
    const add = (leaf: { view?: unknown }): void => {
      const view = leaf?.view as MarkdownViewLike | undefined;
      if (view && view.getViewType?.() === "markdown") {
        views.push(view);
      }
    };

    if (typeof workspace.getLeavesOfType === "function") {
      for (const leaf of workspace.getLeavesOfType("markdown")) {
        add(leaf);
      }
    } else if (typeof workspace.iterateAllLeaves === "function") {
      workspace.iterateAllLeaves(add);
    }

    return views;
  }

  private patchMarkdownView(view: MarkdownViewLike): boolean {
    const integration = this;
    return this.installOnPrototypeOrObject(
      view,
      "setEphemeralState",
      (original) => {
        return function (
          this: MarkdownViewLike,
          state: unknown,
          ...args: unknown[]
        ): unknown {
          return integration.handleSetEphemeralState(
            this,
            original,
            state,
            args,
          );
        };
      },
    );
  }

  private patchEditor(view: MarkdownViewLike): boolean {
    const editor = this.getViewEditor(view);
    if (!isObject(editor)) {
      return false;
    }

    const integration = this;
    this.editorViews.set(editor, view);
    let changed = false;

    changed =
      this.installOnPrototypeOrObject(editor, "offsetToPos", (original) => {
        return function (
          this: object,
          offset: unknown,
          ...args: unknown[]
        ): unknown {
          return integration.handleOffsetToPos(
            this,
            original,
            offset,
            args,
          );
        };
      }) || changed;

    changed =
      this.installOnPrototypeOrObject(editor, "posToOffset", (original) => {
        return function (
          this: object,
          pos: unknown,
          ...args: unknown[]
        ): unknown {
          return integration.handlePosToOffset(this, original, pos, args);
        };
      }) || changed;

    changed =
      this.installOnPrototypeOrObject(editor, "setCursor", (original) => {
        return function (
          this: object,
          pos: unknown,
          ...args: unknown[]
        ): unknown {
          return integration.handleSetCursor(this, original, pos, args);
        };
      }) || changed;

    changed =
      this.installOnPrototypeOrObject(editor, "setSelection", (original) => {
        return function (
          this: object,
          anchor: unknown,
          head: unknown,
          ...args: unknown[]
        ): unknown {
          return integration.handleSetSelection(
            this,
            original,
            anchor,
            head,
            args,
          );
        };
      }) || changed;

    changed =
      this.installOnPrototypeOrObject(editor, "scrollIntoView", (original) => {
        return function (
          this: object,
          range: unknown,
          ...args: unknown[]
        ): unknown {
          return integration.handleScrollIntoView(
            this,
            original,
            range,
            args,
          );
        };
      }) || changed;

    return changed;
  }

  private patchRenderer(view: MarkdownViewLike): boolean {
    let renderer: unknown;
    try {
      renderer = view.previewMode?.renderer;
    } catch {
      return false;
    }

    if (!isObject(renderer)) {
      return false;
    }

    const integration = this;
    this.rendererViews.set(renderer, view);
    let changed = false;

    for (const key of ["applyScroll", "applyScrollDelayed"]) {
      changed =
        this.installOnPrototypeOrObject(renderer, key, (original) => {
          return function (
            this: object,
            line: unknown,
            ...args: unknown[]
          ): unknown {
            return integration.handleApplyScroll(
              this,
              original,
              line,
              args,
            );
          };
        }) || changed;
    }

    return changed;
  }

  private patchCodeMirror(view: MarkdownViewLike): boolean {
    const editor = this.getViewEditor(view);
    if (!isObject(editor)) {
      return false;
    }

    let doc: unknown;
    try {
      doc = (asRecord(editor).cm as { state?: { doc?: unknown } } | undefined)
        ?.state?.doc;
    } catch {
      return false;
    }

    if (!isObject(doc)) {
      return false;
    }

    const integration = this;
    this.docViews.set(doc, view);
    return this.installOnPrototypeOrObject(doc, "line", (original) => {
      return function (
        this: object,
        line: unknown,
        ...args: unknown[]
      ): unknown {
        return integration.handleDocLine(this, original, line, args);
      };
    });
  }

  private handleSetEphemeralState(
    view: MarkdownViewLike,
    original: AnyFunction,
    state: unknown,
    args: unknown[],
  ): unknown {
    let nextState = state;
    const file = view.file;

    if (this.active && file && isObject(state)) {
      const record = asRecord(state);
      let token: VirtualHeadingToken | null = null;

      if (typeof record.subpath === "string") {
        token = this.metadata.resolveVirtualSubpath(file, record.subpath);
        if (token) {
          nextState = {
            ...record,
            subpath: undefined,
            line: token.realLine,
            cursor: { line: token.realLine, ch: 0 },
          };
        }
      }

      if (!token && typeof record.line === "number") {
        token = this.resolveLine(file, record.line);
        if (token) {
          nextState = {
            ...(nextState as Record<string, unknown>),
            line: token.realLine,
          };
        }
      }

      if (isObject(record.cursor)) {
        const mapped = this.mapPosition(file, record.cursor);
        if (mapped.token) {
          token = token ?? mapped.token;
          nextState = {
            ...(nextState as Record<string, unknown>),
            cursor: mapped.position,
          };
        }
      }

      if (token) {
        this.rememberPending(token);
      }

      const result = original.call(view, nextState, ...args);
      if (token) {
        // The original method may have scrolled to the embed line. Schedule
        // after it so the exact embedded heading wins.
        this.scroller.schedule(file, token.meta.key, view);
      }
      return result;
    }

    return original.call(view, nextState, ...args);
  }

  private handleOffsetToPos(
    editor: object,
    original: AnyFunction,
    offset: unknown,
    args: unknown[],
  ): unknown {
    if (this.active && typeof offset === "number") {
      const token = this.metadata.resolveVirtualOffset(offset);
      if (token) {
        // Do not prefer the current view: the plugin may be about to open the
        // file in another leaf. The scroller retries and finds the active one.
        this.rememberPending(token);
        this.scroller.schedule(token.file, token.meta.key);
        return { line: token.realLine, ch: 0 };
      }
    }

    return original.call(editor, offset, ...args);
  }

  private handlePosToOffset(
    editor: object,
    original: AnyFunction,
    pos: unknown,
    args: unknown[],
  ): unknown {
    if (this.active && isObject(pos)) {
      const view = this.findViewForEditor(editor);
      const file = view?.file;
      if (file) {
        const line = asRecord(pos).line;
        if (typeof line === "number") {
          const token = this.resolveLine(file, line);
          if (token) {
            // This is a position lookup, not a navigation request. Do not
            // schedule a scroll here; plugins such as Subtle TOC use it while
            // tracking the active heading and would otherwise steal scrolling.
            return token.offset;
          }
        }
      }
    }

    return original.call(editor, pos, ...args);
  }

  private handleSetCursor(
    editor: object,
    original: AnyFunction,
    pos: unknown,
    args: unknown[],
  ): unknown {
    const view = this.findViewForEditor(editor);
    const file = view?.file;
    if (this.active && file) {
      if (typeof pos === "number") {
        const token = this.resolveLine(file, pos);
        if (token) {
          this.rememberPending(token);
          this.scroller.schedule(file, token.meta.key);
          return original.call(
            editor,
            { line: token.realLine, ch: 0 },
            ...args,
          );
        }
      } else if (isObject(pos)) {
        const mapped = this.mapPosition(file, pos);
        if (mapped.token) {
          this.rememberPending(mapped.token);
          this.scroller.schedule(file, mapped.token.meta.key);
          return original.call(editor, mapped.position, ...args);
        }
      }
    }

    return original.call(editor, pos, ...args);
  }

  private handleSetSelection(
    editor: object,
    original: AnyFunction,
    anchor: unknown,
    head: unknown,
    args: unknown[],
  ): unknown {
    const view = this.findViewForEditor(editor);
    const file = view?.file;
    if (this.active && file) {
      const anchorMapped = isObject(anchor)
        ? this.mapPosition(file, anchor)
        : { position: anchor, token: null };
      const headMapped = isObject(head)
        ? this.mapPosition(file, head)
        : { position: head, token: null };
      const token = anchorMapped.token ?? headMapped.token;

      if (token) {
        this.rememberPending(token);
        this.scroller.schedule(file, token.meta.key);
        return original.call(
          editor,
          anchorMapped.position,
          headMapped.position,
          ...args,
        );
      }
    }

    return original.call(editor, anchor, head, ...args);
  }

  private handleScrollIntoView(
    editor: object,
    original: AnyFunction,
    range: unknown,
    args: unknown[],
  ): unknown {
    const view = this.findViewForEditor(editor);
    const file = view?.file;
    if (this.active && file && isObject(range)) {
      const record = asRecord(range);
      const fromMapped = isObject(record.from)
        ? this.mapPosition(file, record.from)
        : { position: record.from, token: null };
      const toMapped = isObject(record.to)
        ? this.mapPosition(file, record.to)
        : { position: record.to, token: null };
      const token = fromMapped.token ?? toMapped.token;

      if (token) {
        this.rememberPending(token);
        this.scroller.schedule(file, token.meta.key);
        return original.call(
          editor,
          { ...record, from: fromMapped.position, to: toMapped.position },
          ...args,
        );
      }
    }

    return original.call(editor, range, ...args);
  }

  private handleApplyScroll(
    renderer: object,
    original: AnyFunction,
    line: unknown,
    args: unknown[],
  ): unknown {
    const view =
      this.rendererViews.get(renderer) ?? this.findViewForRenderer(renderer);
    const file = view?.file;

    if (this.active && file && typeof line === "number") {
      const token = this.resolveLine(file, line);
      if (token) {
        this.rememberPending(token);
        const result = original.call(renderer, token.realLine, ...args);
        this.scroller.schedule(file, token.meta.key, view);
        return result;
      }
    }

    return original.call(renderer, line, ...args);
  }

  private handleDocLine(
    doc: object,
    original: AnyFunction,
    line: unknown,
    args: unknown[],
  ): unknown {
    const view = this.docViews.get(doc) ?? this.findViewForDoc(doc);
    const file = view?.file;

    // CodeMirror lines are 1-based integers. Virtual lines are fractional, so
    // only intercept those; ordinary line lookups stay untouched.
    if (
      this.active &&
      file &&
      typeof line === "number" &&
      !Number.isInteger(line)
    ) {
      const token = this.resolveLine(file, line);
      if (token) {
        // Text.line() is also used for hit-testing and active-heading
        // tracking. Map the line, but do not turn every lookup into a scroll
        // request; that makes plugins fight over the viewport.
        return original.call(doc, token.realLine + 1, ...args);
      }
    }

    return original.call(doc, line, ...args);
  }

  private mapPosition(
    file: TFile,
    position: object,
  ): { position: unknown; token: VirtualHeadingToken | null } {
    const record = asRecord(position);
    const line = record.line;
    if (typeof line !== "number") {
      return { position, token: null };
    }

    const token = this.resolveLine(file, line);
    if (!token) {
      return { position, token: null };
    }

    return {
      position: { ...record, line: token.realLine, ch: 0 },
      token,
    };
  }

  private resolveLine(
    file: TFile,
    line: number,
  ): VirtualHeadingToken | null {
    return (
      this.metadata.resolveVirtualLine(file, line) ??
      this.metadata.resolveVirtualLine(file, line - 1)
    );
  }

  /**
   * Offset navigation often finishes with `leaf.openFile(..., { eState })`,
   * which scrolls to the embed line after our first scroll request. Keep the
   * target briefly so the leaf wrapper can re-apply the exact scroll after the
   * file has finished opening.
   */
  private rememberPending(token: VirtualHeadingToken): void {
    const now = Date.now();
    for (const [path, pending] of this.pending) {
      if (now - pending.at > 5000) {
        this.pending.delete(path);
      }
    }

    this.pending.set(token.filePath, { token, at: now });
  }

  private flushPending(file: unknown): void {
    const path =
      typeof file === "string"
        ? file
        : isObject(file) && typeof asRecord(file).path === "string"
          ? (asRecord(file).path as string)
          : null;
    if (!path) {
      return;
    }

    const pending = this.pending.get(path);
    if (!pending) {
      return;
    }

    this.pending.delete(path);
    if (Date.now() - pending.at <= 5000) {
      this.scroller.schedule(pending.token.file, pending.token.meta.key);
    }
  }

  private getViewEditor(view: MarkdownViewLike): unknown {
    try {
      return view.editor ?? view.editMode?.editor;
    } catch {
      return view.editMode?.editor;
    }
  }

  private findViewForEditor(editor: object): MarkdownViewLike | null {
    const cached = this.editorViews.get(editor);
    if (cached) {
      return cached;
    }

    for (const view of this.getMarkdownViews()) {
      const candidate = this.getViewEditor(view);
      if (candidate === editor) {
        this.editorViews.set(editor, view);
        return view;
      }
    }

    return null;
  }

  private findViewForRenderer(renderer: object): MarkdownViewLike | null {
    const cached = this.rendererViews.get(renderer);
    if (cached) {
      return cached;
    }

    for (const view of this.getMarkdownViews()) {
      try {
        if (view.previewMode?.renderer === renderer) {
          this.rendererViews.set(renderer, view);
          return view;
        }
      } catch {
        // Ignore views without a preview mode.
      }
    }

    return null;
  }

  private findViewForDoc(doc: object): MarkdownViewLike | null {
    for (const view of this.getMarkdownViews()) {
      const editor = this.getViewEditor(view);
      if (!isObject(editor)) {
        continue;
      }

      try {
        if (
          (asRecord(editor).cm as { state?: { doc?: unknown } } | undefined)
            ?.state?.doc === doc
        ) {
          this.docViews.set(doc, view);
          return view;
        }
      } catch {
        // Ignore views without a CodeMirror document.
      }
    }

    return null;
  }

  private installOnPrototypeOrObject(
    target: object,
    key: string,
    createWrapper: (original: AnyFunction) => AnyFunction,
  ): boolean {
    if (
      Object.prototype.hasOwnProperty.call(target, key) &&
      typeof Reflect.get(target, key) === "function"
    ) {
      return this.installMethod(target, key, createWrapper);
    }

    const prototype = Object.getPrototypeOf(target) as object | null;
    if (prototype && typeof Reflect.get(prototype, key) === "function") {
      return this.installMethod(prototype, key, createWrapper);
    }

    if (typeof Reflect.get(target, key) === "function") {
      return this.installMethod(target, key, createWrapper);
    }

    return false;
  }

  private hasPatch(target: object, key: string): boolean {
    return this.patches.some(
      (patch) => patch.target === target && patch.key === key,
    );
  }

  private installMethod(
    target: object,
    key: string,
    createWrapper: (original: AnyFunction) => AnyFunction,
  ): boolean {
    if (this.hasPatch(target, key)) {
      return false;
    }

    const original = Reflect.get(target, key);
    if (typeof original !== "function") {
      return false;
    }

    const hadOwn = Object.prototype.hasOwnProperty.call(target, key);
    const wrapper = createWrapper(original as AnyFunction);
    if (!Reflect.set(target, key, wrapper)) {
      return false;
    }

    this.patches.push({ target, key, hadOwn, original, wrapper });
    return true;
  }

  private restoreAll(): void {
    for (let index = this.patches.length - 1; index >= 0; index--) {
      const patch = this.patches[index];
      if (Reflect.get(patch.target, patch.key) !== patch.wrapper) {
        continue;
      }

      if (patch.hadOwn) {
        Reflect.set(patch.target, patch.key, patch.original);
      } else {
        Reflect.deleteProperty(patch.target, patch.key);
      }
    }

    this.patches.length = 0;
  }
}
