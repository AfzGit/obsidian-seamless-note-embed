export interface HeadingAtLine {
  /** Zero-based line number. */
  line: number;
  level: number;
}

/**
 * Find the level of the closest heading at or before `line`.
 *
 * `line` is inclusive: an embed on a heading line is part of that heading's
 * rendered content, so the heading counts. Returns 0 when there is no such
 * heading, which means the embed is not nested under any heading of the
 * containing note.
 */
export function nearestPrecedingHeadingLevel(headings: readonly HeadingAtLine[], line: number): number {
  let level = 0;

  for (const heading of headings) {
    if (heading.line > line) {
      break;
    }
    level = heading.level;
  }

  return level;
}

/**
 * Extract Markdown headings from source lines.
 *
 * This handles ATX headings (`## Heading`), setext headings, fenced code
 * blocks, and YAML frontmatter. It is used in Live Preview, where off-screen
 * heading lines may not be present in the DOM because CodeMirror virtualizes
 * long documents. Reading the editor's source avoids that problem and also
 * reflects unsaved edits.
 */
export function parseHeadingLines(lines: readonly string[]): HeadingAtLine[] {
  const headings: HeadingAtLine[] = [];
  let fenceMarker: string | null = null;
  let inFrontmatter = false;
  let previousLineIsParagraph = false;
  let paragraphStart: number | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = index === 0 ? lines[index].replace(/^\uFEFF/, "") : lines[index];

    if (index === 0 && /^---[ \t]*$/.test(line)) {
      inFrontmatter = true;
      previousLineIsParagraph = false;
      paragraphStart = null;
      continue;
    }

    if (inFrontmatter) {
      if (/^(?:---|\.\.\.)[ \t]*$/.test(line)) {
        inFrontmatter = false;
      }
      continue;
    }

    const fence = /^ {0,3}(```+|~~~+)/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      if (fenceMarker === null) {
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        fenceMarker = null;
      }
      previousLineIsParagraph = false;
      paragraphStart = null;
      continue;
    }

    if (fenceMarker !== null) {
      continue;
    }

    const atx = /^ {0,3}(#{1,6})(?:[ \t]+|$)/.exec(line);
    if (atx) {
      headings.push({ line: index, level: atx[1].length });
      previousLineIsParagraph = false;
      paragraphStart = null;
      continue;
    }

    const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (setext && previousLineIsParagraph) {
      // A setext heading starts at the first line of the paragraph above the
      // underline. Metadata uses that start line, and an embed on any of the
      // heading's text lines is part of the heading.
      headings.push({
        line: paragraphStart ?? index,
        level: setext[1][0] === "=" ? 1 : 2,
      });
      previousLineIsParagraph = false;
      paragraphStart = null;
      continue;
    }

    const isParagraph = line.trim().length > 0;
    if (isParagraph && !previousLineIsParagraph) {
      paragraphStart = index;
    } else if (!isParagraph) {
      paragraphStart = null;
    }
    previousLineIsParagraph = isParagraph;
  }

  return headings;
}
