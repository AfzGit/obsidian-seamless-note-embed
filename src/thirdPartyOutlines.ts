import type { App, TFile } from "obsidian";
import type { MetadataHeadingIntegration } from "./metadataHeadings";
import type { OutlineEmbedMeta } from "./outlineKeys";

/* eslint-disable @typescript-eslint/no-this-alias -- Patched methods need both their original dynamic this and the integration instance. */
type AnyFunction = (...args: unknown[]) => unknown;

interface AppWithPlugins extends App {
  plugins?: {
    plugins?: Record<string, unknown>;
  };
}

interface MarkdownViewLike {
  file?: TFile | null;
  contentEl?: HTMLElement;
  getViewType?: () => string;
  getMode?: () => string;
  getState?: () => { source?: boolean } | null;
}

interface HeaderWithMeta {
  aeih?: OutlineEmbedMeta;
  [key: string]: unknown;
}

interface QuietNavigatorLike {
  view?: MarkdownViewLike | null;
  getId?: () => string;
  getHeaders?: AnyFunction;
  jump?: AnyFunction;
  jumpWithoutFocus?: AnyFunction;
  onRightClick?: AnyFunction;
  handleDrop?: AnyFunction;
  __aeihHeaders?: HeaderWithMeta[];
}

interface QuietPluginLike {
  navigator?: QuietNavigatorLike;
  updateNav?: AnyFunction;
  updateNavAndRefresh?: AnyFunction;
  refresh?: AnyFunction;
  refresh_outline?: AnyFunction;
}

interface SubtleOverlayLike {
  view?: MarkdownViewLike | null;
  headings?: HeaderWithMeta[];
  settings?: {
    minLevel?: number;
    maxLevel?: number;
    show?: string;
    smoothScroll?: boolean;
  };
  refresh?: AnyFunction;
  navigate?: AnyFunction;
  updateActive?: AnyFunction;
  setActive?: AnyFunction;
  activeIndex?: number;
}

type VirtualHeadingNavigator = (file: TFile, line: number) => boolean;

interface SubtlePluginLike {
  overlay?: SubtleOverlayLike | null;
  sync?: AnyFunction;
}

interface MethodPatch {
  target: object;
  key: string;
  hadOwn: boolean;
  original: unknown;
  wrapper: unknown;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    !!value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isQuietMarkdownNavigator(navigator: QuietNavigatorLike): boolean {
  const id = navigator.getId?.();
  return !id || id === "markdown" || id === "embed-markdown-file";
}

function quietMeta(
  navigator: QuietNavigatorLike,
  index: unknown,
): OutlineEmbedMeta | undefined {
  if (
    !isQuietMarkdownNavigator(navigator) ||
    typeof index !== "number" ||
    !navigator.__aeihHeaders
  ) {
    return undefined;
  }

  return navigator.__aeihHeaders[index]?.aeih;
}

/**
 * Adds heading metadata and safe-editing behavior on top of the virtual
 * headings exposed through the metadata cache.
 *
 * Navigation itself is handled generically by HeadingNavigationBridge, which
 * translates the virtual positions through Obsidian's normal editor, preview,
 * and subpath APIs. These wrappers only prevent destructive edits (context
 * menus, drag-and-drop) on headings that do not have a real source line.
 */
export class ThirdPartyOutlineIntegration {
  private readonly methodPatches: MethodPatch[] = [];
  private patchedQuietPlugins = new WeakSet<object>();
  private patchedSubtlePlugins = new WeakSet<object>();
  private subtleNavigateTimer: number | null = null;
  private active = false;
  private destroyed = false;

  constructor(
    private readonly app: App,
    private readonly metadata: MetadataHeadingIntegration,
    private readonly navigateToVirtualHeading?: VirtualHeadingNavigator,
  ) {}

  start(): void {
    if (this.destroyed) {
      return;
    }

    this.active = true;
    this.patchAll();
    // The outline plugins may already have rendered before this plugin
    // loaded. Re-read once so they pick up the virtual headings.
    this.refreshPlugins();
  }

  stop(): void {
    this.active = false;
    if (this.subtleNavigateTimer !== null) {
      window.clearTimeout(this.subtleNavigateTimer);
      this.subtleNavigateTimer = null;
    }
    this.restoreAll();
    this.patchedQuietPlugins = new WeakSet();
    this.patchedSubtlePlugins = new WeakSet();

    // Let the other plugins redraw without the virtual headings.
    this.refreshPlugins();
  }

