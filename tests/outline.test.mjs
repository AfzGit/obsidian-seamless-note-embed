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
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

const require = createRequire(import.meta.url);
const {
  normalizeHeading,
  resolveHeadingSubpath,
  splitLinktext,
} = require("./.tmp/embedTargets.cjs");
const { buildOutlineHeadings } = require("./.tmp/outlineHeadings.cjs");
const { OutlineIntegration } = require("./.tmp/outline.cjs");

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

function makeResolver(files) {
  return (path) => files.get(path) ?? null;
}

test("splits link paths and heading subpaths", () => {
  assert.deepEqual(splitLinktext("note#Heading"), {
    path: "note",
    subpath: "#Heading",
  });
  assert.deepEqual(splitLinktext("folder/note.md#Heading|alias"), {
    path: "folder/note.md",
    subpath: "#Heading",
  });
  assert.deepEqual(splitLinktext("note"), { path: "note", subpath: "" });
});

test("normalizes headings like Obsidian link resolution", () => {
  assert.equal(normalizeHeading("  **Part 1:**  "), "part 1");
  assert.equal(normalizeHeading("Part 1"), "part 1");
});

test("resolves heading sections, including nested heading paths", () => {
  const headings = [
    heading("Part", 1, 0),
    heading("Chapter", 2, 2),
    heading("Details", 3, 4),
    heading("Other", 1, 6),
  ];

  assert.deepEqual(resolveHeadingSubpath(headings, "#Chapter"), {
    startLine: 2,
    endLine: 6,
  });
  assert.deepEqual(resolveHeadingSubpath(headings, "#Part"), {
    startLine: 0,
    endLine: 6,
  });
  assert.deepEqual(resolveHeadingSubpath(headings, "#Part#Chapter"), {
    startLine: 2,
    endLine: 6,
  });
  assert.equal(resolveHeadingSubpath(headings, "#Missing"), null);
  assert.equal(resolveHeadingSubpath(headings, "#^block"), null);
});

test("builds outline headings with shifted embed levels", () => {
  const files = new Map([
    [
      "apple.md",
      {
        path: "apple.md",
        headings: [heading("apple 1", 1, 0), heading("apple 2", 2, 2)],
        embeds: [],
      },
    ],
    [
      "orange.md",
      {
        path: "orange.md",
        headings: [heading("orange 1", 1, 0), heading("orange 2", 2, 2)],
        embeds: [],
      },
    ],
  ]);

  const root = {
    path: "fruits.md",
    headings: [heading("fruits 1", 1, 0), heading("fruits 2", 2, 4)],
    embeds: [embed("apple.md", 1), embed("orange.md", 5)],
  };

  const result = buildOutlineHeadings(root, makeResolver(files));
  assert.deepEqual(
    result.map((item) => ({ text: item.heading, level: item.level })),
    [
      { text: "fruits 1", level: 1 },
      { text: "apple 1", level: 2 },
      { text: "apple 2", level: 3 },
      { text: "fruits 2", level: 2 },
      { text: "orange 1", level: 3 },
      { text: "orange 2", level: 4 },
    ],
  );

  assert.equal(result[0].aeih, undefined);
  assert.equal(result[1].aeih.embedLine, 1);
  assert.equal(result[1].aeih.targetLine, 0);
  assert.equal(result[1].position.start.line, 1);
  assert.equal(result[1].position.end.line, Number.MAX_SAFE_INTEGER);

  // Parent headings must stay identical to the metadata-cache objects so the
  // core outline can find the active heading in Live Preview.
  assert.equal(result[0], root.headings[0]);
  assert.equal(result[3], root.headings[1]);
});

