import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
dom.window.document.win = dom.window;
dom.window.createEl = (tag) => dom.window.document.createElement(tag);
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

const require = createRequire(import.meta.url);
const { EmbedHeadingProcessor, findPrintRoot, findRenderRoot } = require("./.tmp/processor.cjs");

const settings = { enabled: true, livePreview: true };

function createApp() {
  return {
    workspace: {
      activeLeaf: null,
      iterateAllLeaves() {},
    },
  };
}

function makeProcessor(app = createApp(), currentSettings = settings) {
  return new EmbedHeadingProcessor(app, () => currentSettings);
}

function headingLevels(container) {
  return Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((heading) => ({
    level: Number(heading.tagName.slice(1)),
    text: heading.textContent,
  }));
}

function setDocument(body) {
  document.body.innerHTML = body;
}

function cacheHeading(text, level, line) {
  return {
    heading: text,
    level,
    position: {
      start: { line, col: 0, offset: line * 100 },
      end: { line, col: text.length, offset: line * 100 + text.length },
    },
  };
}

function cacheEmbed(link, line, col = 0) {
  return {
    link,
    position: {
      start: { line, col, offset: line * 100 + col },
      end: { line, col: col + link.length + 4, offset: line * 100 + col + link.length + 4 },
    },
  };
}

/**
 * Build an app whose metadata cache knows the rendered root note and any
 * embedded notes. The root note is always `fruits.md`, matching the outline
 * key assertions used below.
 */
function makeCachedApp(root, rootCache, files) {
  const rootFile = { path: "fruits.md", extension: "md" };
  const fileByPath = new Map();
  const cacheByPath = new Map([[rootFile.path, rootCache]]);
  for (const [path, cache] of Object.entries(files)) {
    fileByPath.set(path, { path, extension: "md" });
    cacheByPath.set(path, cache);
  }

  const view = {
    file: rootFile,
    getViewType: () => "markdown",
    containerEl: root,
  };

  return {
    workspace: {
      activeLeaf: null,
      iterateAllLeaves(callback) {
        callback({ view });
      },
    },
    metadataCache: {
      getFileCache: (file) => cacheByPath.get(file.path) ?? null,
      getFirstLinkpathDest: (path) => fileByPath.get(path) ?? null,
    },
  };
}

/**
 * Build an app for a detached render root, such as Better Export PDF's print
 * document. There is no MarkdownView, so the root file is resolved from the
 * vault by the source path passed to the processor.
 */
function makeDetachedApp(rootPath, rootCache, files) {
  const fileByPath = new Map([[rootPath, { path: rootPath, extension: "md" }]]);
  const cacheByPath = new Map([[rootPath, rootCache]]);
  for (const [path, cache] of Object.entries(files)) {
    fileByPath.set(path, { path, extension: "md" });
    cacheByPath.set(path, cache);
  }

  return {
    workspace: {
      activeLeaf: null,
      iterateAllLeaves() {},
    },
    vault: {
      getAbstractFileByPath: (path) => fileByPath.get(path) ?? null,
    },
    metadataCache: {
      getFileCache: (file) => cacheByPath.get(file.path) ?? null,
      getFirstLinkpathDest: (path) => fileByPath.get(path) ?? null,
    },
  };
}

function filenameSettings(overrides = {}) {
  return { enabled: true, livePreview: true, filenameAsHeading: true, ...overrides };
}

function outlineKeys(container) {
  return Array.from(container.querySelectorAll("[data-aeih-outline-key]")).map(
    (heading) => JSON.parse(heading.getAttribute("data-aeih-outline-key")),
  );
}

