/**
 * Shared key used to connect an outline item to the rendered heading element
 * that the plugin shifted inside an embed.
 */
export const OUTLINE_KEY_ATTRIBUTE = "data-aeih-outline-key";

/**
 * Synthetic target line used by the filename heading. A real note never has a
 * negative line number, so this cannot collide with a source heading.
 */
export const FILENAME_HEADING_TARGET_LINE = -1;

export interface OutlineKeyParts {
  /** The note whose outline is being shown. */
  rootPath: string;
  /** Index of each note embed in the chain, in source order. */
  embedPath: readonly number[];
  /** The note that contains the heading. */
  targetPath: string;
  /** Zero-based source line of the heading in the target note. */
  targetLine: number;
}

/** Metadata attached to fake outline headings for navigation and styling. */
export interface OutlineEmbedMeta extends OutlineKeyParts {
  key: string;
  /** Original heading level in the embedded note. */
  originalLevel: number;
  /** Zero-based line of the top-level embed in the outline's note. */
  embedLine: number;
}

/**
 * Build a deterministic key. JSON quoting avoids collisions with characters
 * that can appear in vault paths.
 */
export function makeOutlineKey(parts: OutlineKeyParts): string {
  return JSON.stringify([parts.rootPath, parts.embedPath, parts.targetPath, parts.targetLine]);
}