test("includes embedded headings at original levels when shifting is disabled", () => {
  const files = new Map([
    [
      "apple.md",
      {
        path: "apple.md",
        headings: [heading("apple 1", 1, 0), heading("apple 2", 2, 2)],
        embeds: [embed("orange.md", 4)],
      },
    ],
    [
      "orange.md",
      {
        path: "orange.md",
        headings: [heading("orange 1", 1, 0), heading("orange 2", 2, 2)],
        embeds: [],
      },
    ],
  ]);

  const root = {
    path: "fruits.md",
    headings: [heading("fruits 1", 1, 0), heading("fruits 2", 2, 5)],
    embeds: [embed("apple.md", 1)],
  };

  const result = buildOutlineHeadings(root, makeResolver(files), {
    shift: false,
  });
  assert.deepEqual(
    result.map((item) => ({ text: item.heading, level: item.level })),
    [
      { text: "fruits 1", level: 1 },
      { text: "apple 1", level: 1 },
      { text: "apple 2", level: 2 },
      { text: "orange 1", level: 1 },
      { text: "orange 2", level: 2 },
      { text: "fruits 2", level: 2 },
    ],
  );

  // The entries still carry navigation metadata; only their levels are
  // unchanged.
  assert.equal(result[1].aeih.targetLine, 0);
  assert.deepEqual(result[3].aeih.embedPath, [0, 0]);
});

test("media embeds do not occupy outline embed indices", () => {
  const files = new Map([
    [
      "apple.md",
      {
        path: "apple.md",
        headings: [heading("apple 1", 1, 0), heading("apple 2", 2, 2)],
        embeds: [embed("image.png", 3), embed("orange.md", 4)],
      },
    ],
    [
      "orange.md",
      {
        path: "orange.md",
        headings: [heading("orange 1", 1, 0)],
        embeds: [],
      },
    ],
  ]);

  const root = {
    path: "fruits.md",
    headings: [heading("fruits 1", 1, 0)],
    embeds: [embed("image.png", 1), embed("apple.md", 2)],
  };

  const result = buildOutlineHeadings(root, makeResolver(files));
  assert.deepEqual(
    result.map((item) => ({ text: item.heading, level: item.level })),
    [
      { text: "fruits 1", level: 1 },
      { text: "apple 1", level: 2 },
      { text: "apple 2", level: 3 },
      { text: "orange 1", level: 4 },
    ],
  );

  // The image embeds are skipped, so the note embeds keep the same indices
  // the reading-view DOM assigns to its `.markdown-embed` elements.
  assert.deepEqual(result[1].aeih.embedPath, [0]);
  assert.deepEqual(result[3].aeih.embedPath, [0, 0]);
});

test("keeps same-line embed source order in outline indices", () => {
  const files = new Map([
    [
      "apple.md",
      {
        path: "apple.md",
        headings: [heading("apple 1", 1, 0)],
        embeds: [],
      },
    ],
    [
      "orange.md",
      {
        path: "orange.md",
        headings: [heading("orange 1", 1, 0)],
        embeds: [],
      },
    ],
  ]);

  const root = {
    path: "fruits.md",
    headings: [heading("fruits 1", 1, 0)],
    embeds: [embed("orange.md", 1, 12), embed("apple.md", 1, 0)],
  };

  const result = buildOutlineHeadings(root, makeResolver(files));
  assert.deepEqual(
    result.map((item) => ({ text: item.heading, level: item.level })),
    [
      { text: "fruits 1", level: 1 },
      { text: "apple 1", level: 2 },
      { text: "orange 1", level: 2 },
    ],
  );

  assert.deepEqual(result[1].aeih.embedPath, [0]);
  assert.deepEqual(result[2].aeih.embedPath, [1]);
});

test("chains shifts through nested embeds in the outline", () => {
  const files = new Map([
    [
      "apple.md",
      {
        path: "apple.md",
        headings: [heading("apple 1", 1, 0), heading("apple 2", 2, 2)],
        embeds: [embed("orange.md", 4)],
      },
    ],
    [
      "orange.md",
      {
        path: "orange.md",
        headings: [heading("orange 1", 1, 0), heading("orange 2", 2, 2)],
        embeds: [],
      },
    ],
  ]);

  const root = {
    path: "fruits.md",
    headings: [heading("fruits 1", 1, 0)],
    embeds: [embed("apple.md", 1)],
  };

  const result = buildOutlineHeadings(root, makeResolver(files));
  assert.deepEqual(
    result.map((item) => ({ text: item.heading, level: item.level })),
    [
      { text: "fruits 1", level: 1 },
      { text: "apple 1", level: 2 },
      { text: "apple 2", level: 3 },
      { text: "orange 1", level: 4 },
      { text: "orange 2", level: 5 },
    ],
  );

  // The nested embed is inside the second embed occurrence of the chain.
  assert.deepEqual(result[3].aeih.embedPath, [0, 0]);
  assert.equal(result[3].aeih.embedLine, 1);
});

