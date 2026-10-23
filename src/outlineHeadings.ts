import type { EmbedCache, HeadingCache } from "obsidian";
import { filterSection, type EmbedData } from "./embedData";
import { splitLinktext } from "./embedTargets";
import { shiftHeadingLevel } from "./headingMath";
import { makeOutlineKey, type OutlineEmbedMeta } from "./outlineKeys";

/** A heading cache entry, optionally marking a heading contributed by an embed. */
export interface OutlineHeading extends HeadingCache {
  aeih?: OutlineEmbedMeta;
}

export interface OutlineFileSource {
  path: string;
  headings: HeadingCache[];
  embeds: EmbedCache[];
}

/** Resolve a link path to the full metadata of the target note. */
export type ResolveOutlineFile = (path: string, sourcePath: string) => EmbedData | null;

interface OutlineEvent {
  kind: "heading" | "embed";
  line: number;
  heading?: HeadingCache;
  embed?: EmbedCache;
}

function mergeEvents(
  headings: readonly HeadingCache[],
  embeds: readonly EmbedCache[],
): OutlineEvent[] {
  const sortedHeadings = [...headings].sort(
    (left, right) =>
      left.position.start.line - right.position.start.line ||
      left.position.start.col - right.position.start.col,
  );
  const sortedEmbeds = [...embeds].sort(
    (left, right) =>
      left.position.start.line - right.position.start.line ||
      left.position.start.col - right.position.start.col,
  );

  const events: OutlineEvent[] = [
    ...sortedHeadings.map((heading) => ({
      kind: "heading" as const,
      line: heading.position.start.line,
      heading,
    })),
    ...sortedEmbeds.map((embed) => ({
      kind: "embed" as const,
      line: embed.position.start.line,
      embed,
    })),
  ];

  events.sort((left, right) => {
    if (left.line !== right.line) {
      return left.line - right.line;
    }

    if (left.kind !== right.kind) {
      // An embed on a heading line comes after that heading's text.
      return left.kind === "heading" ? -1 : 1;
    }

    const leftCol =
      left.kind === "heading"
        ? (left.heading?.position.start.col ?? 0)
        : (left.embed?.position.start.col ?? 0);
    const rightCol =
      right.kind === "heading"
        ? (right.heading?.position.start.col ?? 0)
        : (right.embed?.position.start.col ?? 0);

    return leftCol - rightCol;
  });

  return events;
}

function makeChainKey(path: string, subpath: string): string {
  return JSON.stringify([path, subpath]);
}

/**
 * Build the flat heading list consumed by Obsidian's core Outline view.
 *
 * The note's own headings keep their original levels. Every heading inside an
 * embed is shifted by the level of the nearest heading above that embed, and
 * nested embeds shift cumulatively. The returned fake headings point at the
 * top-level embed's source line so the core outline can navigate to the embed
 * without any changes to the vault.
 */
export function buildOutlineHeadings(
  root: OutlineFileSource,
  resolveFile: ResolveOutlineFile,
): OutlineHeading[] {
  const output: OutlineHeading[] = [];
  let currentLevel = 0;
  let noteEmbedIndex = 0;

  for (const event of mergeEvents(root.headings, root.embeds)) {
    if (event.kind === "heading" && event.heading) {
      // Keep the metadata-cache object itself. The core outline's Live Preview
      // active-heading lookup compares headings by identity.
      output.push(event.heading);
      currentLevel = event.heading.level;
      continue;
    }

    if (event.kind === "embed" && event.embed) {
      const counted = appendEmbeddedHeadings({
        embed: event.embed,
        sourcePath: root.path,
        parentLevel: currentLevel,
        rootEmbedLine: event.line,
        embedPath: [noteEmbedIndex],
        chain: [makeChainKey(root.path, "")],
        rootPath: root.path,
        output,
        resolveFile,
      });

      // Only resolved note embeds occupy an index in the DOM's embed path.
      // Images, PDFs, missing notes, and other non-note embeds must not shift
      // the keys of the note embeds after them.
      if (counted) {
        noteEmbedIndex += 1;
      }
    }
  }

  return output;
}

interface AppendEmbeddedOptions {
  embed: EmbedCache;
  /** The note that contains this embed. */
  sourcePath: string;
  /** Effective level of the nearest heading above the top-level embed. */
  parentLevel: number;
  /** Line of the top-level embed in the outline's note. */
  rootEmbedLine: number;
  embedPath: number[];
  /** Files and sections already visited, used to stop cycles. */
  chain: string[];
  rootPath: string;
  output: OutlineHeading[];
  resolveFile: ResolveOutlineFile;
}

/** Returns true when the target is a note, so it occupies a DOM embed index. */
function appendEmbeddedHeadings(options: AppendEmbeddedOptions): boolean {
  const {
    embed,
    sourcePath,
    parentLevel,
    rootEmbedLine,
    embedPath,
    chain,
    rootPath,
    output,
    resolveFile,
  } = options;

  const { path, subpath } = splitLinktext(embed.link);
  const target = resolveFile(path, sourcePath);
  if (!target) {
    return false;
  }

  const chainKey = makeChainKey(target.path, subpath);
  if (chain.includes(chainKey)) {
    return true;
  }

  const section = filterSection(target, subpath);
  if (!section) {
    return true;
  }

  let currentLevel = parentLevel;
  let nestedEmbedIndex = 0;

  for (const event of mergeEvents(section.headings, section.embeds)) {
    if (event.kind === "heading" && event.heading) {
      const original = event.heading;
      const level = shiftHeadingLevel(original.level, parentLevel);
      const meta: OutlineEmbedMeta = {
        key: makeOutlineKey({
          rootPath,
          embedPath,
          targetPath: target.path,
          targetLine: original.position.start.line,
        }),
        rootPath,
        embedPath: [...embedPath],
        targetPath: target.path,
        targetLine: original.position.start.line,
        originalLevel: original.level,
        embedLine: rootEmbedLine,
      };

      output.push({
        heading: original.heading,
        level,
        position: {
          // Clicking uses the start line, so navigate to the top-level embed.
          start: { line: rootEmbedLine, col: 0, offset: 0 },
          // The core outline's preview-mode "active heading" check uses the
          // end line. A fake heading must never win that check; the real
          // parent heading above the embed should stay highlighted instead.
          end: { line: Number.MAX_SAFE_INTEGER, col: 0, offset: 0 },
        },
        aeih: meta,
      });

      currentLevel = level;
      continue;
    }

    if (event.kind === "embed" && event.embed) {
      const counted = appendEmbeddedHeadings({
        embed: event.embed,
        sourcePath: target.path,
        parentLevel: currentLevel,
        rootEmbedLine,
        embedPath: [...embedPath, nestedEmbedIndex],
        chain: [...chain, chainKey],
        rootPath,
        output,
        resolveFile,
      });

      if (counted) {
        nestedEmbedIndex += 1;
      }
    }
  }

  return true;
}
