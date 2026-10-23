import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MetadataHeadingIntegration, getFileData } = require("./.tmp/metadataApi.cjs");

function heading(text, level, line) {
  return {
    heading: text,
    level,
    position: {
      start: { line, col: 0, offset: line * 100 },
      end: { line, col: text.length, offset: line * 100 + text.length },
    },
  };
}

function embed(link, line, col = 0) {
  return {
    link,
    original: `![[${link}]]`,
    position: {
      start: { line, col, offset: line * 100 + col },
      end: {
        line,
        col: col + link.length + 4,
        offset: line * 100 + col + link.length + 4,
      },
    },
  };
}

function makeApp(cacheByPath, filesByPath) {
  return {
    metadataCache: {
      getFileCache(file) {
        return cacheByPath.get(file.path) ?? null;
      },
      getFirstLinkpathDest(path) {
        return filesByPath.get(path) ?? null;
      },
    },
  };
}

function makeFixture() {
  const rootFile = { path: "fruits.md", extension: "md" };
  const appleFile = { path: "apple.md", extension: "md" };
  const rootHeadings = [
    heading("fruits 1", 1, 0),
    heading("fruits 2", 2, 4),
  ];
  const cacheByPath = new Map([
    [
      rootFile.path,
      {
        headings: rootHeadings,
        embeds: [embed("apple.md", 1)],
      },
    ],
    [
      appleFile.path,
      {
        headings: [heading("apple 1", 1, 0), heading("apple 2", 2, 2)],
        embeds: [],
      },
    ],
  ]);
  const filesByPath = new Map([["apple.md", appleFile]]);
  const app = makeApp(cacheByPath, filesByPath);

  return { rootFile, appleFile, rootHeadings, cacheByPath, app };
}

test("exposes shifted embedded headings through the metadata cache", () => {
  const { rootFile, rootHeadings, app } = makeFixture();
  const integration = new MetadataHeadingIntegration(app, () => ({
    enabled: true,
  }));

  integration.start();

  const cache = app.metadataCache.getFileCache(rootFile);
  assert.ok(cache);
  assert.equal(cache.headings.length, 4);
  assert.equal(cache.headings[0], rootHeadings[0]);
  assert.equal(cache.headings[3], rootHeadings[1]);

  const embedded = cache.headings[1];
  assert.equal(embedded.heading, "apple 1");
  assert.equal(embedded.level, 2);
  assert.ok(embedded.position.start.line > 1);
  assert.ok(embedded.position.start.line < 4);
  assert.equal(embedded.position.end.line, embedded.position.start.line);
  assert.ok(embedded.position.start.offset >= 2 ** 40);
  assert.equal(embedded.aeih.embedLine, 1);
  assert.equal(embedded.aeih.targetLine, 0);

  // Every embedded heading gets a distinct virtual position, even though they
  // all point at the same embed line in the parent note.
  const secondEmbedded = cache.headings[2];
  assert.notEqual(
    secondEmbedded.position.start.line,
    embedded.position.start.line,
  );
  assert.notEqual(
    secondEmbedded.position.start.offset,
    embedded.position.start.offset,
  );

  const byOffset = integration.resolveVirtualOffset(
    embedded.position.start.offset,
  );
  assert.ok(byOffset);
  assert.equal(byOffset.meta.key, embedded.aeih.key);
  assert.equal(byOffset.realLine, 1);

  const byLine = integration.resolveVirtualLine(
    rootFile,
    embedded.position.start.line,
  );
  assert.ok(byLine);
  assert.equal(byLine.meta.key, embedded.aeih.key);

  const bySubpath = integration.resolveVirtualSubpath(rootFile, "#apple 2");
  assert.ok(bySubpath);
  assert.equal(bySubpath.meta.key, secondEmbedded.aeih.key);
  assert.equal(integration.resolveVirtualSubpath(rootFile, "#fruits 1"), null);

  // The cache object is stable while the source cache is unchanged.
  assert.equal(app.metadataCache.getFileCache(rootFile), cache);

  // Internal reads must bypass the virtual headings, or an embed would be
  // counted twice by the outline and processor.
  const raw = getFileData(app, rootFile);
  assert.equal(raw.headings.length, 2);
  assert.equal(raw.headings[0], rootHeadings[0]);

  integration.stop();
  integration.destroy();

  assert.equal(app.metadataCache.getFileCache(rootFile).headings.length, 2);
});

test("leaves the metadata cache alone when the plugin is disabled", () => {
  const { rootFile, app } = makeFixture();
  const integration = new MetadataHeadingIntegration(app, () => ({
    enabled: false,
  }));

  integration.start();

  assert.equal(app.metadataCache.getFileCache(rootFile).headings.length, 2);
  assert.equal(integration.getCombinedHeadings(rootFile), null);

  integration.stop();
  integration.destroy();
});

test("removes the wrapper from a prototype-based cache", () => {
  const { rootFile, appleFile, cacheByPath } = makeFixture();
  const prototype = {
    getFileCache(file) {
      return cacheByPath.get(file.path) ?? null;
    },
    getFirstLinkpathDest(path) {
      return path === "apple.md" ? appleFile : null;
    },
  };
  const metadataCache = Object.create(prototype);
  const app = { metadataCache };
  const integration = new MetadataHeadingIntegration(app, () => ({
    enabled: true,
  }));

  integration.start();
  assert.equal(metadataCache.getFileCache(rootFile).headings.length, 4);

  integration.stop();
  integration.destroy();

  assert.equal(
    Object.prototype.hasOwnProperty.call(metadataCache, "getFileCache"),
    false,
  );
  assert.equal(metadataCache.getFileCache(rootFile).headings.length, 2);
});

test("rebuilds virtual headings after a target note changes", () => {
  const { rootFile, appleFile, cacheByPath, app } = makeFixture();
  const integration = new MetadataHeadingIntegration(app, () => ({
    enabled: true,
  }));

  integration.start();

  assert.equal(
    app.metadataCache.getFileCache(rootFile).headings[1].heading,
    "apple 1",
  );

  cacheByPath.set(appleFile.path, {
    headings: [heading("apple changed", 1, 0)],
    embeds: [],
  });
  integration.refresh();

  const cache = app.metadataCache.getFileCache(rootFile);
  assert.equal(cache.headings.length, 3);
  assert.equal(cache.headings[1].heading, "apple changed");

  integration.stop();
  integration.destroy();
});