test("embeds before any heading keep their original levels in the outline", () => {
  const files = new Map([
    [
      "early.md",
      {
        path: "early.md",
        headings: [heading("early 1", 1, 0), heading("early 2", 2, 2)],
        embeds: [],
      },
    ],
  ]);

  const root = {
    path: "parent.md",
    headings: [heading("later", 1, 3)],
    embeds: [embed("early.md", 0)],
  };

  const result = buildOutlineHeadings(root, makeResolver(files));
  assert.deepEqual(
    result.map((item) => ({ text: item.heading, level: item.level })),
    [
      { text: "early 1", level: 1 },
      { text: "early 2", level: 2 },
      { text: "later", level: 1 },
    ],
  );
});

test("section embeds contribute only their heading section to the outline", () => {
  const files = new Map([
    [
      "book.md",
      {
        path: "book.md",
        headings: [
          heading("Part", 1, 0),
          heading("Chapter", 2, 2),
          heading("Details", 3, 4),
          heading("Other", 1, 6),
        ],
        embeds: [],
      },
    ],
  ]);

  const root = {
    path: "parent.md",
    headings: [heading("Parent", 1, 0)],
    embeds: [embed("book.md#Chapter", 1)],
  };

  const result = buildOutlineHeadings(root, makeResolver(files));
  assert.deepEqual(
    result.map((item) => ({ text: item.heading, level: item.level })),
    [
      { text: "Parent", level: 1 },
      { text: "Chapter", level: 3 },
      { text: "Details", level: 4 },
    ],
  );
});

test("block embeds contribute no headings to the outline", () => {
  const files = new Map([
    [
      "book.md",
      {
        path: "book.md",
        headings: [heading("Chapter", 2, 0)],
        embeds: [],
      },
    ],
  ]);

  const root = {
    path: "parent.md",
    headings: [heading("Parent", 1, 0)],
    embeds: [embed("book.md#^block", 1)],
  };

  const result = buildOutlineHeadings(root, makeResolver(files));
  assert.deepEqual(
    result.map((item) => ({ text: item.heading, level: item.level })),
    [{ text: "Parent", level: 1 }],
  );
});

test("clamps embedded outline levels at six and keeps duplicate embeds distinct", () => {
  const files = new Map([
    [
      "deep.md",
      {
        path: "deep.md",
        headings: [heading("deep 1", 1, 0), heading("deep 2", 2, 2)],
        embeds: [],
      },
    ],
  ]);

  const root = {
    path: "parent.md",
    headings: [heading("Parent", 6, 0)],
    embeds: [embed("deep.md", 1), embed("deep.md", 3)],
  };

  const result = buildOutlineHeadings(root, makeResolver(files));
  assert.deepEqual(
    result.map((item) => ({ text: item.heading, level: item.level })),
    [
      { text: "Parent", level: 6 },
      { text: "deep 1", level: 6 },
      { text: "deep 2", level: 6 },
      { text: "deep 1", level: 6 },
      { text: "deep 2", level: 6 },
    ],
  );

  assert.notEqual(result[1].aeih.key, result[3].aeih.key);
  assert.deepEqual(result[3].aeih.embedPath, [1]);
});

