import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  clampHeadingLevel,
  headingLevelFromClasses,
  headingLevelFromTagName,
  headingLevelFromText,
  shiftHeadingLevel,
} = require("./.tmp/headingMath.cjs");
const { nearestPrecedingHeadingLevel, parseHeadingLines } = require("./.tmp/headingSource.cjs");

test("clamps heading levels", () => {
  assert.equal(clampHeadingLevel(0), 1);
  assert.equal(clampHeadingLevel(3.9), 3);
  assert.equal(clampHeadingLevel(7), 6);
});

test("shifts heading levels and clamps at six", () => {
  assert.equal(shiftHeadingLevel(1, 0), 1);
  assert.equal(shiftHeadingLevel(1, 1), 2);
  assert.equal(shiftHeadingLevel(2, 2), 4);
  assert.equal(shiftHeadingLevel(4, 3), 6);
});

test("reads heading levels from tags and Live Preview classes", () => {
  assert.equal(headingLevelFromTagName("H2"), 2);
  assert.equal(headingLevelFromTagName("P"), null);
  assert.equal(headingLevelFromClasses(["cm-line", "HyperMD-header-3"]), 3);
  assert.equal(headingLevelFromClasses(["cm-line"]), null);
  assert.equal(headingLevelFromText("## Heading"), 2);
  assert.equal(headingLevelFromText("plain text"), null);
});

test("finds the nearest preceding heading", () => {
  const headings = [
    { line: 0, level: 1 },
    { line: 4, level: 2 },
    { line: 8, level: 3 },
  ];

  assert.equal(nearestPrecedingHeadingLevel(headings, 0), 0);
  assert.equal(nearestPrecedingHeadingLevel(headings, 1), 1);
  assert.equal(nearestPrecedingHeadingLevel(headings, 5), 2);
  assert.equal(nearestPrecedingHeadingLevel(headings, 9), 3);
});

test("parses ATX, setext, fenced, and frontmatter headings", () => {
  const lines = [
    "---",
    "title: ignored",
    "---",
    "# One",
    "",
    "Setext two",
    "---------",
    "",
    "```md",
    "# not a heading",
    "```",
    "### Three ###",
  ];

  assert.deepEqual(parseHeadingLines(lines), [
    { line: 3, level: 1 },
    { line: 6, level: 2 },
    { line: 11, level: 3 },
  ]);
});
