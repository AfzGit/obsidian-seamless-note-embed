import type { App, EmbedCache, HeadingCache, TFile } from "obsidian";
import { resolveHeadingSubpath, splitLinktext } from "./embedTargets";
import { getRawFileCache } from "./rawMetadata";

/** Metadata needed to render or outline one embedded note. */
export interface EmbedData {
  file: TFile;
  path: string;
  headings: HeadingCache[];
  embeds: EmbedCache[];
}

export interface ResolvedEmbedData {
  data: EmbedData;
  /** Includes the leading `#`, or an empty string. */
  subpath: string;
}

/** Read the metadata cache entries relevant to embeds for one file. */
export function getFileData(app: App, file: TFile): EmbedData | null {
  if (!file || file.extension !== "md") {
    return null;
  }

  const cache = getRawFileCache(app, file);
  if (!cache) {
    return null;
  }

  return {
    file,
    path: file.path,
    headings: cache.headings ?? [],
    embeds: cache.embeds ?? [],
  };
}

/**
 * Resolve an embed link against the note that contains it.
 *
 * The returned data is the whole target note; callers that need a section can
 * pass its `subpath` to `filterSection`.
 */
export function resolveEmbedData(
  app: App,
  link: string,
  sourcePath: string,
): ResolvedEmbedData | null {
  const { path, subpath } = splitLinktext(link);
  const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath);

  if (!file) {
    return null;
  }

  const data = getFileData(app, file);
  return data ? { data, subpath } : null;
}

/**
 * Restrict a target note to the heading section rendered by a section embed.
 *
 * Whole-note embeds return everything. Block and footnote embeds, and
 * unresolvable heading subpaths, return no headings at all.
 */
export function filterSection(
  data: EmbedData,
  subpath: string,
): { headings: HeadingCache[]; embeds: EmbedCache[] } | null {
  if (!subpath) {
    return { headings: data.headings, embeds: data.embeds };
  }

  const range = resolveHeadingSubpath(data.headings, subpath);
  if (!range) {
    return { headings: [], embeds: [] };
  }

  return {
    headings: data.headings.filter((heading) => {
      const line = heading.position.start.line;
      return line >= range.startLine && line < range.endLine;
    }),
    embeds: data.embeds.filter((embed) => {
      const line = embed.position.start.line;
      return line >= range.startLine && line < range.endLine;
    }),
  };
}