test("patches an outline view and restores it when stopped", () => {
  document.body.innerHTML = "";

  const rootFile = { path: "fruits.md", extension: "md" };
  const appleFile = { path: "apple.md", extension: "md" };
  const rootHeadings = [heading("fruits 1", 1, 0)];
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

  const containerEl = document.createElement("div");
  document.body.appendChild(containerEl);

  const view = {
    file: rootFile,
    containerEl,
    cachedHeadingDom: [],
    getHeadings() {
      return cacheByPath.get(rootFile.path).headings;
    },
    update() {
      this.cachedHeadingDom = this.getHeadings().map((item) =>
        this.createItemDom(item),
      );
    },
    createItemDom(item) {
      const selfEl = document.createElement("div");
      selfEl.className = "tree-item-self";
      selfEl.textContent = item.heading;
      containerEl.appendChild(selfEl);
      return { selfEl, heading: item };
    },
  };

  const app = {
    workspace: {
      activeLeaf: null,
      getLeavesOfType: () => [{ view }],
      iterateAllLeaves() {},
    },
    metadataCache: {
      getFileCache: (file) => cacheByPath.get(file.path) ?? null,
      getFirstLinkpathDest: (path) => (path === "apple.md" ? appleFile : null),
    },
  };

  const integration = new OutlineIntegration(app, () => ({ enabled: true }));
  integration.start();

  assert.deepEqual(
    view.cachedHeadingDom.map((item) => ({
      text: item.heading.heading,
      level: item.heading.level,
    })),
    [
      { text: "fruits 1", level: 1 },
      { text: "apple 1", level: 2 },
      { text: "apple 2", level: 3 },
    ],
  );

  const embeddedItems = view.cachedHeadingDom.filter(
    (item) => item.selfEl.hasAttribute("data-aeih-outline-key"),
  );
  assert.equal(embeddedItems.length, 2);
  assert.equal(
    embeddedItems[0].selfEl.classList.contains("aeih-outline-embedded"),
    true,
  );

  integration.stop();

  assert.equal(
    view.cachedHeadingDom.some((item) =>
      item.selfEl.hasAttribute("data-aeih-outline-key"),
    ),
    false,
  );
  assert.equal(view.cachedHeadingDom.length, 1);
  assert.equal(view.cachedHeadingDom[0].heading.heading, "fruits 1");

  integration.destroy();
});

