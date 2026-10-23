import type { App, HeadingCache, TFile } from "obsidian";
import { getFileData } from "./embedData";
import { HeadingScroller } from "./headingNavigation";
import { buildOutlineHeadings, type OutlineHeading } from "./outlineHeadings";
import { OUTLINE_KEY_ATTRIBUTE, type OutlineEmbedMeta } from "./outlineKeys";

interface OutlineItemLike {
  selfEl: HTMLElement;
  heading: HeadingCache;
}

/**
 * The small part of Obsidian's internal outline view that this plugin uses.
 * Every member is optional so an incompatible future version is left alone
 * instead of breaking the outline view.
 */
interface OutlineViewLike {
  file?: TFile | null;
  containerEl: HTMLElement;
  cachedHeadingDom?: OutlineItemLike[];
  getHeadings?: () => HeadingCache[] | undefined;
  update?: () => unknown;
  createItemDom?: (heading: HeadingCache) => OutlineItemLike;
  findActiveHeading?: (view: unknown) => OutlineItemLike | null;
}

interface WorkspaceLeafLike {
  view: unknown;
}

interface PatchState {
  hadOwnGetHeadings: boolean;
  originalOwnGetHeadings: unknown;
  hadOwnUpdate: boolean;
  originalOwnUpdate: unknown;
  hadOwnCreateItemDom: boolean;
  originalOwnCreateItemDom: unknown;
  hadOwnFindActiveHeading: boolean;
  originalOwnFindActiveHeading: unknown;
  clickHandler: (event: MouseEvent) => void;
  mouseOverHandler: (event: MouseEvent) => void;
  dragStartHandler: (event: DragEvent) => void;
}

function decorateItem(item: OutlineItemLike | null | undefined): void {
  if (!item?.selfEl) {
    return;
  }

  const heading = item.heading as OutlineHeading | undefined;
  const meta = heading?.aeih;

  if (meta) {
    item.selfEl.setAttribute(OUTLINE_KEY_ATTRIBUTE, meta.key);
    item.selfEl.classList.add("aeih-outline-embedded");
    return;
  }

  item.selfEl.removeAttribute(OUTLINE_KEY_ATTRIBUTE);
  item.selfEl.classList.remove("aeih-outline-embedded");
}

function decorateView(view: OutlineViewLike): void {
  const items = view.cachedHeadingDom;
  if (!Array.isArray(items)) {
    return;
  }

  for (const item of items) {
    decorateItem(item);
  }
}

function undecorateView(view: OutlineViewLike): void {
  const items = view.cachedHeadingDom;
  if (!Array.isArray(items)) {
    return;
  }

  for (const item of items) {
    if (!item?.selfEl) {
      continue;
    }

    item.selfEl.removeAttribute(OUTLINE_KEY_ATTRIBUTE);
    item.selfEl.classList.remove("aeih-outline-embedded");
  }
}

/**
 * Adds embedded-note headings to Obsidian's built-in Outline view.
 *
 * The core outline builds its tree from `view.getHeadings()`. Patching that
 * method on each open outline view lets the existing outline renderer handle
 * indentation, collapse, search, and navigation without duplicating its UI.
 */
export class OutlineIntegration {
  private readonly patches = new Map<OutlineViewLike, PatchState>();
  private readonly scroller: HeadingScroller;
  private refreshFrame: number | null = null;
  private active = false;
  private destroyed = false;

  constructor(
    private readonly app: App,
    private readonly getSettings: () => { enabled: boolean },
  ) {
    this.scroller = new HeadingScroller(app);
  }

  start(): void {
    if (this.destroyed || !this.getSettings().enabled) {
      return;
    }

    this.active = true;
    this.patchAll();
    this.refresh();
  }

  stop(): void {
    this.active = false;
    this.scroller.cancel();

    if (this.refreshFrame !== null) {
      window.cancelAnimationFrame(this.refreshFrame);
      this.refreshFrame = null;
    }

    const views = Array.from(this.patches.keys());
    for (const [view, state] of this.patches) {
      this.restoreView(view, state);
    }
    this.patches.clear();

    for (const view of views) {
      try {
        view.update?.();
      } catch (error) {
        console.error("Seamless Note Embed: failed to refresh the outline", error);
      }
    }
  }

  destroy(): void {
    this.stop();
    this.destroyed = true;
  }

  onLayoutChange(): void {
    if (!this.active || !this.getSettings().enabled) {
      return;
    }

    this.patchAll();
    this.refresh();
  }

  onSettingsChanged(): void {
    if (!this.getSettings().enabled) {
      this.stop();
      return;
    }

    if (!this.active) {
      this.start();
    } else {
      this.refresh();
    }
  }

