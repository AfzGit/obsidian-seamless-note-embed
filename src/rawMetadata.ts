import type { App, CachedMetadata, TFile } from "obsidian";

export type RawFileCacheGetter = (file: TFile) => CachedMetadata | null;

const rawGetters = new WeakMap<App, RawFileCacheGetter>();

/** Register the unwrapped metadata-cache reader for an app instance. */
export function registerRawFileCache(app: App, getter: RawFileCacheGetter): void {
  rawGetters.set(app, getter);
}

/** Remove a registration, but only when it still points at the same getter. */
export function unregisterRawFileCache(app: App, getter: RawFileCacheGetter): void {
  if (rawGetters.get(app) === getter) {
    rawGetters.delete(app);
  }
}

/**
 * Read the metadata cache without any virtual headings this plugin adds.
 *
 * The outline builder must always see the real cache. Otherwise embedded
 * headings would be picked up a second time as if they were written in the
 * parent note.
 */
export function getRawFileCache(app: App, file: TFile): CachedMetadata | null {
  const getter = rawGetters.get(app);
  return getter ? getter(file) : app.metadataCache.getFileCache(file);
}