test("keeps embedded outline entries when heading shifting is disabled", () => {
  document.body.innerHTML = "";

  const rootFile = { path: "fruits.md", extension: "md" };
  const appleFile = { path: "apple.md", extension: "md" };
  const cacheByPath = new Map([
    [
      rootFile.path,
      {
        headings: [heading("fruits 1", 1, 0)],
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

  const containerEl = document.createElement("div");
  document.body.appendChild(containerEl);

  const view = {
    file: rootFile,
    containerEl,
    cachedHeadingDom: [],
    getHeadings() {
      return cacheByPath.get(rootFile.path).headings;
    },
    update() {
      this.cachedHeadingDom = this.getHeadings().map((item) =>
        this.createItemDom(item),
      );
    },
    createItemDom(item) {
      const selfEl = document.createElement("div");
      selfEl.className = "tree-item-self";
      selfEl.textContent = item.heading;
      containerEl.appendChild(selfEl);
      return { selfEl, heading: item };
    },
  };

  const app = {
    workspace: {
      activeLeaf: null,
      getLeavesOfType: () => [{ view }],
      iterateAllLeaves() {},
    },
    metadataCache: {
      getFileCache: (file) => cacheByPath.get(file.path) ?? null,
      getFirstLinkpathDest: (path) => (path === "apple.md" ? appleFile : null),
    },
  };

  const integration = new OutlineIntegration(app, () => ({
    enabled: true,
    shift: false,
  }));
  integration.start();

  assert.deepEqual(
    view.cachedHeadingDom.map((item) => ({
      text: item.heading.heading,
      level: item.heading.level,
    })),
    [
      { text: "fruits 1", level: 1 },
      { text: "apple 1", level: 1 },
      { text: "apple 2", level: 2 },
    ],
  );
  assert.equal(
    view.cachedHeadingDom.filter((item) =>
      item.selfEl.hasAttribute("data-aeih-outline-key"),
    ).length,
    2,
  );

  integration.destroy();
});

test("does not report a fake heading as the active heading", () => {
  document.body.innerHTML = "";

  const rootFile = { path: "fruits.md", extension: "md" };
  const appleFile = { path: "apple.md", extension: "md" };
  const rootHeadings = [heading("fruits 1", 1, 0)];
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

  const containerEl = document.createElement("div");
  document.body.appendChild(containerEl);

  let activeIndex = 0;
  const view = {
    file: rootFile,
    containerEl,
    cachedHeadingDom: [],
    getHeadings() {
      return cacheByPath.get(rootFile.path).headings;
    },
    update() {
      this.cachedHeadingDom = this.getHeadings().map((item) =>
        this.createItemDom(item),
      );
    },
    createItemDom(item) {
      const selfEl = document.createElement("div");
      selfEl.className = "tree-item-self";
      selfEl.textContent = item.heading;
      containerEl.appendChild(selfEl);
      return { selfEl, heading: item };
    },
    findActiveHeading() {
      return this.cachedHeadingDom[activeIndex] ?? null;
    },
  };

  const app = {
    workspace: {
      activeLeaf: null,
      getLeavesOfType: () => [{ view }],
      iterateAllLeaves() {},
    },
    metadataCache: {
      getFileCache: (file) => cacheByPath.get(file.path) ?? null,
      getFirstLinkpathDest: (path) => (path === "apple.md" ? appleFile : null),
    },
  };

  const integration = new OutlineIntegration(app, () => ({ enabled: true }));
  integration.start();

  // The last item is an embedded heading.
  activeIndex = view.cachedHeadingDom.length - 1;
  assert.equal(view.findActiveHeading(), null);

  // Real parent-note headings are still reported.
  activeIndex = 0;
  assert.equal(view.findActiveHeading(), view.cachedHeadingDom[0]);

  integration.stop();

  // Stopping restores the core method rather than leaving our wrapper behind.
  activeIndex = view.cachedHeadingDom.length - 1;
  assert.notEqual(view.findActiveHeading(), null);

  integration.destroy();
});

test("removes embedded decorations when a reused item becomes a real heading", () => {
  document.body.innerHTML = "";

  const rootFile = { path: "fruits.md", extension: "md" };
  const appleFile = { path: "apple.md", extension: "md" };
  const rootHeadings = [heading("fruits 1", 1, 0), heading("apple 1", 2, 2)];
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
        headings: [heading("apple 1", 1, 0)],
        embeds: [],
      },
    ],
  ]);

  const containerEl = document.createElement("div");
  document.body.appendChild(containerEl);

  const view = {
    file: rootFile,
    containerEl,
    cachedHeadingDom: [],
    getHeadings() {
      return cacheByPath.get(rootFile.path).headings;
    },
    update() {
      const previous = this.cachedHeadingDom;
      const next = [];

      for (const item of this.getHeadings()) {
        const reused = previous.find(
          (candidate) =>
            candidate.heading.heading === item.heading &&
            candidate.heading.level === item.level,
        );

        if (reused) {
          reused.heading = item;
          next.push(reused);
        } else {
          next.push(this.createItemDom(item));
        }
      }

      this.cachedHeadingDom = next;
    },
    createItemDom(item) {
      const selfEl = document.createElement("div");
      selfEl.className = "tree-item-self";
      selfEl.textContent = item.heading;
      containerEl.appendChild(selfEl);
      return { selfEl, heading: item };
    },
  };

  const app = {
    workspace: {
      activeLeaf: null,
      getLeavesOfType: () => [{ view }],
      iterateAllLeaves() {},
    },
    metadataCache: {
      getFileCache: (file) => cacheByPath.get(file.path) ?? null,
      getFirstLinkpathDest: (path) => (path === "apple.md" ? appleFile : null),
    },
  };

  const integration = new OutlineIntegration(app, () => ({ enabled: true }));
  integration.start();

  const decorated = view.cachedHeadingDom.find((item) =>
    item.selfEl.hasAttribute("data-aeih-outline-key"),
  );
  assert.ok(decorated);

  integration.stop();

  assert.equal(
    view.cachedHeadingDom.some((item) =>
      item.selfEl.hasAttribute("data-aeih-outline-key"),
    ),
    false,
  );
  assert.equal(
    view.cachedHeadingDom.some((item) =>
      item.selfEl.classList.contains("aeih-outline-embedded"),
    ),
    false,
  );

  integration.destroy();
});

