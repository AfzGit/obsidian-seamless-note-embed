export interface HeadingAtLine {
  /** Zero-based line number. */
  line: number;
  level: number;
}

/**
 * Find the level of the closest heading before `line`.
 *
 * `line` is exclusive: a heading on the same line as the embed does not count.
 * Returns 0 when there is no preceding heading, which means the embed is not
 * nested under any heading of the containing note.
 */
export function nearestPrecedingHeadingLevel(headings: readonly HeadingAtLine[], line: number): number {
  let level = 0;

  for (const heading of headings) {
    if (heading.line >= line) {
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

  for (let index = 0; index < lines.length; index++) {
    const line = index === 0 ? lines[index].replace(/^\uFEFF/, "") : lines[index];

    if (index === 0 && /^---[ \t]*$/.test(line)) {
      inFrontmatter = true;
      previousLineIsParagraph = false;
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
      continue;
    }

    if (fenceMarker !== null) {
      continue;
    }

    const atx = /^ {0,3}(#{1,6})(?:[ \t]+|$)/.exec(line);
    if (atx) {
      headings.push({ line: index, level: atx[1].length });
      previousLineIsParagraph = false;
      continue;
    }

    const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (setext && previousLineIsParagraph) {
      headings.push({ line: index, level: setext[1][0] === "=" ? 1 : 2 });
      previousLineIsParagraph = false;
      continue;
    }

    previousLineIsParagraph = line.trim().length > 0;
  }

  return headings;
}
