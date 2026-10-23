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