  /** Rebuild the outline after metadata or embedded-note changes. */
  refresh(): void {
    if (!this.active || !this.getSettings().enabled) {
      return;
    }

    this.patchAll();

    if (this.refreshFrame !== null) {
      return;
    }

    this.refreshFrame = window.requestAnimationFrame(() => {
      this.refreshFrame = null;
      if (!this.active) {
        return;
      }

      for (const view of Array.from(this.patches.keys())) {
        try {
          view.update?.();
        } catch (error) {
          console.error("Seamless Note Embed: failed to refresh the outline", error);
        }
      }
    });
  }

  private patchAll(): void {
    if (!this.active || !this.getSettings().enabled) {
      return;
    }

    this.pruneDetachedViews();

    const workspace = this.app.workspace;
    if (!workspace || typeof workspace.getLeavesOfType !== "function") {
      return;
    }

    let leaves: WorkspaceLeafLike[];
    try {
      leaves = workspace.getLeavesOfType("outline") as unknown as WorkspaceLeafLike[];
    } catch {
      return;
    }

    for (const leaf of leaves) {
      const view = leaf.view as unknown as OutlineViewLike;
      if (
        !view ||
        !view.containerEl ||
        typeof view.getHeadings !== "function" ||
        typeof view.update !== "function" ||
        this.patches.has(view)
      ) {
        continue;
      }

      if (this.patchView(view)) {
        try {
          view.update();
        } catch (error) {
          console.error(
            "Seamless Note Embed: failed to refresh the outline",
            error,
          );
        }
      }
    }
  }

  private pruneDetachedViews(): void {
    for (const [view, state] of Array.from(this.patches)) {
      if (view.containerEl?.isConnected) {
        continue;
      }

      this.restoreView(view, state);
      this.patches.delete(view);
    }
  }

  private patchView(view: OutlineViewLike): boolean {
    const ownGetHeadings = view.getHeadings;
    const ownUpdate = view.update;
    if (typeof ownGetHeadings !== "function" || typeof ownUpdate !== "function") {
      return false;
    }

    // Capture ownership before installing the patched methods. The core
    // outline keeps these on its prototype, so most views must have the own
    // properties deleted on restore rather than overwritten.
    const hadOwnGetHeadings = Object.prototype.hasOwnProperty.call(view, "getHeadings");
    const hadOwnUpdate = Object.prototype.hasOwnProperty.call(view, "update");
    const hadOwnCreateItemDom = Object.prototype.hasOwnProperty.call(view, "createItemDom");
    const hadOwnFindActiveHeading = Object.prototype.hasOwnProperty.call(
      view,
      "findActiveHeading",
    );

    const boundGetHeadings = ownGetHeadings.bind(view);
    const boundUpdate = ownUpdate.bind(view);

    const ownCreateItemDom = view.createItemDom;
    const boundCreateItemDom =
      typeof ownCreateItemDom === "function" ? ownCreateItemDom.bind(view) : null;

    const ownFindActiveHeading = view.findActiveHeading;
    const boundFindActiveHeading =
      typeof ownFindActiveHeading === "function" ? ownFindActiveHeading.bind(view) : null;

    const metaByKey = new Map<string, OutlineEmbedMeta>();

    const useFallbackHeadings = (): HeadingCache[] => {
      try {
        const original = boundGetHeadings();
        if (Array.isArray(original)) {
          // The metadata cache may already contain virtual headings from the
          // third-party integration. Keep their navigation metadata usable.
          for (const heading of original as OutlineHeading[]) {
            if (heading.aeih) {
              metaByKey.set(heading.aeih.key, heading.aeih);
            }
          }
          return original;
        }
      } catch (error) {
        console.error(
          "Seamless Note Embed: the core outline could not read its headings",
          error,
        );
      }

      return [];
    };

    const getHeadings = (): HeadingCache[] => {
      metaByKey.clear();

      if (!this.active || !this.getSettings().enabled) {
        return useFallbackHeadings();
      }

      const file = view.file;
      if (!file || file.extension !== "md") {
        return useFallbackHeadings();
      }

      try {
        const fileData = getFileData(this.app, file);
        if (!fileData) {
          return useFallbackHeadings();
        }

        const combined = buildOutlineHeadings(fileData, (path, sourcePath) => {
          try {
            const targetFile = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
            return targetFile ? getFileData(this.app, targetFile) : null;
          } catch (error) {
            console.error(
              "Seamless Note Embed: failed to resolve an embed for the outline",
              error,
            );
            return null;
          }
        });

        for (const heading of combined) {
          if (heading.aeih) {
            metaByKey.set(heading.aeih.key, heading.aeih);
          }
        }

        return combined;
      } catch (error) {
        console.error(
          "Seamless Note Embed: failed to build the outline",
          error,
        );
        return useFallbackHeadings();
      }
    };

    const update = (): unknown => {
      const result = boundUpdate();

      if (
        result &&
        typeof (result as { then?: unknown }).then === "function"
      ) {
        return Promise.resolve(result).then(() => decorateView(view));
      }

      decorateView(view);
      return result;
    };

    const createItemDom =
      boundCreateItemDom === null
        ? null
        : (heading: HeadingCache): OutlineItemLike => {
            const item = boundCreateItemDom(heading);
            decorateItem(item);
            return item;
          };

    const findActiveHeading =
      boundFindActiveHeading === null
        ? null
        : (markdownView: unknown): OutlineItemLike | null => {
            const active = boundFindActiveHeading(markdownView);
            const heading = active?.heading as OutlineHeading | undefined;

            // Fake headings all point at the embed's source line. Leaving one
            // highlighted would make the outline appear stuck while scrolling.
            return heading?.aeih ? null : active;
          };

    const findOutlineItem = (target: EventTarget | null): HTMLElement | null => {
      const element = target as HTMLElement | null;
      if (!element || typeof element.closest !== "function") {
        return null;
      }

      const item = element.closest<HTMLElement>(`[${OUTLINE_KEY_ATTRIBUTE}]`);
      return item && view.containerEl.contains(item) ? item : null;
    };

    const clickHandler = (event: MouseEvent): void => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }

      // Any new outline click supersedes an exact-scroll retry that is still
      // waiting for an embed to render.
      this.scroller.cancel();

      const element = event.target as HTMLElement | null;
      if (!element || typeof element.closest !== "function") {
        return;
      }

      if (element.closest(".collapse-icon, .tree-item-icon")) {
        return;
      }

      const item = findOutlineItem(element);
      if (!item) {
        return;
      }

      const key = item.getAttribute(OUTLINE_KEY_ATTRIBUTE);
      const meta = key ? metaByKey.get(key) : undefined;
      if (!meta) {
        return;
      }

      // The core click handler still runs and scrolls to the embed. This
      // second pass lands on the exact shifted heading once it is rendered.
      this.scheduleScrollToHeading(view, meta);
    };

    const mouseOverHandler = (event: MouseEvent): void => {
      if (findOutlineItem(event.target)) {
        // Prevent the core outline's hover preview from pointing at a heading
        // in the parent note that does not exist there.
        event.stopImmediatePropagation();
      }
    };

    const dragStartHandler = (event: DragEvent): void => {
      if (findOutlineItem(event.target)) {
        // Dragging a fake heading would make the core outline link to a
        // nonexistent heading in the parent note. Leave these items fixed.
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };

    Reflect.set(view, "getHeadings", getHeadings);
    Reflect.set(view, "update", update);
    if (createItemDom) {
      Reflect.set(view, "createItemDom", createItemDom);
    }
    if (findActiveHeading) {
      Reflect.set(view, "findActiveHeading", findActiveHeading);
    }

    view.containerEl.addEventListener("click", clickHandler, true);
    view.containerEl.addEventListener("mouseover", mouseOverHandler, true);
    view.containerEl.addEventListener("dragstart", dragStartHandler, true);

    this.patches.set(view, {
      hadOwnGetHeadings,
      originalOwnGetHeadings: ownGetHeadings,
      hadOwnUpdate,
      originalOwnUpdate: ownUpdate,
      hadOwnCreateItemDom,
      originalOwnCreateItemDom: ownCreateItemDom,
      hadOwnFindActiveHeading,
      originalOwnFindActiveHeading: ownFindActiveHeading,
      clickHandler,
      mouseOverHandler,
      dragStartHandler,
    });

    return true;
  }

  private restoreView(view: OutlineViewLike, state: PatchState): void {
    undecorateView(view);

    if (view.containerEl) {
      view.containerEl.removeEventListener("click", state.clickHandler, true);
      view.containerEl.removeEventListener("mouseover", state.mouseOverHandler, true);
      view.containerEl.removeEventListener("dragstart", state.dragStartHandler, true);
    }

    this.restoreProperty(
      view,
      "getHeadings",
      state.hadOwnGetHeadings,
      state.originalOwnGetHeadings,
    );
    this.restoreProperty(view, "update", state.hadOwnUpdate, state.originalOwnUpdate);
    this.restoreProperty(
      view,
      "createItemDom",
      state.hadOwnCreateItemDom,
      state.originalOwnCreateItemDom,
    );
    this.restoreProperty(
      view,
      "findActiveHeading",
      state.hadOwnFindActiveHeading,
      state.originalOwnFindActiveHeading,
    );
  }

  private restoreProperty(
    target: object,
    key: string,
    hadOwn: boolean,
    original: unknown,
  ): void {
    if (hadOwn) {
      Reflect.set(target, key, original);
    } else {
      Reflect.deleteProperty(target, key);
    }
  }

  private scheduleScrollToHeading(view: OutlineViewLike, meta: OutlineEmbedMeta): void {
    if (!this.active) {
      return;
    }

    this.scroller.schedule(view.file, meta.key);
  }
}
