import type { App, CachedMetadata, TFile } from "obsidian";
import { resolveHeadingSubpath } from "./embedTargets";
import {
  getRawFileCache,
  registerRawFileCache,
  unregisterRawFileCache,
  type RawFileCacheGetter,
} from "./rawMetadata";
import {
  buildOutlineHeadings,
  type OutlineFileSource,
  type OutlineHeading,
} from "./outlineHeadings";
import type { OutlineEmbedMeta } from "./outlineKeys";

export interface MetadataHeadingSettings {
  /** Master switch. When false the wrapper returns the real cache. */
  enabled: boolean;
  /** Shift embedded heading levels. Defaults to true. */
  shift?: boolean;
}

/**
 * A synthetic heading's position in the parent note.
 *
 * The line is deliberately fractional so every embedded heading has a unique
 * value that still sorts between the embed and the next real heading. The
 * offset is a stable virtual token, outside the range of real file offsets.
 * The navigation bridge translates either token back to the embed's real line
 * before Obsidian or another plugin tries to use it.
 */
export interface VirtualHeadingToken {
  file: TFile;
  filePath: string;
  meta: OutlineEmbedMeta;
  heading: string;
  level: number;
  line: number;
  col: number;
  offset: number;
  endOffset: number;
  realLine: number;
}

interface AugmentedCacheResult {
  cache: CachedMetadata;
  combined: OutlineHeading[];
}

/** Real files never reach this size, so this range is safe for virtual offsets. */
const VIRTUAL_OFFSET_BASE = 2 ** 40;
/** Keep each synthetic heading's offset range separate from its neighbours. */
const VIRTUAL_OFFSET_STRIDE = 2 ** 16;

interface CacheEntry {
  raw: CachedMetadata;
  signature: string;
  result: AugmentedCacheResult | null;
}

/**
 * A lightweight fingerprint of the parts of the cache that affect embedded
 * headings. Obsidian normally replaces the cache object on edits, but this
 * also catches in-place mutations.
 */
function makeSignature(cache: CachedMetadata): string {
  const parts: unknown[] = [];

  for (const heading of cache.headings ?? []) {
    parts.push(["h", heading.level, heading.position.start.line, heading.heading]);
  }

  for (const embed of cache.embeds ?? []) {
    parts.push(["e", embed.position.start.line, embed.link]);
  }

  return JSON.stringify(parts);
}

