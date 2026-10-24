import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const require = createRequire(import.meta.url);
const { HeadingNavigationBridge } = require("./.tmp/navigationBridge.cjs");

function wait(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSetup() {
  const file = { path: "root.md", extension: "md" };
  const token = {
    file,
    filePath: file.path,
    meta: {
      key: "[\"root.md\",[0],\"apple.md\",1]",
      rootPath: file.path,
      embedPath: [0],
      targetPath: "apple.md",
      targetLine: 1,
      originalLevel: 2,
      embedLine: 1,
    },
    heading: "apple 2",
    level: 3,
    line: 1.5,
    col: 1,
    offset: 2 ** 40 + 12345,
    endOffset: 2 ** 40 + 12352,
    realLine: 1,
  };

  class FakeDoc {
    line(line) {
      if (line < 1 || line > 4) {
        throw new RangeError(`Invalid line number ${line}`);
      }
      return { number: line, from: (line - 1) * 10, to: line * 10 };
    }
  }

  class FakeRenderer {
    applyScroll(line) {
      this.lastScroll = line;
      return true;
    }

    applyScrollDelayed(line) {
      this.lastScrollDelayed = line;
      return true;
    }
  }

  class FakeEditor {
    constructor() {
      this.cm = { state: { doc: new FakeDoc() } };
    }

    offsetToPos(offset) {
      return { line: 0, ch: offset };
    }

    posToOffset(pos) {
      return pos.ch;
    }

    setCursor(pos) {
      this.cursor = pos;
    }

    setSelection(anchor, head) {
      this.selection = [anchor, head];
    }

    scrollIntoView(range) {
      this.scrollRange = range;
    }
  }

  class FakeView {
    constructor() {
      this.file = file;
      this.contentEl = document.createElement("div");
      this.editor = new FakeEditor();
      this.previewMode = { renderer: new FakeRenderer() };
      this.lastState = null;
    }

    getViewType() {
      return "markdown";
    }

    setEphemeralState(state) {
      this.lastState = state;
    }
  }

  class FakeLeaf {
    constructor(view) {
      this.view = view;
    }

    async openFile(target, options) {
      this.lastOpen = { target, options };
    }
  }

  const view = new FakeView();
  const leaf = new FakeLeaf(view);
  const workspace = {
    activeLeaf: leaf,
    getLeavesOfType: () => [leaf],
    iterateAllLeaves: (callback) => callback(leaf),
  };
  const app = { workspace };
  const metadata = {
    resolveVirtualOffset: (offset) => (offset === token.offset ? token : null),
    resolveVirtualLine: (candidate, line) =>
      candidate?.path === file.path && line === token.line ? token : null,
    resolveVirtualSubpath: (candidate, subpath) =>
      candidate?.path === file.path && subpath === "#apple 2" ? token : null,
  };

  const scrollCalls = [];
  const heading = document.createElement("h2");
  heading.textContent = token.heading;
  heading.setAttribute("data-aeih-outline-key", token.meta.key);
  heading.getClientRects = () => [{ width: 1, height: 1 }];
  heading.scrollIntoView = (options) => scrollCalls.push(options);
  view.contentEl.appendChild(heading);

  const originals = {
    setEphemeralState: FakeView.prototype.setEphemeralState,
    offsetToPos: FakeEditor.prototype.offsetToPos,
    line: FakeDoc.prototype.line,
    applyScroll: FakeRenderer.prototype.applyScroll,
    openFile: FakeLeaf.prototype.openFile,
  };

  const bridge = new HeadingNavigationBridge(app, metadata);
  bridge.start();

  return {
    bridge,
    file,
    leaf,
    metadata,
    originals,
    scrollCalls,
    token,
    view,
  };
}

test("maps virtual ephemeral-state lines and subpaths", async () => {
  const { view, token, scrollCalls } = makeSetup();

  view.setEphemeralState({
    line: token.line,
    cursor: { line: token.line, ch: 4 },
  });

  assert.equal(view.lastState.line, token.realLine);
  assert.deepEqual(view.lastState.cursor, { line: token.realLine, ch: 0 });

  await wait();
  assert.equal(scrollCalls.length, 1);
  assert.equal(scrollCalls[0].block, "center");

  view.setEphemeralState({ subpath: "#apple 2" });
  assert.equal(view.lastState.subpath, undefined);
  assert.equal(view.lastState.line, token.realLine);
  assert.deepEqual(view.lastState.cursor, { line: token.realLine, ch: 0 });
});

test("maps virtual offsets and re-applies the scroll after openFile", async () => {
  const { bridge, file, leaf, scrollCalls, token, view } = makeSetup();

  assert.deepEqual(view.editor.offsetToPos(token.offset), {
    line: token.realLine,
    ch: 0,
  });

  await wait();
  assert.equal(scrollCalls.length, 1);
  scrollCalls.length = 0;

  await leaf.openFile(file, { eState: { line: token.line } });
  await wait();
  assert.equal(scrollCalls.length, 1);
  assert.equal(scrollCalls[0].block, "center");

  bridge.destroy();
});

test("maps CodeMirror lines and preview applyScroll", async () => {
  const { scrollCalls, token, view } = makeSetup();

  const doc = view.editor.cm.state.doc;
  const line = doc.line(token.line + 1);
  assert.equal(line.number, token.realLine + 1);

  // Line lookups are passive; they must not steal the scroll position from
  // active-heading tracking or other hit-testing code.
  await wait();
  assert.equal(scrollCalls.length, 0);

  // CodeMirror can replace the document object on edits while reusing the
  // same prototype. Resolve the owning view dynamically in that case.
  const NextDoc = doc.constructor;
  const nextDoc = new NextDoc();
  view.editor.cm.state.doc = nextDoc;
  assert.equal(nextDoc.line(token.line + 1).number, token.realLine + 1);

  await wait();
  assert.equal(scrollCalls.length, 0);

  view.previewMode.renderer.applyScroll(token.line);
  assert.equal(view.previewMode.renderer.lastScroll, token.realLine);

  await wait();
  assert.equal(scrollCalls.length, 1);
});

test("restores the original methods on destroy", () => {
  const { bridge, originals, view } = makeSetup();

  assert.notEqual(view.setEphemeralState, originals.setEphemeralState);
  assert.notEqual(view.editor.offsetToPos, originals.offsetToPos);
  assert.notEqual(view.editor.cm.state.doc.line, originals.line);
  assert.notEqual(view.previewMode.renderer.applyScroll, originals.applyScroll);

  bridge.destroy();

  assert.equal(
    Object.getPrototypeOf(view).setEphemeralState,
    originals.setEphemeralState,
  );
  assert.equal(
    Object.getPrototypeOf(view.editor).offsetToPos,
    originals.offsetToPos,
  );
  assert.equal(
    Object.getPrototypeOf(view.editor.cm.state.doc).line,
    originals.line,
  );
  assert.equal(
    Object.getPrototypeOf(view.previewMode.renderer).applyScroll,
    originals.applyScroll,
  );
});
