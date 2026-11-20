"use strict";

const assert = require("node:assert/strict");
const { selectionPlan, classifyReference, resolveReferencePart } = require("../plugin/lib/auto-selection.js");

const width = 20;
const height = 20;
const labels = new Uint8Array(width * height);
for (let y = 4; y < 16; y += 1) {
  for (let x = 6; x < 14; x += 1) labels[y * width + x] = 4;
}
for (let y = 2; y < 6; y += 1) {
  for (let x = 8; x < 12; x += 1) labels[y * width + x] = 2;
}
labels[5 * width + 9] = 11;

const upper = selectionPlan(labels, width, height, 2000, 2000, "upper");
assert.equal(upper.ratio, "3:4");
assert.equal(upper.bounds.width * 4, upper.bounds.height * 3);
assert.ok(upper.bounds.left <= 600 && upper.bounds.right >= 1400);
assert.ok(upper.mask.bytes.some((value) => value === 255));
assert.equal(upper.mask.bytes[0], 0, "background is excluded from edit mask");
const hairX = Math.floor((9 + 0.5) * 2000 / width) - upper.bounds.left;
const hairY = Math.floor((4 + 0.5) * 2000 / height) - upper.bounds.top;
assert.equal(upper.mask.bytes[hairY * upper.bounds.width + hairX], 0, "hair is protected from clothing edits");

const head = selectionPlan(labels, width, height, 2000, 2000, "head");
assert.ok(head.bounds.top < upper.bounds.top);
assert.ok(head.mask.bytes.some((value) => value === 255));
const edge = new Uint8Array(20 * 20);
for (let y = 0; y < 4; y++) edge.fill(5, y * 20, y * 20 + 20);
const wide = selectionPlan(edge, 20, 20, 1600, 1200, "lower");
assert.equal(wide.ratio, "4:3");
assert.equal(wide.bounds.width * 3, wide.bounds.height * 4);
assert.equal(wide.bounds.top, 0);
assert.equal(wide.mask.bytes[1599], 255);
const centered = new Uint8Array(20 * 20);
for (let y = 6; y < 14; y++) centered.fill(4, y * 20 + 6, y * 20 + 14);
assert.equal(selectionPlan(centered, 20, 20, 1000, 1000, "upper").ratio, "1:1");
assert.throws(() => selectionPlan(labels, width, height, 2000, 2000, "invalid"), /有效/);
const model = new Uint8Array(1000);
model.fill(4, 0, 250);
model.fill(6, 250, 310);
model.fill(11, 310, 320);
assert.equal(classifyReference(model), null);
assert.equal(resolveReferencePart([classifyReference(model), classifyReference(centered)]), "upper");
assert.throws(() => resolveReferencePart(["upper", null, "lower"]), /不同类别/);
assert.throws(() => resolveReferencePart([null, null]), /未识别/);
console.log("auto-selection: reference classification, semantic masks, bounds, and head protection passed");