function hashText(text: string): number {
  // FNV-1a, kept unsigned. The result only seeds a virtual offset; the
  // registry resolves collisions.
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Replace a synthetic heading's placeholder position with its unique virtual
 * token. Real headings are returned untouched.
 */
function toMetadataHeading(
  heading: OutlineHeading,
  token: VirtualHeadingToken,
): OutlineHeading {
  return {
    ...heading,
    position: {
      start: {
        line: token.line,
        col: token.col,
        offset: token.offset,
      },
      end: {
        line: token.line,
        col: token.col + heading.heading.length,
        offset: token.endOffset,
      },
    },
  };
}

/**
 * Makes embedded-note headings visible through `metadataCache.getFileCache`.
 *
 * Quiet Outline, Subtle TOC, and other outline plugins read their headings
 * from the metadata cache rather than from Obsidian's built-in Outline view.
 * Returning a shallow cache copy with the extra headings lets those plugins
 * render them without changing anything on disk.
 *
 * The wrapper is intentionally transparent to this plugin's own code: all
 * internal reads go through `getRawFileCache`, so an embed is never counted
 * twice.
 */
export class MetadataHeadingIntegration {
  private cache = new WeakMap<TFile, CacheEntry>();
  private active = false;
  private destroyed = false;
  private building = 0;
  private originalGetFileCache: RawFileCacheGetter | null = null;
  private installedGetFileCache: unknown = null;
  private hadOwnGetFileCache = false;
  private originalOwnGetFileCache: unknown = null;
  private tokensByOffset = new Map<number, VirtualHeadingToken>();
  private tokensByLine = new Map<string, Map<number, VirtualHeadingToken>>();
  private tokensByFile = new Map<string, VirtualHeadingToken[]>();

  constructor(
    private readonly app: App,
    private readonly getSettings: () => MetadataHeadingSettings,
  ) {}

  start(): void {
    if (this.destroyed || this.active) {
      return;
    }

    const metadataCache = this.app.metadataCache as unknown as {
      getFileCache: RawFileCacheGetter;
    };
    const ownGetFileCache = metadataCache.getFileCache;
    if (typeof ownGetFileCache !== "function") {
      return;
    }

    this.hadOwnGetFileCache = Object.prototype.hasOwnProperty.call(
      metadataCache,
      "getFileCache",
    );
    this.originalOwnGetFileCache = ownGetFileCache;

    const original = ownGetFileCache.bind(metadataCache);
    this.originalGetFileCache = original;

    const getFileCache = (file: TFile): CachedMetadata | null => {
      const cache = original(file);

      if (
        !cache ||
        !this.active ||
        this.destroyed ||
        this.building > 0 ||
        !this.getSettings().enabled ||
        !file ||
        file.extension !== "md"
      ) {
        return cache;
      }

      try {
        return this.getAugmentedCache(file, cache)?.cache ?? cache;
      } catch (error) {
        console.error(
          "Seamless Note Embed: failed to augment the metadata cache",
          error,
        );
        return cache;
      }
    };

    this.installedGetFileCache = getFileCache;
    if (!Reflect.set(metadataCache, "getFileCache", getFileCache)) {
      this.installedGetFileCache = null;
      return;
    }

    registerRawFileCache(this.app, original);
    this.active = true;
    this.refresh();
  }

  stop(): void {
    if (!this.active) {
      return;
    }

    const metadataCache = this.app.metadataCache as unknown as {
      getFileCache: unknown;
    };

    // If another plugin wrapped the method after us, leave its wrapper in
    // place. Removing our raw getter would then make internal reads recurse
    // through that wrapper, so keep it registered in that case.
    if (Reflect.get(metadataCache, "getFileCache") === this.installedGetFileCache) {
      if (this.hadOwnGetFileCache) {
        Reflect.set(metadataCache, "getFileCache", this.originalOwnGetFileCache);
      } else {
        Reflect.deleteProperty(metadataCache, "getFileCache");
      }

      if (this.originalGetFileCache) {
        unregisterRawFileCache(this.app, this.originalGetFileCache);
      }
    }

    this.active = false;
    this.originalGetFileCache = null;
    this.installedGetFileCache = null;
    this.refresh();
  }

  destroy(): void {
    this.stop();
    this.destroyed = true;
  }

  /** Drop cached augmented caches after a file or its embeds changed. */
  refresh(): void {
    // WeakMap has no clear(), so replace it.
    this.cache = new WeakMap();
    this.tokensByOffset.clear();
    this.tokensByLine.clear();
    this.tokensByFile.clear();
  }

  onSettingsChanged(): void {
    this.refresh();
  }

  /** Resolve a virtual offset embedded in a synthetic heading's position. */
  resolveVirtualOffset(offset: number): VirtualHeadingToken | null {
    if (!this.active || this.destroyed || offset < VIRTUAL_OFFSET_BASE) {
      return null;
    }

    const exact = this.tokensByOffset.get(offset);
    if (exact) {
      return exact;
    }

    // Some callers add the heading length or otherwise use an offset inside
    // the synthetic range. Accept the containing token as a fallback.
    for (const token of this.tokensByOffset.values()) {
      if (offset >= token.offset && offset <= token.endOffset) {
        return token;
      }
    }

    return null;
  }

  /** Resolve a virtual line in one note. */
  resolveVirtualLine(
    file: TFile | null | undefined,
    line: number,
  ): VirtualHeadingToken | null {
    if (!this.active || this.destroyed || !file) {
      return null;
    }

    return this.tokensByLine.get(file.path)?.get(line) ?? null;
  }

  /**
   * Resolve a heading subpath such as `#apple 2` to a virtual heading. This is
   * used for normal Obsidian links, not only outline-plugin navigation.
   */
  resolveVirtualSubpath(
    file: TFile | null | undefined,
    subpath: string | null | undefined,
  ): VirtualHeadingToken | null {
    if (!this.active || this.destroyed || !file || !subpath) {
      return null;
    }

    const raw = getRawFileCache(this.app, file);
    if (!raw) {
      return null;
    }

    try {
      const augmented = this.getAugmentedCache(file, raw);
      if (!augmented) {
        return null;
      }

      const range = resolveHeadingSubpath(
        augmented.cache.headings ?? [],
        subpath,
      );
      return range
        ? this.resolveVirtualLine(file, range.startLine)
        : null;
    } catch (error) {
      console.error(
        "Seamless Note Embed: failed to resolve an embedded heading link",
        error,
      );
      return null;
    }
  }

  /**
   * The combined heading list for a note, including synthetic headings.
   * Used by third-party outline integrations to attach navigation metadata.
   */
  getCombinedHeadings(
    file: TFile | null | undefined,
  ): OutlineHeading[] | null {
    if (
      !this.active ||
      !file ||
      file.extension !== "md" ||
      !this.getSettings().enabled
    ) {
      return null;
    }

    const cache = getRawFileCache(this.app, file);
    if (!cache) {
      return null;
    }

    try {
      const augmented = this.getAugmentedCache(file, cache);
      if (augmented) {
        return augmented.combined;
      }
    } catch (error) {
      console.error(
        "Seamless Note Embed: failed to build headings for a third-party outline",
        error,
      );
    }

    return cache.headings ?? [];
  }

  private getAugmentedCache(
    file: TFile,
    raw: CachedMetadata,
  ): AugmentedCacheResult | null {
    if (!raw.embeds?.length) {
      return null;
    }

    const signature = makeSignature(raw);
    const cached = this.cache.get(file);
    if (cached && cached.raw === raw && cached.signature === signature) {
      return cached.result;
    }

    const realCombined = this.buildHeadings(file, raw);
    const combined = this.virtualizeHeadings(file, realCombined);
    const hasEmbeddedHeadings = combined.some((heading) => heading.aeih);

    const result: AugmentedCacheResult | null = hasEmbeddedHeadings
      ? {
          cache: {
            ...raw,
            headings: combined,
          },
          combined,
        }
      : null;

    this.cache.set(file, { raw, signature, result });
    return result;
  }

  /**
   * Give every synthetic heading a unique position. The fractional line keeps
   * outline order intact, while the virtual offset gives offset-based
   * navigation (for example Another Quick Switcher's header search) a token it
   * can resolve exactly.
   */
  private virtualizeHeadings(
    file: TFile,
    headings: OutlineHeading[],
  ): OutlineHeading[] {
    this.removeTokensForFile(file.path);

    const groups = new Map<number, OutlineHeading[]>();
    for (const heading of headings) {
      if (!heading.aeih) {
        continue;
      }

      const group = groups.get(heading.aeih.embedLine);
      if (group) {
        group.push(heading);
      } else {
        groups.set(heading.aeih.embedLine, [heading]);
      }
    }

    if (groups.size === 0) {
      return headings;
    }

    const tokens = new Map<OutlineHeading, VirtualHeadingToken>();
    for (const [embedLine, group] of groups) {
      for (let index = 0; index < group.length; index++) {
        const heading = group[index];
        const meta = heading.aeih;
        if (!meta) {
          continue;
        }

        const line = embedLine + (index + 1) / (group.length + 1);
        const col = index;
        const offset = this.allocateOffset(file.path, meta.key);
        const token: VirtualHeadingToken = {
          file,
          filePath: file.path,
          meta,
          heading: heading.heading,
          level: heading.level,
          line,
          col,
          offset,
          endOffset: offset + heading.heading.length,
          realLine: embedLine,
        };

        tokens.set(heading, token);
        this.registerToken(token);
      }
    }

    return headings.map((heading) => {
      const token = tokens.get(heading);
      return token ? toMetadataHeading(heading, token) : heading;
    });
  }

  private allocateOffset(filePath: string, key: string): number {
    let offset =
      VIRTUAL_OFFSET_BASE +
      hashText(`${filePath}\u0000${key}`) * VIRTUAL_OFFSET_STRIDE;
    while (this.tokensByOffset.has(offset)) {
      offset += VIRTUAL_OFFSET_STRIDE;
    }
    return offset;
  }

  private registerToken(token: VirtualHeadingToken): void {
    this.tokensByOffset.set(token.offset, token);

    let byLine = this.tokensByLine.get(token.filePath);
    if (!byLine) {
      byLine = new Map();
      this.tokensByLine.set(token.filePath, byLine);
    }
    byLine.set(token.line, token);

    const fileTokens = this.tokensByFile.get(token.filePath);
    if (fileTokens) {
      fileTokens.push(token);
    } else {
      this.tokensByFile.set(token.filePath, [token]);
    }
  }

  private removeTokensForFile(filePath: string): void {
    const fileTokens = this.tokensByFile.get(filePath);
    if (!fileTokens) {
      return;
    }

    const byLine = this.tokensByLine.get(filePath);
    for (const token of fileTokens) {
      this.tokensByOffset.delete(token.offset);
      byLine?.delete(token.line);
    }

    if (byLine && byLine.size === 0) {
      this.tokensByLine.delete(filePath);
    }
    this.tokensByFile.delete(filePath);
  }

  private buildHeadings(
    file: TFile,
    raw: CachedMetadata,
  ): OutlineHeading[] {
    const source: OutlineFileSource = {
      path: file.path,
      headings: raw.headings ?? [],
      embeds: raw.embeds ?? [],
    };

    this.building += 1;
    try {
      return buildOutlineHeadings(
        source,
        (path, sourcePath) => {
          try {
            const target = this.app.metadataCache.getFirstLinkpathDest(
              path,
              sourcePath,
            );
            if (!target || target.extension !== "md") {
              return null;
            }

            const targetCache = getRawFileCache(this.app, target);
            if (!targetCache) {
              return null;
            }

            return {
              file: target,
              path: target.path,
              headings: targetCache.headings ?? [],
              embeds: targetCache.embeds ?? [],
            };
          } catch (error) {
            console.error(
              "Seamless Note Embed: failed to resolve an embed for the outline",
              error,
            );
            return null;
          }
        },
        { shift: this.getSettings().shift ?? true },
      );
    } catch (error) {
      console.error(
        "Seamless Note Embed: failed to build embedded outline headings",
        error,
      );
      return raw.headings ?? [];
    } finally {
      this.building -= 1;
    }
  }
}