  destroy(): void {
    this.stop();
    this.destroyed = true;
  }

  onLayoutChange(): void {
    if (this.patchAll()) {
      this.refreshPlugins();
    }
  }

  onSettingsChanged(): void {
    this.patchAll();
    this.refreshPlugins();
  }

  /** Re-read headings after metadata changes, including target-note changes. */
  refresh(): void {
    this.patchAll();
    this.refreshPlugins();
  }

  private patchAll(): boolean {
    if (this.destroyed || !this.active) {
      return false;
    }

    let changed = false;

    const quiet = this.getPlugin("obsidian-quiet-outline") as
      | QuietPluginLike
      | null;
    if (quiet) {
      changed = this.patchQuietPlugin(quiet) || changed;
    }

    const subtle = this.getPlugin("subtle-toc") as SubtlePluginLike | null;
    if (subtle) {
      changed = this.patchSubtlePlugin(subtle) || changed;
    }

    return changed;
  }

  private getPlugin(id: string): object | null {
    const app = this.app as AppWithPlugins;
    const plugin = app.plugins?.plugins?.[id];
    return plugin && typeof plugin === "object" ? plugin : null;
  }

  private patchQuietPlugin(plugin: QuietPluginLike): boolean {
    const key = plugin as object;
    if (this.patchedQuietPlugins.has(key)) {
      return false;
    }
    this.patchedQuietPlugins.add(key);

    let changed = false;
    if (plugin.navigator) {
      changed = this.patchQuietNavigator(plugin.navigator) || changed;
    }

    const integration = this;
    const patchAfterUpdate = (original: AnyFunction): AnyFunction => {
      return async function (
        this: QuietPluginLike,
        ...args: unknown[]
      ): Promise<unknown> {
        const result = await original.apply(this, args);
        if (integration.active) {
          integration.patchQuietNavigatorFromPlugin(this);
        }
        return result;
      };
    };

    changed =
      this.installMethod(plugin, "updateNav", patchAfterUpdate) || changed;
    changed =
      this.installMethod(
        plugin,
        "updateNavAndRefresh",
        patchAfterUpdate,
      ) || changed;

    return changed;
  }

  private patchQuietNavigatorFromPlugin(plugin: QuietPluginLike): void {
    if (plugin.navigator) {
      this.patchQuietNavigator(plugin.navigator);
    }
  }

  private patchQuietNavigator(navigator: QuietNavigatorLike): boolean {
    const file = navigator.view?.file;
    if (!file || file.extension !== "md") {
      return false;
    }

    // Quiet Outline uses subclasses for Kanban, Canvas, PDF, and other
    // views. Only the two markdown navigators should receive note headings.
    const id = navigator.getId?.();
    if (id && id !== "markdown" && id !== "embed-markdown-file") {
      return false;
    }

    const prototype = Object.getPrototypeOf(navigator) as object | null;
    if (!prototype || this.hasPatch(prototype, "getHeaders")) {
      return false;
    }

    const integration = this;

    if (
      !this.installMethod(prototype, "getHeaders", (original) => {
        return function (
          this: QuietNavigatorLike,
          ...args: unknown[]
        ): unknown {
          const result = original.apply(this, args);
          if (!integration.active || !isQuietMarkdownNavigator(this)) {
            return result;
          }

          if (isThenable(result)) {
            return Promise.resolve(result).then((headers) =>
              integration.attachQuietHeaders(this, headers),
            );
          }

          return integration.attachQuietHeaders(this, result);
        };
      })
    ) {
      return false;
    }

    // Quiet Outline's context menu can edit the parent note at the heading's
    // line. A synthetic heading points at the embed, so editing it would
    // replace the embed link. Do not offer that menu for synthetic entries.
    this.installMethod(prototype, "onRightClick", (original) => {
      return function (
        this: QuietNavigatorLike,
        index: unknown,
        ...args: unknown[]
      ): unknown {
        if (integration.active && quietMeta(this, index)) {
          return undefined;
        }
        return original.call(this, index, ...args);
      };
    });

    // Dragging a synthetic heading would move the embed link or modify the
    // parent note. Leave those entries fixed.
    this.installMethod(prototype, "handleDrop", (original) => {
      return function (
        this: QuietNavigatorLike,
        sourceIndex: unknown,
        targetIndex: unknown,
        ...args: unknown[]
      ): unknown {
        if (
          integration.active &&
          (quietMeta(this, sourceIndex) || quietMeta(this, targetIndex))
        ) {
          return undefined;
        }
        return original.call(this, sourceIndex, targetIndex, ...args);
      };
    });

    return true;
  }