test("does not patch an outline view while the plugin is disabled", () => {
  document.body.innerHTML = "";

  const rootFile = { path: "fruits.md", extension: "md" };
  const containerEl = document.createElement("div");
  document.body.appendChild(containerEl);
  const view = {
    file: rootFile,
    containerEl,
    cachedHeadingDom: [],
    getHeadings: () => [heading("fruits 1", 1, 0)],
    update() {
      this.cachedHeadingDom = [
        {
          selfEl: document.createElement("div"),
          heading: this.getHeadings()[0],
        },
      ];
    },
  };

  const app = {
    workspace: {
      activeLeaf: null,
      getLeavesOfType: () => [{ view }],
      iterateAllLeaves() {},
    },
    metadataCache: {
      getFileCache: () => ({ headings: [heading("fruits 1", 1, 0)], embeds: [] }),
      getFirstLinkpathDest: () => null,
    },
  };

  const integration = new OutlineIntegration(app, () => ({ enabled: false }));
  integration.start();
  view.update();

  assert.equal(view.cachedHeadingDom.length, 1);
  assert.equal(
    view.cachedHeadingDom[0].selfEl.hasAttribute("data-aeih-outline-key"),
    false,
  );

  integration.destroy();
});

test("clicking an embedded outline item scrolls to its rendered heading", async () => {
  document.body.innerHTML = "";

  const rootFile = { path: "fruits.md", extension: "md" };
  const appleFile = { path: "apple.md", extension: "md" };
  const cacheByPath = new Map([
    [
      rootFile.path,
      {
        headings: [heading("fruits 1", 1, 0)],
        embeds: [embed("apple.md", 1)],
      },
    ],
    [
      appleFile.path,
      {
        headings: [heading("apple 1", 1, 0)],
        embeds: [],
      },
    ],
  ]);

  const containerEl = document.createElement("div");
  document.body.appendChild(containerEl);

  const view = {
    file: rootFile,
    containerEl,
    cachedHeadingDom: [],
    getHeadings() {
      return cacheByPath.get(rootFile.path).headings;
    },
    update() {
      this.cachedHeadingDom = this.getHeadings().map((item) =>
        this.createItemDom(item),
      );
    },
    createItemDom(item) {
      const selfEl = document.createElement("div");
      selfEl.className = "tree-item-self";
      selfEl.textContent = item.heading;
      containerEl.appendChild(selfEl);
      return { selfEl, heading: item };
    },
  };

  const contentEl = document.createElement("div");
  const renderedHeading = document.createElement("h2");
  renderedHeading.textContent = "apple 1";
  renderedHeading.scrollIntoView = () => {
    renderedHeading.dataset.scrolled = "yes";
  };
  contentEl.appendChild(renderedHeading);

  const markdownView = {
    file: rootFile,
    contentEl,
    getViewType: () => "markdown",
  };

  const app = {
    workspace: {
      activeLeaf: { view: markdownView },
      getLeavesOfType: () => [{ view }],
      iterateAllLeaves(callback) {
        callback({ view: markdownView });
      },
    },
    metadataCache: {
      getFileCache: (file) => cacheByPath.get(file.path) ?? null,
      getFirstLinkpathDest: (path) => (path === "apple.md" ? appleFile : null),
    },
  };

  const integration = new OutlineIntegration(app, () => ({ enabled: true }));
  integration.start();

  const embeddedItem = view.cachedHeadingDom.find((item) =>
    item.selfEl.hasAttribute("data-aeih-outline-key"),
  );
  assert.ok(embeddedItem);

  const key = embeddedItem.selfEl.getAttribute("data-aeih-outline-key");
  renderedHeading.setAttribute("data-aeih-outline-key", key);

  embeddedItem.selfEl.dispatchEvent(
    new dom.window.MouseEvent("click", { bubbles: true, button: 0 }),
  );

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(renderedHeading.dataset.scrolled, "yes");

  integration.destroy();
});

