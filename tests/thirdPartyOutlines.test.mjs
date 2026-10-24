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
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

const require = createRequire(import.meta.url);
const { MetadataHeadingIntegration } = require("./.tmp/metadataHeadings.cjs");
const { ThirdPartyOutlineIntegration } = require("./.tmp/thirdPartyOutlines.cjs");

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

function setup() {
  const rootFile = { path: "fruits.md", extension: "md" };
  const appleFile = { path: "apple.md", extension: "md" };
  const cacheByPath = new Map([
    [
      rootFile.path,
      {
        headings: [heading("fruits 1", 1, 0), heading("fruits 2", 2, 4)],
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

  const app = {
    workspace: {
      activeLeaf: null,
      iterateAllLeaves(callback) {
        if (this.activeLeaf) {
          callback(this.activeLeaf);
        }
      },
    },
    metadataCache: {
      getFileCache(file) {
        return cacheByPath.get(file.path) ?? null;
      },
      getFirstLinkpathDest(path) {
        return filesByPath.get(path) ?? null;
      },
    },
    plugins: {
      plugins: {},
    },
  };

  const metadata = new MetadataHeadingIntegration(app, () => ({
    enabled: true,
  }));
  metadata.start();

  const navigations = [];
  const thirdParty = new ThirdPartyOutlineIntegration(
    app,
    metadata,
    (file, line) => {
      navigations.push({ file, line });
      return true;
    },
  );
  thirdParty.start();

  return { app, rootFile, metadata, thirdParty, navigations };
}

class FakeQuietNavigator {
  constructor(plugin) {
    this.plugin = plugin;
    this.view = { file: plugin.file };
    this.lastJump = null;
    this.lastJumpWithoutFocus = null;
    this.menuOpened = 0;
    this.dropCalls = 0;
  }

  getId() {
    return "markdown";
  }

  async getHeaders() {
    const cache = this.plugin.app.metadataCache.getFileCache(this.view.file);
    return (cache?.headings ?? []).map((item) => ({
      title: item.heading,
      level: item.level,
      line: item.position.start.line,
    }));
  }

  async jump(index) {
    this.lastJump = index;
  }

  async jumpWithoutFocus(index) {
    this.lastJumpWithoutFocus = index;
  }

  onRightClick(index) {
    this.menuOpened += 1;
    this.lastRightClick = index;
  }

  async handleDrop(sourceIndex, targetIndex) {
    this.dropCalls += 1;
    this.lastDrop = [sourceIndex, targetIndex];
  }
}

class FakeQuietPlugin {
  constructor(app, file) {
    this.app = app;
    this.file = file;
    this.navigator = new FakeQuietNavigator(this);
    this.refreshCount = 0;
  }

  async updateNav() {
    this.navigator = new FakeQuietNavigator(this);
  }

  async updateNavAndRefresh() {
    await this.updateNav();
  }

  refresh() {
    this.refreshCount += 1;
  }
}

test("Quiet Outline shows embedded headings and keeps them safe to edit", async () => {
  document.body.innerHTML = "";
  const { app, rootFile, metadata, thirdParty } = setup();

  const plugin = new FakeQuietPlugin(app, rootFile);
  app.plugins.plugins["obsidian-quiet-outline"] = plugin;

  // patchAll ran before the plugin existed, so run the layout hook once.
  thirdParty.onLayoutChange();

  const headers = await plugin.navigator.getHeaders();
  assert.deepEqual(
    headers.map((item) => ({ title: item.title, level: item.level })),
    [
      { title: "fruits 1", level: 1 },
      { title: "apple 1", level: 2 },
      { title: "apple 2", level: 3 },
      { title: "fruits 2", level: 2 },
    ],
  );
  assert.ok(headers[1].aeih);

  // Navigation is handled by HeadingNavigationBridge; the outline integration
  // only needs to preserve the plugin's normal jump methods and block edits.
  await plugin.navigator.jump(1);
  assert.equal(plugin.navigator.lastJump, 1);

  // Synthetic entries must not open the editing menu or accept drops.
  plugin.navigator.onRightClick(1);
  assert.equal(plugin.navigator.menuOpened, 0);
  plugin.navigator.onRightClick(0);
  assert.equal(plugin.navigator.menuOpened, 1);

  await plugin.navigator.handleDrop(0, 1);
  assert.equal(plugin.navigator.dropCalls, 0);
  await plugin.navigator.handleDrop(0, 0);
  assert.equal(plugin.navigator.dropCalls, 1);

  // A navigator recreated by Quiet Outline inherits the prototype patch.
  await plugin.updateNav();
  const nextHeaders = await plugin.navigator.getHeaders();
  assert.ok(nextHeaders[1].aeih);

  thirdParty.destroy();
  metadata.destroy();

  const rawHeaders = await plugin.navigator.getHeaders();
  assert.equal(rawHeaders.length, 2);
  assert.equal(rawHeaders[1].aeih, undefined);
});

class FakeSubtleOverlay {
  constructor(plugin) {
    this.plugin = plugin;
    this.view = { file: plugin.file };
    this.settings = { minLevel: 1, maxLevel: 6, show: "both" };
    this.headings = [];
    this.activeIndex = -1;
    this.setActiveCalls = [];
    this.lastNavigate = null;
  }

  refresh() {
    const cache = this.plugin.app.metadataCache.getFileCache(this.view.file);
    const { minLevel, maxLevel, show } = this.settings;
    this.headings =
      show === "tasks"
        ? []
        : (cache?.headings ?? [])
            .filter(
              (item) => item.level >= minLevel && item.level <= maxLevel,
            )
            .map((item) => ({
              level: item.level,
              text: item.heading,
              line: item.position.start.line,
            }));

    this.activeIndex = -1;
    this.updateActive();
  }

  navigate(index) {
    this.lastNavigate = index;
  }

  updateActive() {
    // Pretend the scroll position selected the first embedded heading.
    this.activeIndex = 1;
  }

  setActive(index) {
    this.activeIndex = index;
    this.setActiveCalls.push(index);
  }
}

class FakeSubtlePlugin {
  constructor(app, file) {
    this.app = app;
    this.file = file;
    this.overlay = new FakeSubtleOverlay(this);
  }

  sync() {
    this.overlay = new FakeSubtleOverlay(this);
  }
}

test("Subtle TOC shows embedded headings and keeps them safe to edit", async () => {
  document.body.innerHTML = "";
  const { app, rootFile, metadata, thirdParty, navigations } = setup();

  const plugin = new FakeSubtlePlugin(app, rootFile);
  app.plugins.plugins["subtle-toc"] = plugin;

  thirdParty.onLayoutChange();

  const overlay = plugin.overlay;
  overlay.refresh();

  assert.deepEqual(
    overlay.headings.map((item) => ({ text: item.text, level: item.level })),
    [
      { text: "fruits 1", level: 1 },
      { text: "apple 1", level: 2 },
      { text: "apple 2", level: 3 },
      { text: "fruits 2", level: 2 },
    ],
  );
  assert.ok(overlay.headings[1].aeih);

  // Embedded headings share the embed line, so the real parent heading
  // remains the active one while scrolling through the embed.
  assert.equal(overlay.activeIndex, 0);

  // Source/live-preview navigation only resolves the embed line through
  // CodeMirror, so the integration asks the bridge for an exact scroll.
  overlay.navigate(1);
  assert.equal(overlay.lastNavigate, 1);
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0].file, rootFile);
  assert.equal(navigations[0].line, overlay.headings[1].line);

  // A replacement overlay is patched by the wrapped sync().
  plugin.sync();
  assert.notEqual(plugin.overlay, overlay);
  plugin.overlay.refresh();
  assert.ok(plugin.overlay.headings[1].aeih);

  thirdParty.destroy();
  metadata.destroy();

  plugin.overlay.refresh();
  assert.equal(plugin.overlay.headings[1].aeih, undefined);
});