  private attachQuietHeaders(
    navigator: QuietNavigatorLike,
    headers: unknown,
  ): unknown {
    if (!Array.isArray(headers)) {
      return headers;
    }

    const file = navigator.view?.file;
    if (!file || file.extension !== "md") {
      return headers;
    }

    const headerArray = headers as HeaderWithMeta[];
    try {
      const combined = this.metadata.getCombinedHeadings(file);
      // If the plugin filters or reorders its headings, index-based metadata
      // would attach to the wrong entry. In that case leave the metadata alone;
      // the headings still appear through the metadata cache.
      if (combined && combined.length === headerArray.length) {
        for (let index = 0; index < headerArray.length; index++) {
          const meta = combined[index]?.aeih;
          if (meta) {
            headerArray[index].aeih = meta;
          }
        }
      }

      navigator.__aeihHeaders = headerArray;
    } catch (error) {
      console.error(
        "Seamless Note Embed: failed to attach Quiet Outline metadata",
        error,
      );
    }

    return headerArray;
  }

  private patchSubtlePlugin(plugin: SubtlePluginLike): boolean {
    const key = plugin as object;
    if (this.patchedSubtlePlugins.has(key)) {
      return false;
    }
    this.patchedSubtlePlugins.add(key);

    let changed = false;
    if (plugin.overlay) {
      changed = this.patchSubtleOverlay(plugin.overlay) || changed;
    }

    const integration = this;
    changed =
      this.installMethod(plugin, "sync", (original) => {
        return function (
          this: SubtlePluginLike,
          ...args: unknown[]
        ): unknown {
          const result = original.apply(this, args);
          if (integration.active) {
            integration.patchSubtleOverlay(this.overlay);
          }
          return result;
        };
      }) || changed;

    return changed;
  }

  private patchSubtleOverlay(overlay: SubtleOverlayLike | null | undefined): boolean {
    if (!overlay) {
      return false;
    }

    const prototype = Object.getPrototypeOf(overlay) as object | null;
    if (!prototype || this.hasPatch(prototype, "refresh")) {
      return false;
    }

    const integration = this;

    if (
      !this.installMethod(prototype, "refresh", (original) => {
        return function (
          this: SubtleOverlayLike,
          ...args: unknown[]
        ): unknown {
          const result = original.apply(this, args);
          if (!integration.active) {
            return result;
          }

          integration.attachSubtleMeta(this);
          this.updateActive?.();
          return result;
        };
      })
    ) {
      return false;
    }

    // All embedded headings share the embed's line. Let the real parent
    // heading stay highlighted while the user scrolls through the embed.
    this.installMethod(prototype, "updateActive", (original) => {
      return function (
        this: SubtleOverlayLike,
        ...args: unknown[]
      ): unknown {
        const result = original.apply(this, args);
        const headings = this.headings;
        if (
          integration.active &&
          Array.isArray(headings) &&
          typeof this.activeIndex === "number" &&
          this.activeIndex >= 0 &&
          headings[this.activeIndex]?.aeih
        ) {
          let index = this.activeIndex - 1;
          while (index >= 0 && headings[index]?.aeih) {
            index--;
          }
          if (typeof this.setActive === "function") {
            try {
              this.setActive(index);
            } catch (error) {
              console.error(
                "Seamless Note Embed: failed to update the Subtle TOC active heading",
                error,
              );
            }
          }
        }
        return result;
      };
    });

    // Subtle TOC's source/live-preview navigation resolves the heading through
    // CodeMirror's `Text.line` and then scrolls to that line. For an embedded
    // heading that line is the embed's own line, so schedule the exact visible
    // heading after Subtle's own scroll animation has settled.
    this.installMethod(prototype, "navigate", (original) => {
      return function (
        this: SubtleOverlayLike,
        index: unknown,
        ...args: unknown[]
      ): unknown {
        const result = original.call(this, index, ...args);

        if (!integration.active || typeof index !== "number") {
          return result;
        }

        const heading = this.headings?.[index];
        const file = this.view?.file;
        const line = heading?.line;
        if (!file || typeof line !== "number") {
          return result;
        }

        const mode = this.view?.getMode?.();
        let rawSource = false;
        try {
          rawSource = this.view?.getState?.()?.source === true;
        } catch {
          rawSource = false;
        }

        // Reading view is handled by the preview renderer; raw source has no
        // rendered embedded headings to target.
        if (mode === "preview" || rawSource) {
          return result;
        }

        integration.scheduleSubtleNavigation(
          file,
          line,
          this.settings?.smoothScroll ? 320 : 0,
        );
        return result;
      };
    });

    return true;
  }

