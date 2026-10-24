/**
 * Pure helpers for resolving Obsidian link text and heading subpaths.
 *
 * These are deliberately free of runtime Obsidian imports so they can be
 * unit-tested in Node. The logic mirrors Obsidian's own `parseLinktext`,
 * `stripHeading`, and `resolveSubpath` behavior.
 */

/** The parts of a heading cache entry that the outline algorithms need. */
export interface HeadingLike {
  heading: string;
  level: number;
  position: {
    start: {
      line: number;
    };
  };
}

/** The parts of an embed cache entry that the outline algorithms need. */
export interface EmbedLike {
  link: string;
  position: {
    start: {
      line: number;
    };
  };
}

export interface LinkParts {
  path: string;
  /** Includes the leading `#`, or an empty string. */
  subpath: string;
}

/**
 * Split `note#Heading|alias` into its file path and subpath.
 *
 * Obsidian's metadata cache normally stores embed links without an alias, but
 * stripping one here keeps the helper safe for hand-built cache objects.
 */
export function splitLinktext(link: string): LinkParts {
  const pipe = link.indexOf("|");
  const withoutAlias = pipe === -1 ? link : link.slice(0, pipe);
  const hash = withoutAlias.indexOf("#");

  return hash === -1
    ? { path: withoutAlias, subpath: "" }
    : { path: withoutAlias.slice(0, hash), subpath: withoutAlias.slice(hash) };
}

// This is the same punctuation set Obsidian's `stripHeading` removes.
const STRIP_HEADING_PUNCTUATION = /[!"#$%&()*+,.:;<=>?@^`{|}~/[\]\\\r\n]/g;

/**
 * Normalize a heading the way Obsidian does when resolving `[[note#Heading]]`.
 */
export function normalizeHeading(text: string): string {
  return text
    .replace(STRIP_HEADING_PUNCTUATION, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export interface HeadingRange {
  /** First line of the section (the heading itself). */
  startLine: number;
  /** First line after the section, or Infinity when it runs to EOF. */
  endLine: number;
}

/**
 * Resolve a heading subpath such as `#Heading` or `#Parent#Child` to the line
 * range rendered by an Obsidian section embed.
 *
 * Block (`#^block`) and footnote (`#[^note]`) subpaths do not contain a
 * heading section, so they return `null`.
 */
export function resolveHeadingSubpath(
  headings: readonly HeadingLike[],
  subpath: string,
): HeadingRange | null {
  const parts = subpath.split("#").filter((part) => part.length > 0);
  if (parts.length === 0) {
    return null;
  }

  if (parts[0].startsWith("^") || parts[0].startsWith("[^")) {
    return null;
  }

  let partIndex = 0;
  let matchedLevel = 0;
  let matchedIndex = -1;
  let nextIndex = -1;

  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];

    if (matchedIndex !== -1 && heading.level <= matchedLevel) {
      nextIndex = index;
      break;
    }

    if (
      matchedIndex === -1 &&
      heading.level > matchedLevel &&
      normalizeHeading(heading.heading) === normalizeHeading(parts[partIndex])
    ) {
      partIndex++;
      matchedLevel = heading.level;

      if (partIndex === parts.length) {
        matchedIndex = index;
      }
    }
  }

  if (matchedIndex === -1) {
    return null;
  }

  return {
    startLine: headings[matchedIndex].position.start.line,
    endLine: nextIndex === -1 ? Number.POSITIVE_INFINITY : headings[nextIndex].position.start.line,
  };
}

export interface HeadingMatch<T extends HeadingLike> {
  heading: T;
  index: number;
}

/**
 * Match a rendered heading element to the corresponding heading cache entry.
 *
 * The cursor-based fallback is intentional: rendered heading text can differ
 * from the cache text when inline Markdown is involved, but the order of the
 * headings still matches the source.
 */
export function findMatchingHeading<T extends HeadingLike>(
  headings: readonly T[],
  startIndex: number,
  text: string,
  level: number,
): HeadingMatch<T> | null {
  const normalized = normalizeHeading(text);
  const firstIndex = Math.max(0, startIndex);

  for (let index = firstIndex; index < headings.length; index++) {
    const heading = headings[index];
    if (heading.level === level && normalizeHeading(heading.heading) === normalized) {
      return { heading, index };
    }
  }

  if (firstIndex < headings.length) {
    const fallback = headings[firstIndex];
    if (fallback.level === level) {
      return { heading: fallback, index: firstIndex };
    }
  }

  return null;
}
