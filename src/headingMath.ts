export const MIN_HEADING_LEVEL = 1;
export const MAX_HEADING_LEVEL = 6;

/**
 * Keep a heading level inside the range HTML/Markdown supports.
 */
export function clampHeadingLevel(level: number): number {
  return Math.min(MAX_HEADING_LEVEL, Math.max(MIN_HEADING_LEVEL, Math.trunc(level)));
}

/**
 * An embed adds the level of its parent heading to every heading inside it.
 *
 * For example, a `# Heading` in a note embedded under `## Parent` becomes an
 * `### Heading`. Levels past six are clamped to six because HTML has no h7.
 */
export function shiftHeadingLevel(originalLevel: number, parentLevel: number): number {
  return clampHeadingLevel(originalLevel + parentLevel);
}

export function headingLevelFromTagName(tagName: string): number | null {
  const match = /^H([1-6])$/.exec(tagName.toUpperCase());
  return match ? Number(match[1]) : null;
}

/**
 * Live Preview renders heading lines with classes such as
 * `HyperMD-header-2` and `cm-header-2` instead of an actual `<h2>` element.
 */
export function headingLevelFromClasses(classes: Iterable<string>): number | null {
  for (const className of classes) {
    const match = /^(?:HyperMD-header|cm-header)-([1-6])$/.exec(className);
    if (match) {
      return Number(match[1]);
    }
  }

  return null;
}

/**
 * Fallback for an active Live Preview heading line, where the visible text may
 * still include the leading `#` characters.
 */
export function headingLevelFromText(text: string): number | null {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+|$)/.exec(text);
  return match ? match[1].length : null;
}