  private scheduleSubtleNavigation(
    file: TFile,
    line: number,
    delay: number,
  ): void {
    if (!this.navigateToVirtualHeading) {
      return;
    }

    if (this.subtleNavigateTimer !== null) {
      window.clearTimeout(this.subtleNavigateTimer);
      this.subtleNavigateTimer = null;
    }

    const run = (): void => {
      this.subtleNavigateTimer = null;
      if (this.active) {
        this.navigateToVirtualHeading?.(file, line);
      }
    };

    if (delay > 0) {
      this.subtleNavigateTimer = window.setTimeout(run, delay);
    } else {
      run();
    }
  }

  private attachSubtleMeta(overlay: SubtleOverlayLike): void {
    const file = overlay.view?.file;
    if (!file || file.extension !== "md") {
      return;
    }

    const combined = this.metadata.getCombinedHeadings(file);
    if (!combined || !Array.isArray(overlay.headings)) {
      return;
    }

    const settings = overlay.settings;
    if (settings?.show === "tasks") {
      return;
    }

    const minLevel = settings?.minLevel ?? 1;
    const maxLevel = settings?.maxLevel ?? 6;
    const filtered = combined.filter(
      (heading) => heading.level >= minLevel && heading.level <= maxLevel,
    );
    if (filtered.length !== overlay.headings.length) {
      return;
    }

    try {
      for (let index = 0; index < overlay.headings.length; index++) {
        const meta = filtered[index]?.aeih;
        if (meta) {
          overlay.headings[index].aeih = meta;
        }
      }
    } catch (error) {
      console.error(
        "Seamless Note Embed: failed to attach Subtle TOC metadata",
        error,
      );
    }
  }

  private refreshPlugins(): void {
    const quiet = this.getPlugin("obsidian-quiet-outline") as
      | QuietPluginLike
      | null;
    if (quiet) {
      try {
        if (typeof quiet.refresh === "function") {
          quiet.refresh();
        } else if (typeof quiet.refresh_outline === "function") {
          quiet.refresh_outline("file-modify");
        }
      } catch (error) {
        console.error(
          "Seamless Note Embed: failed to refresh Quiet Outline",
          error,
        );
      }
    }

    const subtle = this.getPlugin("subtle-toc") as SubtlePluginLike | null;
    if (subtle) {
      try {
        if (subtle.overlay && typeof subtle.overlay.refresh === "function") {
          subtle.overlay.refresh();
        } else if (typeof subtle.sync === "function") {
          subtle.sync();
        }
      } catch (error) {
        console.error(
          "Seamless Note Embed: failed to refresh Subtle TOC",
          error,
        );
      }
    }
  }

  private hasPatch(target: object, key: string): boolean {
    return this.methodPatches.some(
      (patch) => patch.target === target && patch.key === key,
    );
  }

  private installMethod(
    target: object,
    key: string,
    createWrapper: (original: AnyFunction) => AnyFunction,
  ): boolean {
    const original: unknown = Reflect.get(target, key);
    if (typeof original !== "function") {
      return false;
    }

    const hadOwn = Object.prototype.hasOwnProperty.call(target, key);
    const wrapper = createWrapper(original as AnyFunction);
    if (!Reflect.set(target, key, wrapper)) {
      return false;
    }

    this.methodPatches.push({ target, key, hadOwn, original, wrapper });
    return true;
  }

  private restoreAll(): void {
    for (let index = this.methodPatches.length - 1; index >= 0; index--) {
      const patch = this.methodPatches[index];
      if (Reflect.get(patch.target, patch.key) !== patch.wrapper) {
        continue;
      }

      if (patch.hadOwn) {
        Reflect.set(patch.target, patch.key, patch.original);
      } else {
        Reflect.deleteProperty(patch.target, patch.key);
      }
    }

    this.methodPatches.length = 0;
  }
}

/* eslint-enable @typescript-eslint/no-this-alias -- Wrapper definitions are complete. */