test("shifts headings by the parent heading level", () => {
  setDocument(`
    <div class="markdown-preview-view">
      <h1>fruits 1</h1>
      <div class="markdown-embed">
        <div class="markdown-embed-content">
          <h1>apple 1</h1>
          <h2>apple 2</h2>
          <h3>apple 3</h3>
        </div>
      </div>
      <h2>fruits 2</h2>
      <div class="markdown-embed">
        <div class="markdown-embed-content">
          <h1>orange 1</h1>
          <h2>orange 2</h2>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".markdown-preview-view");
  const processor = makeProcessor();
  processor.refresh(root);

  assert.deepEqual(headingLevels(root), [
    { level: 1, text: "fruits 1" },
    { level: 2, text: "apple 1" },
    { level: 3, text: "apple 2" },
    { level: 4, text: "apple 3" },
    { level: 2, text: "fruits 2" },
    { level: 3, text: "orange 1" },
    { level: 4, text: "orange 2" },
  ]);

  // Only headings inside embeds are tracked; the parent note is untouched.
  assert.equal(root.querySelectorAll("[data-aeih-original-level]").length, 5);

  processor.destroy();
});

test("uses Reading View source sections when the parent heading is virtualized", () => {
  setDocument(`
    <div class="markdown-preview-view" id="root">
      <div class="el-p">
        <div class="markdown-embed" src="apple.md">
          <div class="markdown-embed-content">
            <h1>Summary</h1>
            <h1>Notes</h1>
          </div>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector("#root");
  const embedSection = root.querySelector(".el-p");
  const virtualizedHeadingSection = document.createElement("div");
  const rootFile = { path: "fruits.md", extension: "md" };
  const appleFile = { path: "apple.md", extension: "md" };
  const cacheByPath = new Map([
    [
      rootFile.path,
      {
        // The renderer sections, not the visible DOM, know that this heading
        // exists above the embed.
        headings: [],
        embeds: [cacheEmbed("apple.md", 6)],
      },
    ],
    [
      appleFile.path,
      {
        headings: [cacheHeading("Summary", 1, 0), cacheHeading("Notes", 1, 82)],
        embeds: [],
      },
    ],
  ]);

  const view = {
    file: rootFile,
    getViewType: () => "markdown",
    containerEl: root,
    previewMode: {
      renderer: {
        sections: [
          { start: { line: 5 }, level: 1, el: virtualizedHeadingSection },
          { start: { line: 6 }, level: 7, el: embedSection },
        ],
      },
    },
  };

  const app = {
    workspace: {
      activeLeaf: null,
      iterateAllLeaves(callback) {
        callback({ view });
      },
    },
    metadataCache: {
      getFileCache: (file) => cacheByPath.get(file.path) ?? null,
      getFirstLinkpathDest: (path) => (path === "apple.md" ? appleFile : null),
    },
  };

  const processor = makeProcessor(app);
  processor.refresh(root);

  assert.deepEqual(headingLevels(root), [
    { level: 2, text: "Summary" },
    { level: 2, text: "Notes" },
  ]);
  assert.equal(root.querySelector(".markdown-embed").getAttribute("data-aeih-shift"), "1");
  assert.deepEqual(
    Array.from(root.querySelectorAll("[data-aeih-outline-key]")).map((heading) =>
      JSON.parse(heading.getAttribute("data-aeih-outline-key")),
    ),
    [
      ["fruits.md", [0], "apple.md", 0],
      ["fruits.md", [0], "apple.md", 82],
    ],
  );

  processor.destroy();
});

test("does not shift an embed that appears before any heading", () => {
  setDocument(`
    <div class="markdown-preview-view">
      <div class="markdown-embed">
        <div class="markdown-embed-content">
          <h1>early</h1>
          <h2>early sub</h2>
        </div>
      </div>
      <h1>later</h1>
    </div>
  `);

  const root = document.querySelector(".markdown-preview-view");
  const processor = makeProcessor();
  processor.refresh(root);

  assert.deepEqual(headingLevels(root), [
    { level: 1, text: "early" },
    { level: 2, text: "early sub" },
    { level: 1, text: "later" },
  ]);

  processor.destroy();
});

test("chains shifts through nested embeds", () => {
  setDocument(`
    <div class="markdown-preview-view">
      <h1>outer</h1>
      <div class="markdown-embed">
        <div class="markdown-embed-content">
          <h1>inner</h1>
          <h2>inner sub</h2>
          <div class="markdown-embed">
            <div class="markdown-embed-content">
              <h1>nested</h1>
              <h2>nested sub</h2>
            </div>
          </div>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".markdown-preview-view");
  const processor = makeProcessor();
  processor.refresh(root);

  assert.deepEqual(headingLevels(root), [
    { level: 1, text: "outer" },
    { level: 2, text: "inner" },
    { level: 3, text: "inner sub" },
    { level: 4, text: "nested" },
    { level: 5, text: "nested sub" },
  ]);

  processor.destroy();
});

test("adds the filename as a heading and shifts embedded headings below it", () => {
  setDocument(`
    <div class="markdown-preview-view">
      <h1>Main H1 Heading</h1>
      <div class="markdown-embed" src="note.md">
        <div class="markdown-embed-content">
          <h1>H1 Heading</h1>
          <h2>H2 Heading</h2>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".markdown-preview-view");
  const app = makeCachedApp(
    root,
    {
      headings: [cacheHeading("Main H1 Heading", 1, 0)],
      embeds: [cacheEmbed("note.md", 1)],
    },
    {
      "note.md": {
        headings: [cacheHeading("H1 Heading", 1, 0), cacheHeading("H2 Heading", 2, 2)],
        embeds: [],
      },
    },
  );

  const processor = makeProcessor(app, filenameSettings());
  processor.refresh(root);

  assert.deepEqual(headingLevels(root), [
    { level: 1, text: "Main H1 Heading" },
    { level: 2, text: "note" },
    { level: 3, text: "H1 Heading" },
    { level: 4, text: "H2 Heading" },
  ]);

  const filename = root.querySelector("[data-aeih-filename-heading]");
  assert.ok(filename);
  assert.equal(filename.textContent, "note");
  assert.equal(filename.tagName, "H2");
  assert.equal(filename.parentElement.classList.contains("markdown-embed-content"), true);

  // The synthetic heading must not consume a source heading, so the outline
  // key uses the reserved line sentinel.
  assert.deepEqual(outlineKeys(root), [
    ["fruits.md", [0], "note.md", -1],
    ["fruits.md", [0], "note.md", 0],
    ["fruits.md", [0], "note.md", 2],
  ]);

  processor.destroy();
});

test("inserts the filename heading inside the embed preview sizer", () => {
  setDocument(`
    <div class="markdown-preview-view">
      <h1>Parent</h1>
      <div class="markdown-embed" src="note.md">
        <div class="markdown-embed-content">
          <div class="markdown-preview-view markdown-rendered">
            <div class="markdown-preview-sizer">
              <div class="markdown-preview-pusher"></div>
              <div class="markdown-preview-section">
                <h1>H1 Heading</h1>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".markdown-preview-view");
  const app = makeCachedApp(
    root,
    {
      headings: [cacheHeading("Parent", 1, 0)],
      embeds: [cacheEmbed("note.md", 1)],
    },
    {
      "note.md": {
        headings: [cacheHeading("H1 Heading", 1, 0)],
        embeds: [],
      },
    },
  );

  const processor = makeProcessor(app, filenameSettings());
  processor.refresh(root);

  const filename = root.querySelector("[data-aeih-filename-heading]");
  assert.ok(filename);
  assert.equal(
    filename.parentElement.classList.contains("markdown-preview-sizer"),
    true,
  );
  assert.equal(
    filename.previousElementSibling.classList.contains("markdown-preview-pusher"),
    true,
  );
  assert.deepEqual(headingLevels(root), [
    { level: 1, text: "Parent" },
    { level: 2, text: "note" },
    { level: 3, text: "H1 Heading" },
  ]);

  processor.destroy();
});

test("adds the filename heading at h1 when the embed has no parent heading", () => {
  setDocument(`
    <div class="markdown-preview-view">
      <div class="markdown-embed" src="early.md">
        <div class="markdown-embed-content">
          <h1>early 1</h1>
          <h2>early 2</h2>
        </div>
      </div>
      <h1>later</h1>
    </div>
  `);

  const root = document.querySelector(".markdown-preview-view");
  const app = makeCachedApp(
    root,
    {
      headings: [cacheHeading("later", 1, 3)],
      embeds: [cacheEmbed("early.md", 0)],
    },
    {
      "early.md": {
        headings: [cacheHeading("early 1", 1, 0), cacheHeading("early 2", 2, 2)],
        embeds: [],
      },
    },
  );

  const processor = makeProcessor(app, filenameSettings());
  processor.refresh(root);

  assert.deepEqual(headingLevels(root), [
    { level: 1, text: "early" },
    { level: 2, text: "early 1" },
    { level: 3, text: "early 2" },
    { level: 1, text: "later" },
  ]);

  processor.destroy();
});

test("processes a detached Better Export PDF root using the post-processor source path", () => {
  setDocument(`
    <div class="print">
      <div class="markdown-preview-view markdown-rendered">
        <h1 class="__title__">test</h1>
        <div class="markdown-embed" src="embed.md">
          <div class="markdown-embed-content">
            <h1>h1</h1>
            <h1>h1</h1>
            <h2>h2</h2>
          </div>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".markdown-preview-view");
  const app = makeDetachedApp(
    "test.md",
    { headings: [], embeds: [cacheEmbed("embed.md", 0)] },
    {
      "embed.md": {
        headings: [
          cacheHeading("h1", 1, 0),
          cacheHeading("h1", 1, 2),
          cacheHeading("h2", 2, 4),
        ],
        embeds: [],
      },
    },
  );

  const processor = makeProcessor(app, filenameSettings());
  processor.refresh(root, "test.md");

  // The export title is not a note heading: the embed has no parent heading,
  // so its filename heading is h1 and its own headings move one level down.
  assert.deepEqual(headingLevels(root), [
    { level: 1, text: "test" },
    { level: 1, text: "embed" },
    { level: 2, text: "h1" },
    { level: 2, text: "h1" },
    { level: 3, text: "h2" },
  ]);

  const filename = root.querySelector("[data-aeih-filename-heading]");
  assert.ok(filename);
  assert.equal(filename.textContent, "embed");
  assert.equal(filename.tagName, "H1");
  assert.equal(
    filename.parentElement.classList.contains("markdown-embed-content"),
    true,
  );

  processor.destroy();
});

test("ignores a hidden Better Export PDF title when shifting embeds", () => {
  setDocument(`
    <div class="print">
      <div class="markdown-preview-view markdown-rendered">
        <h1 class="__title__" style="display: none;">test</h1>
        <div class="markdown-embed" src="embed.md">
          <div class="markdown-embed-content">
            <h1>h1</h1>
          </div>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".markdown-preview-view");
  const app = makeDetachedApp(
    "test.md",
    { headings: [], embeds: [cacheEmbed("embed.md", 0)] },
    {
      "embed.md": {
        headings: [cacheHeading("h1", 1, 0)],
        embeds: [],
      },
    },
  );

  const processor = makeProcessor(app, settings);
  processor.refresh(root, "test.md");

  // A hidden title must not shift the embed, even though it is still in the
  // print DOM. Without the fix this heading would become h2.
  assert.deepEqual(headingLevels(root), [
    { level: 1, text: "test" },
    { level: 1, text: "h1" },
  ]);
  assert.equal(root.querySelector("[data-aeih-filename-heading]"), null);

  processor.destroy();
});

test("schedule forwards the source path for a detached export root", async () => {
  setDocument(`
    <div class="print">
      <div class="markdown-preview-view markdown-rendered">
        <h1 class="__title__">test</h1>
        <div class="markdown-embed" src="embed.md">
          <div class="markdown-embed-content">
            <h1>h1</h1>
          </div>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".markdown-preview-view");
  const app = makeDetachedApp(
    "test.md",
    { headings: [], embeds: [cacheEmbed("embed.md", 0)] },
    {
      "embed.md": {
        headings: [cacheHeading("h1", 1, 0)],
        embeds: [],
      },
    },
  );

  const processor = makeProcessor(app, filenameSettings());
  processor.schedule(root, "test.md");
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(headingLevels(root), [
    { level: 1, text: "test" },
    { level: 1, text: "embed" },
    { level: 2, text: "h1" },
  ]);

  processor.destroy();
});

test("schedule processes a print root synchronously for the exporter", () => {
  setDocument(`
    <div class="print">
      <div class="markdown-preview-view markdown-rendered">
        <h1 class="__title__">test</h1>
        <div class="markdown-embed" src="embed.md">
          <div class="markdown-embed-content">
            <h1>h1</h1>
          </div>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".markdown-preview-view");
  const app = makeDetachedApp(
    "test.md",
    { headings: [], embeds: [cacheEmbed("embed.md", 0)] },
    {
      "embed.md": {
        headings: [cacheHeading("h1", 1, 0)],
        embeds: [],
      },
    },
  );

  const processor = makeProcessor(app, filenameSettings());
  // No await: exporters read the DOM right after post-processing.
  processor.schedule(root, "test.md", true);

  assert.deepEqual(headingLevels(root), [
    { level: 1, text: "test" },
    { level: 1, text: "embed" },
    { level: 2, text: "h1" },
  ]);

  processor.destroy();
});

test("findPrintRoot resolves an embed back to the detached print root", () => {
  setDocument(`
    <div class="print">
      <div id="print-root" class="markdown-preview-view markdown-rendered">
        <h1 class="__title__">test</h1>
        <div class="markdown-embed" src="embed.md">
          <div class="markdown-embed-content">
            <h1 id="embed-heading">h1</h1>
          </div>
        </div>
      </div>
    </div>
  `);

  const embedHeading = document.querySelector("#embed-heading");
  assert.equal(findPrintRoot(embedHeading).id, "print-root");
});

test("findPrintRoot ignores previews inside a workspace leaf", () => {
  setDocument(`
    <div class="workspace-leaf">
      <div class="print">
        <div id="leaf-preview" class="markdown-preview-view markdown-rendered">
          <h1 id="leaf-heading">note</h1>
        </div>
      </div>
    </div>
  `);

  assert.equal(findPrintRoot(document.querySelector("#leaf-heading")), null);
});

test("keeps a single filename heading across refreshes", () => {
  setDocument(`
    <div class="markdown-preview-view">
      <h1>Parent</h1>
      <div class="markdown-embed" src="note.md">
        <div class="markdown-embed-content">
          <h1>H1 Heading</h1>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".markdown-preview-view");
  const app = makeCachedApp(
    root,
    {
      headings: [cacheHeading("Parent", 1, 0)],
      embeds: [cacheEmbed("note.md", 1)],
    },
    {
      "note.md": {
        headings: [cacheHeading("H1 Heading", 1, 0)],
        embeds: [],
      },
    },
  );

  const processor = makeProcessor(app, filenameSettings());
  processor.refresh(root);
  processor.refresh(root);
  processor.refresh(root);

  assert.deepEqual(headingLevels(root), [
    { level: 1, text: "Parent" },
    { level: 2, text: "note" },
    { level: 3, text: "H1 Heading" },
  ]);
  assert.equal(root.querySelectorAll("[data-aeih-filename-heading]").length, 1);

  processor.destroy();
});

test("removes the filename heading when the option is turned off", () => {
  setDocument(`
    <div class="markdown-preview-view">
      <h1>Parent</h1>
      <div class="markdown-embed" src="note.md">
        <div class="markdown-embed-content">
          <h1>H1 Heading</h1>
          <h2>H2 Heading</h2>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".markdown-preview-view");
  const app = makeCachedApp(
    root,
    {
      headings: [cacheHeading("Parent", 1, 0)],
      embeds: [cacheEmbed("note.md", 1)],
    },
    {
      "note.md": {
        headings: [cacheHeading("H1 Heading", 1, 0), cacheHeading("H2 Heading", 2, 2)],
        embeds: [],
      },
    },
  );

  const currentSettings = filenameSettings();
  const processor = makeProcessor(app, currentSettings);
  processor.refresh(root);
  assert.equal(root.querySelectorAll("[data-aeih-filename-heading]").length, 1);

  currentSettings.filenameAsHeading = false;
  processor.refresh(root);

  assert.equal(root.querySelectorAll("[data-aeih-filename-heading]").length, 0);
  assert.deepEqual(headingLevels(root), [
    { level: 1, text: "Parent" },
    { level: 2, text: "H1 Heading" },
    { level: 3, text: "H2 Heading" },
  ]);

  processor.destroy();
});

test("adds a separate filename heading to a nested embed", () => {
  setDocument(`
    <div class="markdown-preview-view">
      <h1>fruits 1</h1>
      <div class="markdown-embed" src="apple.md">
        <div class="markdown-embed-content">
          <h1>apple 1</h1>
          <div class="markdown-embed" src="orange.md">
            <div class="markdown-embed-content">
              <h1>orange 1</h1>
              <h2>orange 2</h2>
            </div>
          </div>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".markdown-preview-view");
  const app = makeCachedApp(
    root,
    {
      headings: [cacheHeading("fruits 1", 1, 0)],
      embeds: [cacheEmbed("apple.md", 1)],
    },
    {
      "apple.md": {
        headings: [cacheHeading("apple 1", 1, 0)],
        embeds: [cacheEmbed("orange.md", 2)],
      },
      "orange.md": {
        headings: [cacheHeading("orange 1", 1, 0), cacheHeading("orange 2", 2, 2)],
        embeds: [],
      },
    },
  );

  const processor = makeProcessor(app, filenameSettings());
  processor.refresh(root);

  assert.deepEqual(headingLevels(root), [
    { level: 1, text: "fruits 1" },
    { level: 2, text: "apple" },
    { level: 3, text: "apple 1" },
    { level: 4, text: "orange" },
    { level: 5, text: "orange 1" },
    { level: 6, text: "orange 2" },
  ]);

  // Each embed owns exactly one filename heading; the nested one is not
  // reparented into the outer embed.
  const filenames = Array.from(
    root.querySelectorAll("[data-aeih-filename-heading]"),
  );
  assert.deepEqual(
    filenames.map((heading) => heading.textContent),
    ["apple", "orange"],
  );
  assert.deepEqual(
    filenames.map((heading) => heading.parentElement.closest(".markdown-embed").getAttribute("src")),
    ["apple.md", "orange.md"],
  );

  processor.destroy();
});

test("adds a filename heading to section embeds but not block embeds", () => {
  setDocument(`
    <div class="markdown-preview-view">
      <h1>Parent</h1>
      <div class="markdown-embed" src="book.md#Chapter">
        <div class="markdown-embed-content">
          <h2>Chapter</h2>
          <h3>Details</h3>
        </div>
      </div>
      <div class="markdown-embed" src="book.md#^block">
        <div class="markdown-embed-content">
          <p>block text</p>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".markdown-preview-view");
  const app = makeCachedApp(
    root,
    {
      headings: [cacheHeading("Parent", 1, 0)],
      embeds: [cacheEmbed("book.md#Chapter", 1), cacheEmbed("book.md#^block", 3)],
    },
    {
      "book.md": {
        headings: [
          cacheHeading("Part", 1, 0),
          cacheHeading("Chapter", 2, 2),
          cacheHeading("Details", 3, 4),
          cacheHeading("Other", 1, 6),
        ],
        embeds: [],
      },
    },
  );

  const processor = makeProcessor(app, filenameSettings());
  processor.refresh(root);

  assert.deepEqual(headingLevels(root), [
    { level: 1, text: "Parent" },
    { level: 2, text: "book" },
    { level: 4, text: "Chapter" },
    { level: 5, text: "Details" },
  ]);

  const filenames = Array.from(
    root.querySelectorAll("[data-aeih-filename-heading]"),
  );
  assert.deepEqual(
    filenames.map((heading) => heading.textContent),
    ["book"],
  );

  processor.destroy();
});

test("clamps levels at h6 and is idempotent", () => {
  setDocument(`
    <div class="markdown-preview-view">
      <h6>deep</h6>
      <div class="markdown-embed">
        <div class="markdown-embed-content">
          <h1>one</h1>
          <h2>two</h2>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".markdown-preview-view");
  const processor = makeProcessor();
  processor.refresh(root);
  processor.refresh(root);
  processor.refresh(root);

  assert.deepEqual(headingLevels(root), [
    { level: 6, text: "deep" },
    { level: 6, text: "one" },
    { level: 6, text: "two" },
  ]);

  processor.destroy();
});

test("restoreAll returns headings to their original levels", () => {
  setDocument(`
    <div class="markdown-preview-view">
      <h2>parent</h2>
      <div class="markdown-embed">
        <div class="markdown-embed-content">
          <h1>embedded</h1>
          <h3>sub</h3>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".markdown-preview-view");
  const processor = makeProcessor();
  processor.refresh(root);
  assert.deepEqual(headingLevels(root), [
    { level: 2, text: "parent" },
    { level: 3, text: "embedded" },
    { level: 5, text: "sub" },
  ]);

  processor.restoreAll();
  assert.deepEqual(headingLevels(root), [
    { level: 2, text: "parent" },
    { level: 1, text: "embedded" },
    { level: 3, text: "sub" },
  ]);
  assert.equal(root.querySelectorAll("[data-aeih-original-level]").length, 0);
  assert.equal(root.querySelectorAll("[data-aeih-shift]").length, 0);

  processor.destroy();
});

test("uses source headings for Live Preview instead of visible lines", () => {
  setDocument(`
    <div class="cm-content">
      <div class="cm-line HyperMD-header-1">fruits 1</div>
      <div class="cm-line">
        <div class="markdown-embed" id="apple">
          <div class="markdown-embed-content">
            <h1>apple 1</h1>
            <h2>apple 2</h2>
          </div>
        </div>
      </div>
      <div class="cm-line HyperMD-header-2">fruits 2</div>
      <div class="cm-line">
        <div class="markdown-embed" id="orange">
          <div class="markdown-embed-content">
            <h1>orange 1</h1>
          </div>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".cm-content");
  const source = ["# fruits 1", "![[apple]]", "## fruits 2", "![[orange]]"].join("\n");
  const lineByEmbed = new Map([
    [root.querySelector("#apple"), 1],
    [root.querySelector("#orange"), 3],
  ]);

  const view = {
    getViewType: () => "markdown",
    containerEl: root,
    editor: {
      getValue: () => source,
      cm: {
        posAtDOM: (embed) => lineByEmbed.get(embed),
        state: {
          doc: {
            lineAt: (offset) => ({ number: offset + 1 }),
          },
        },
      },
    },
  };

  const app = {
    workspace: {
      activeLeaf: null,
      iterateAllLeaves(callback) {
        callback({ view });
      },
    },
  };

  const processor = makeProcessor(app);
  processor.refresh(root);

  assert.deepEqual(headingLevels(root), [
    { level: 2, text: "apple 1" },
    { level: 3, text: "apple 2" },
    { level: 3, text: "orange 1" },
  ]);

  processor.destroy();
});

test("preserves heading attributes and child elements when changing tags", () => {
  setDocument(`
    <div class="markdown-preview-view">
      <h2>parent</h2>
      <div class="markdown-embed">
        <div class="markdown-embed-content">
          <h1 data-heading="apple" id="apple-heading" dir="auto">apple <em>1</em></h1>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".markdown-preview-view");
  const processor = makeProcessor();
  processor.refresh(root);

  const heading = root.querySelector("h3");
  assert.equal(heading.textContent, "apple 1");
  assert.equal(heading.getAttribute("data-heading"), "apple");
  assert.equal(heading.id, "apple-heading");
  assert.equal(heading.getAttribute("dir"), "auto");
  assert.equal(heading.querySelector("em").textContent, "1");

  processor.destroy();
});

test("picks up embed content that loads after the first pass", async () => {
  setDocument(`
    <div class="markdown-preview-view">
      <h2>parent</h2>
      <div class="markdown-embed">
        <div class="markdown-embed-content"></div>
      </div>
    </div>
  `);

  const root = document.querySelector(".markdown-preview-view");
  const content = root.querySelector(".markdown-embed-content");
  const processor = makeProcessor();
  processor.schedule(root);

  await new Promise((resolve) => setTimeout(resolve, 40));

  const heading = document.createElement("h1");
  heading.textContent = "late";
  content.appendChild(heading);

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.deepEqual(headingLevels(root), [
    { level: 2, text: "parent" },
    { level: 3, text: "late" },
  ]);

  processor.destroy();
});

test("restores headings if an embed is moved out from under a heading", () => {
  setDocument(`
    <div class="markdown-preview-view">
      <h2 id="parent">parent</h2>
      <div class="markdown-embed" id="embed">
        <div class="markdown-embed-content">
          <h1>embedded</h1>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".markdown-preview-view");
  const embed = root.querySelector("#embed");
  const processor = makeProcessor();
  processor.refresh(root);
  assert.equal(embed.querySelector("h1, h2, h3, h4, h5, h6").tagName, "H3");

  root.insertBefore(embed, root.querySelector("#parent"));
  processor.refresh(root);

  assert.deepEqual(headingLevels(root), [
    { level: 1, text: "embedded" },
    { level: 2, text: "parent" },
  ]);

  processor.destroy();
});

test("findRenderRoot resolves an embed back to its top-level note", () => {
  setDocument(`
    <div class="markdown-preview-view" id="outer">
      <h1>outer</h1>
      <div class="markdown-embed">
        <div class="markdown-embed-content">
          <div class="markdown-preview-view" id="inner">
            <h1>inner</h1>
          </div>
        </div>
      </div>
    </div>
  `);

  const inner = document.querySelector("#inner");
  assert.equal(findRenderRoot(inner).id, "outer");
});

test("assigns outline keys from source positions even when earlier Live Preview embeds are virtualized", () => {
  setDocument(`
    <div class="cm-content">
      <div class="cm-line HyperMD-header-1">fruits 1</div>
      <div class="cm-line">
        <div class="markdown-embed" id="orange" src="orange.md">
          <div class="markdown-embed-content">
            <h1>orange 1</h1>
            <h2>orange 2</h2>
          </div>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".cm-content");
  const orange = root.querySelector("#orange");
  const rootFile = { path: "fruits.md", extension: "md" };
  const appleFile = { path: "apple.md", extension: "md" };
  const orangeFile = { path: "orange.md", extension: "md" };
  const cacheByPath = new Map([
    [
      rootFile.path,
      {
        headings: [
          { heading: "fruits 1", level: 1, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 9, offset: 9 } } },
          { heading: "fruits 2", level: 2, position: { start: { line: 3, col: 0, offset: 300 }, end: { line: 3, col: 9, offset: 309 } } },
        ],
        embeds: [
          { link: "apple.md", position: { start: { line: 1, col: 0, offset: 100 }, end: { line: 1, col: 12, offset: 112 } } },
          { link: "orange.md", position: { start: { line: 4, col: 2, offset: 402 }, end: { line: 4, col: 14, offset: 414 } } },
        ],
      },
    ],
    [
      orangeFile.path,
      {
        headings: [
          { heading: "orange 1", level: 1, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 9, offset: 9 } } },
          { heading: "orange 2", level: 2, position: { start: { line: 2, col: 0, offset: 200 }, end: { line: 2, col: 9, offset: 209 } } },
        ],
        embeds: [],
      },
    ],
    [appleFile.path, { headings: [], embeds: [] }],
  ]);

  const source = [
    "# fruits 1",
    "![[apple.md]]",
    "",
    "## fruits 2",
    "  ![[orange.md]]",
  ].join("\n");

  const view = {
    file: rootFile,
    getViewType: () => "markdown",
    containerEl: root,
    editor: {
      getValue: () => source,
      cm: {
        posAtDOM: () => 402,
        state: {
          doc: {
            lineAt: (offset) => ({
              number: Math.floor(offset / 100) + 1,
              from: Math.floor(offset / 100) * 100,
            }),
          },
        },
      },
    },
  };

  const app = {
    workspace: {
      activeLeaf: null,
      iterateAllLeaves(callback) {
        callback({ view });
      },
    },
    metadataCache: {
      getFileCache: (file) => cacheByPath.get(file.path) ?? null,
      getFirstLinkpathDest: (path) =>
        path === "orange.md" ? orangeFile : path === "apple.md" ? appleFile : null,
    },
  };

  const processor = makeProcessor(app);
  processor.refresh(root);

  assert.deepEqual(headingLevels(root), [
    { level: 3, text: "orange 1" },
    { level: 4, text: "orange 2" },
  ]);

  const keys = Array.from(root.querySelectorAll("[data-aeih-outline-key]")).map(
    (heading) => JSON.parse(heading.getAttribute("data-aeih-outline-key")),
  );

  // The apple embed is virtualized away, but the orange embed still uses its
  // source index (1), matching the outline builder.
  assert.deepEqual(keys, [
    ["fruits.md", [1], "orange.md", 0],
    ["fruits.md", [1], "orange.md", 2],
  ]);

  processor.destroy();
});

test("non-note embeds do not consume reading-view outline indices", () => {
  setDocument(`
    <div class="markdown-preview-view">
      <h1>fruits 1</h1>
      <div class="markdown-embed" src="image.png"></div>
      <div class="markdown-embed" src="missing.md"></div>
      <div class="markdown-embed" src="apple.md">
        <div class="markdown-embed-content">
          <h1>apple 1</h1>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".markdown-preview-view");
  const rootFile = { path: "fruits.md", extension: "md" };
  const appleFile = { path: "apple.md", extension: "md" };
  const imageFile = { path: "image.png", extension: "png" };
  const cacheByPath = new Map([
    [
      rootFile.path,
      {
        headings: [cacheHeading("fruits 1", 1, 0)],
        embeds: [
          cacheEmbed("image.png", 1),
          cacheEmbed("missing.md", 2),
          cacheEmbed("apple.md", 3),
        ],
      },
    ],
    [
      appleFile.path,
      {
        headings: [cacheHeading("apple 1", 1, 0)],
        embeds: [],
      },
    ],
  ]);

  const view = {
    file: rootFile,
    getViewType: () => "markdown",
    containerEl: root,
  };

  const app = {
    workspace: {
      activeLeaf: null,
      iterateAllLeaves(callback) {
        callback({ view });
      },
    },
    metadataCache: {
      getFileCache: (file) => cacheByPath.get(file.path) ?? null,
      getFirstLinkpathDest: (path) => {
        if (path === "apple.md") {
          return appleFile;
        }
        if (path === "image.png") {
          return imageFile;
        }
        return null;
      },
    },
  };

  const processor = makeProcessor(app);
  processor.refresh(root);

  assert.deepEqual(headingLevels(root), [
    { level: 1, text: "fruits 1" },
    { level: 2, text: "apple 1" },
  ]);

  const keys = Array.from(root.querySelectorAll("[data-aeih-outline-key]")).map(
    (heading) => JSON.parse(heading.getAttribute("data-aeih-outline-key")),
  );
  assert.deepEqual(keys, [["fruits.md", [0], "apple.md", 0]]);

  processor.destroy();
});

test("non-note embeds do not consume Live Preview outline indices", () => {
  setDocument(`
    <div class="cm-content">
      <div class="cm-line HyperMD-header-1">fruits 1</div>
      <div class="cm-line">
        <div class="markdown-embed" src="apple.md">
          <div class="markdown-embed-content">
            <h1>apple 1</h1>
          </div>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".cm-content");
  const rootFile = { path: "fruits.md", extension: "md" };
  const appleFile = { path: "apple.md", extension: "md" };
  const imageFile = { path: "image.png", extension: "png" };
  const cacheByPath = new Map([
    [
      rootFile.path,
      {
        headings: [cacheHeading("fruits 1", 1, 0)],
        embeds: [cacheEmbed("image.png", 1), cacheEmbed("apple.md", 2)],
      },
    ],
    [
      appleFile.path,
      {
        headings: [cacheHeading("apple 1", 1, 0)],
        embeds: [],
      },
    ],
  ]);

  const source = ["# fruits 1", "![[image.png]]", "![[apple.md]]"].join("\n");
  const view = {
    file: rootFile,
    getViewType: () => "markdown",
    containerEl: root,
    editor: {
      getValue: () => source,
      cm: {
        posAtDOM: () => 200,
        state: {
          doc: {
            lineAt: (offset) => ({
              number: Math.floor(offset / 100) + 1,
              from: Math.floor(offset / 100) * 100,
            }),
          },
        },
      },
    },
  };

  const app = {
    workspace: {
      activeLeaf: null,
      iterateAllLeaves(callback) {
        callback({ view });
      },
    },
    metadataCache: {
      getFileCache: (file) => cacheByPath.get(file.path) ?? null,
      getFirstLinkpathDest: (path) => {
        if (path === "apple.md") {
          return appleFile;
        }
        if (path === "image.png") {
          return imageFile;
        }
        return null;
      },
    },
  };

  const processor = makeProcessor(app);
  processor.refresh(root);

  // The root heading is a CodeMirror line, so only the embedded heading is an
  // actual h1-h6 element.
  assert.deepEqual(headingLevels(root), [{ level: 2, text: "apple 1" }]);

  const keys = Array.from(root.querySelectorAll("[data-aeih-outline-key]")).map(
    (heading) => JSON.parse(heading.getAttribute("data-aeih-outline-key")),
  );
  assert.deepEqual(keys, [["fruits.md", [0], "apple.md", 0]]);

  processor.destroy();
});

test("processes an embed inside a Reading View heading", () => {
  setDocument(`
    <div class="markdown-preview-view">
      <h1>fruits 1
        <div class="markdown-embed" src="apple.md">
          <div class="markdown-embed-content">
            <h1>apple 1</h1>
          </div>
        </div>
      </h1>
      <div class="markdown-embed" src="orange.md">
        <div class="markdown-embed-content">
          <h1>orange 1</h1>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".markdown-preview-view");
  assert.ok(root.querySelector("h1 .markdown-embed"));

  const rootFile = { path: "fruits.md", extension: "md" };
  const appleFile = { path: "apple.md", extension: "md" };
  const orangeFile = { path: "orange.md", extension: "md" };
  const cacheByPath = new Map([
    [
      rootFile.path,
      {
        headings: [cacheHeading("fruits 1", 1, 0)],
        embeds: [cacheEmbed("apple.md", 0, 10), cacheEmbed("orange.md", 2)],
      },
    ],
    [
      appleFile.path,
      {
        headings: [cacheHeading("apple 1", 1, 0)],
        embeds: [],
      },
    ],
    [
      orangeFile.path,
      {
        headings: [cacheHeading("orange 1", 1, 0)],
        embeds: [],
      },
    ],
  ]);

  const view = {
    file: rootFile,
    getViewType: () => "markdown",
    containerEl: root,
  };

  const app = {
    workspace: {
      activeLeaf: null,
      iterateAllLeaves(callback) {
        callback({ view });
      },
    },
    metadataCache: {
      getFileCache: (file) => cacheByPath.get(file.path) ?? null,
      getFirstLinkpathDest: (path) => {
        if (path === "apple.md") {
          return appleFile;
        }
        if (path === "orange.md") {
          return orangeFile;
        }
        return null;
      },
    },
  };

  const processor = makeProcessor(app);
  processor.refresh(root);

  // The outer heading is a parent-note heading and is intentionally untracked;
  // the embed inside it and the following embed are both shifted.
  const embeddedLevels = Array.from(
    root.querySelectorAll("[data-aeih-original-level]"),
  ).map((heading) => ({
    level: Number(heading.tagName.slice(1)),
    text: heading.textContent,
  }));
  assert.deepEqual(embeddedLevels, [
    { level: 2, text: "apple 1" },
    { level: 2, text: "orange 1" },
  ]);

  const keys = Array.from(root.querySelectorAll("[data-aeih-outline-key]")).map(
    (heading) => JSON.parse(heading.getAttribute("data-aeih-outline-key")),
  );
  assert.deepEqual(keys, [
    ["fruits.md", [0], "apple.md", 0],
    ["fruits.md", [1], "orange.md", 0],
  ]);

  processor.destroy();
});

test("uses the heading on the same line for an embed in Live Preview", () => {
  setDocument(`
    <div class="cm-content">
      <div class="cm-line HyperMD-header-1">
        fruits 1
        <div class="markdown-embed" src="apple.md">
          <div class="markdown-embed-content">
            <h1>apple 1</h1>
          </div>
        </div>
      </div>
    </div>
  `);

  const root = document.querySelector(".cm-content");
  const rootFile = { path: "fruits.md", extension: "md" };
  const appleFile = { path: "apple.md", extension: "md" };
  const cacheByPath = new Map([
    [
      rootFile.path,
      {
        headings: [cacheHeading("fruits 1", 1, 0)],
        embeds: [cacheEmbed("apple.md", 0, 10)],
      },
    ],
    [
      appleFile.path,
      {
        headings: [cacheHeading("apple 1", 1, 0)],
        embeds: [],
      },
    ],
  ]);

  const source = "# fruits 1 ![[apple.md]]";
  const view = {
    file: rootFile,
    getViewType: () => "markdown",
    containerEl: root,
    editor: {
      getValue: () => source,
      cm: {
        posAtDOM: () => 0,
        state: {
          doc: {
            lineAt: () => ({ number: 1, from: 0 }),
          },
        },
      },
    },
  };

  const app = {
    workspace: {
      activeLeaf: null,
      iterateAllLeaves(callback) {
        callback({ view });
      },
    },
    metadataCache: {
      getFileCache: (file) => cacheByPath.get(file.path) ?? null,
      getFirstLinkpathDest: (path) => (path === "apple.md" ? appleFile : null),
    },
  };

  const processor = makeProcessor(app);
  processor.refresh(root);

  assert.deepEqual(headingLevels(root), [{ level: 2, text: "apple 1" }]);

  const keys = Array.from(root.querySelectorAll("[data-aeih-outline-key]")).map(
    (heading) => JSON.parse(heading.getAttribute("data-aeih-outline-key")),
  );
  assert.deepEqual(keys, [["fruits.md", [0], "apple.md", 0]]);

  processor.destroy();
});