test("retries an outline view that loads after startup", async () => {
  document.body.innerHTML = "";

  const rootFile = { path: "fruits.md", extension: "md" };
  const appleFile = { path: "apple.md", extension: "md" };
  const containerEl = document.createElement("div");
  document.body.appendChild(containerEl);

  const placeholder = { containerEl };
  const realView = {
    file: rootFile,
    containerEl,
    cachedHeadingDom: [],
    getHeadings() {
      return [
        heading("fruits 1", 1, 0),
        heading("apple 1", 2, 2),
      ];
    },
    update() {
      this.cachedHeadingDom = this.getHeadings().map((item) =>
        this.createItemDom(item),
      );
    },
    createItemDom(item) {
      const selfEl = document.createElement("div");
      selfEl.className = "tree-item-self";
      selfEl.textContent = item.heading;
      containerEl.appendChild(selfEl);
      return { selfEl, heading: item };
    },
  };

  let loaded = false;
  const app = {
    workspace: {
      activeLeaf: null,
      getLeavesOfType: () => [{ view: loaded ? realView : placeholder }],
      iterateAllLeaves() {},
    },
    metadataCache: {
      getFileCache: (file) =>
        file.path === rootFile.path
          ? {
              headings: [heading("fruits 1", 1, 0)],
              embeds: [embed("apple.md", 1)],
            }
          : { headings: [heading("apple 1", 1, 0)], embeds: [] },
      getFirstLinkpathDest: (path) => (path === "apple.md" ? appleFile : null),
    },
  };

  const integration = new OutlineIntegration(app, () => ({ enabled: true }));
  integration.start();

  assert.equal(
    Object.prototype.hasOwnProperty.call(placeholder, "getHeadings"),
    false,
  );

  loaded = true;
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(
    Object.prototype.hasOwnProperty.call(realView, "getHeadings"),
    true,
    "the deferred view should be patched after it loads",
  );
  assert.equal(realView.cachedHeadingDom.length, 2);

  integration.destroy();
});

test("restores outline methods that live on the view prototype", () => {
  document.body.innerHTML = "";

  const rootFile = { path: "fruits.md", extension: "md" };
  const containerEl = document.createElement("div");
  document.body.appendChild(containerEl);

  function FakeOutlineView() {
    this.file = rootFile;
    this.containerEl = containerEl;
    this.cachedHeadingDom = [];
  }

  FakeOutlineView.prototype.getHeadings = function () {
    return [heading("fruits 1", 1, 0)];
  };

  FakeOutlineView.prototype.update = function () {
    this.cachedHeadingDom = this.getHeadings().map((item) =>
      this.createItemDom(item),
    );
  };

  FakeOutlineView.prototype.createItemDom = function (item) {
    const selfEl = document.createElement("div");
    selfEl.textContent = item.heading;
    containerEl.appendChild(selfEl);
    return { selfEl, heading: item };
  };

  const view = new FakeOutlineView();
  const app = {
    workspace: {
      activeLeaf: null,
      getLeavesOfType: () => [{ view }],
      iterateAllLeaves() {},
    },
    metadataCache: {
      getFileCache: () => ({
        headings: [heading("fruits 1", 1, 0)],
        embeds: [],
      }),
      getFirstLinkpathDest: () => null,
    },
  };

  const integration = new OutlineIntegration(app, () => ({ enabled: true }));
  integration.start();

  assert.equal(
    Object.prototype.hasOwnProperty.call(view, "getHeadings"),
    true,
    "the integration should install its own heading method",
  );

  integration.stop();

  assert.equal(
    Object.prototype.hasOwnProperty.call(view, "getHeadings"),
    false,
    "the prototype heading method should be restored",
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(view, "update"),
    false,
    "the prototype update method should be restored",
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(view, "createItemDom"),
    false,
    "the prototype item creation method should be restored",
  );
  assert.equal(view.getHeadings()[0].heading, "fruits 1");

  integration.destroy();
});

