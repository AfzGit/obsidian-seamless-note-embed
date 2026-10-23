import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

const require = createRequire(import.meta.url);
const { EmbedHeadingProcessor, findRenderRoot } = require("./.tmp/processor.cjs");

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
