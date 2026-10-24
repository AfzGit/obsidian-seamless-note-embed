import type { App, TFile } from "obsidian";
import { OUTLINE_KEY_ATTRIBUTE } from "./outlineKeys";

interface MarkdownViewLike {
  file?: TFile | null;
  contentEl?: HTMLElement;
  getViewType?: () => string;
}

function isMarkdownViewForFile(
  view: MarkdownViewLike | null | undefined,
  file: TFile,
): boolean {
  return (
    !!view && view.getViewType?.() === "markdown" && view.file?.path === file.path
  );
}

/** Find the open markdown view that is showing `file`. */
export function findMarkdownViewForFile(
  app: App,
  file: TFile,
): MarkdownViewLike | null {
  const recentLeaf = app.workspace.getMostRecentLeaf?.();
  const activeView = recentLeaf?.view as MarkdownViewLike | undefined;
  if (activeView && isMarkdownViewForFile(activeView, file)) {
    return activeView;
  }

  let match: MarkdownViewLike | null = null;
  app.workspace.iterateAllLeaves((leaf) => {
    if (match) {
      return;
    }

    const view = leaf.view as unknown as MarkdownViewLike;
    if (isMarkdownViewForFile(view, file)) {
      match = view;
    }
  });

  return match;
}

/** Find the rendered heading that belongs to an outline entry. */
export function findHeadingElement(
  container: HTMLElement,
  key: string,
): HTMLElement | null {
  const elements = container.querySelectorAll<HTMLElement>(
    `[${OUTLINE_KEY_ATTRIBUTE}]`,
  );

  let fallback: HTMLElement | null = null;
  for (const element of Array.from(elements)) {
    if (element.getAttribute(OUTLINE_KEY_ATTRIBUTE) !== key) {
      continue;
    }

    // Obsidian can keep a hidden rendered copy of the same embed around while
    // switching modes. Prefer the copy that is actually laid out; otherwise
    // scrollIntoView() targets a zero-sized element and does nothing.
    if (element.getClientRects().length > 0) {
      return element;
    }

    fallback ??= element;
  }

  return fallback;
}

/**
 * Scroll to a rendered embedded heading, retrying while Obsidian renders the
 * embed. A new request supersedes any retry that is still waiting.
 */
export class HeadingScroller {
  private token = 0;

  constructor(private readonly app: App) {}

  cancel(): void {
    this.token += 1;
  }

  schedule(
    file: TFile | null | undefined,
    key: string,
    preferredView?: MarkdownViewLike | null,
  ): void {
    if (!file) {
      return;
    }

    const token = ++this.token;
    let attempts = 0;

    const tryScroll = (): void => {
      if (token !== this.token) {
        return;
      }

      const markdownView = preferredView?.contentEl
        ? preferredView
        : findMarkdownViewForFile(this.app, file);
      const contentEl = markdownView?.contentEl;
      if (contentEl) {
        const heading = findHeadingElement(contentEl, key);
        if (heading) {
          heading.scrollIntoView({ block: "center", behavior: "smooth" });
          return;
        }
      }

      if (attempts++ < 40) {
        window.setTimeout(tryScroll, 50);
      }
    };

    window.setTimeout(tryScroll, 0);
  }
}
