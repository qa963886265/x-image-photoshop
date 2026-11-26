"use strict";

const assert = require("node:assert/strict");
const { selectionPlan, garmentSelectionPlans, featherMaskInward, featherMaskPercent, decontaminateGarmentEdge, refineGarmentMatte, classifyReference, resolveReferencePart, resolveGarmentAssignments, garmentReplacementPrompt } = require("../plugin/lib/auto-selection.js");

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

const clothes = selectionPlan(labels, width, height, 2000, 2000, "clothes");
assert.ok(clothes.mask.bytes.some((value) => value === 255), "clothing extraction includes garment pixels");
assert.equal(clothes.mask.bytes[0], 0, "clothing extraction excludes background pixels");

const outfit = new Uint8Array(width * height);
for (let y = 3; y < 8; y++) outfit.fill(4, y * width + 6, y * width + 14);
for (let y = 9; y < 15; y++) outfit.fill(5, y * width + 7, y * width + 13);
for (let y = 5; y < 15; y++) outfit.fill(7, y * width + 8, y * width + 12);
outfit[15 * width + 10] = 8;
const garmentPlans = garmentSelectionPlans(outfit, width, height, 2000, 2000);
assert.deepEqual(garmentPlans.map((plan) => plan.part), ["upper", "lower", "dress"]);
for (const plan of garmentPlans) assert.ok(plan.mask.bytes.some((value) => value === 255), `${plan.part} has extracted pixels`);
assert.equal(garmentPlans.find((plan) => plan.part === "dress").mask.bytes.reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0), 400000,
  "dress mask contains dress pixels only, not belt pixels");
assert.throws(() => garmentSelectionPlans(new Uint8Array(width * height), width, height, 2000, 2000), /没有识别到上衣/);

const combined = selectionPlan(outfit, width, height, 2000, 2000, ["lower", "upper"]);
assert.deepEqual(combined.parts, ["lower", "upper"], "a single edit mask can cover multiple garment categories");
assert.ok(combined.mask.bytes.some((value) => value === 255), "combined garment mask includes both detected categories");

const assignments = resolveGarmentAssignments(["lower", "upper", "lower"]);
assert.deepEqual(assignments, [
  { part: "lower", referenceIndexes: [2, 4] },
  { part: "upper", referenceIndexes: [3] }
], "each garment category keeps the original reference-image numbering");
const replacementPrompt = garmentReplacementPrompt(assignments);
assert.match(replacementPrompt, /图一中的下装替换为图二、图四所示的下装/);
assert.match(replacementPrompt, /图一中的上衣替换为图三所示的上衣/);
assert.throws(() => resolveGarmentAssignments(["upper", null]), /图3未能明确识别/);

const hardMask = new Uint8Array(1600);
for (let y = 8; y < 32; y++) hardMask.fill(255, y * 40 + 8, y * 40 + 32);
const smoothMask = featherMaskInward(hardMask, 40, 40);
assert.equal(smoothMask[0], 0, "antialiasing does not expand into background");
assert.ok(smoothMask[8 * 40 + 8] > 0 && smoothMask[8 * 40 + 8] < 255, "garment edge gets partial alpha");
assert.ok(smoothMask[20 * 40 + 12] < 255, "feather reaches several pixels into the garment");
assert.equal(smoothMask[20 * 40 + 20], 255, "garment interior remains fully opaque");

const percentMask = new Uint8Array(100 * 100);
for (let y = 20; y < 80; y += 1) percentMask.fill(255, y * 100 + 20, y * 100 + 80);
const percentFeather = featherMaskPercent(percentMask, 100, 100, 0.05);
assert.equal(percentFeather.radius, 5, "five percent uses the mask short edge as the pixel radius");
assert.ok(percentFeather.bytes[20 * 100 + 20] > 0 && percentFeather.bytes[20 * 100 + 20] < 255,
  "percentage feather creates a soft editable mask boundary");
assert.equal(percentFeather.bytes[50 * 100 + 50], 255, "percentage feather preserves the mask interior");
assert.equal(percentFeather.bytes[0], 0, "background remains hidden outside the feather reach");

const matteWidth = 15, matteHeight = 15;
const matteMask = new Uint8Array(matteWidth * matteHeight);
for (let y = 4; y < 11; y++) matteMask.fill(255, y * matteWidth + 4, y * matteWidth + 11);
const matteAlpha = featherMaskInward(matteMask, matteWidth, matteHeight);
const mattePixels = new Uint8Array(matteWidth * matteHeight * 3);
mattePixels.fill(220);
for (let y = 4; y < 11; y++) for (let x = 4; x < 11; x++) {
  const offset = (y * matteWidth + x) * 3;
  mattePixels[offset] = mattePixels[offset + 1] = mattePixels[offset + 2] = 24;
}
const fringeIndex = 7 * matteWidth + 4;
mattePixels[fringeIndex * 3] = mattePixels[fringeIndex * 3 + 1] = mattePixels[fringeIndex * 3 + 2] = 220;
refineGarmentMatte(mattePixels, 3, matteMask, matteAlpha, matteWidth, matteHeight);
assert.equal(matteAlpha[fringeIndex], 0, "background-colored pixels included by the mask are suppressed");

const fringeMask = new Uint8Array(49);
fringeMask[3 * 7 + 3] = 255;
fringeMask[3 * 7 + 2] = 96;
const fringeRgba = new Uint8Array(49 * 4);
fringeRgba.fill(255);
fringeRgba[(3 * 7 + 3) * 4] = 24;
fringeRgba[(3 * 7 + 3) * 4 + 1] = 28;
fringeRgba[(3 * 7 + 3) * 4 + 2] = 32;
decontaminateGarmentEdge(fringeRgba, fringeMask, 7, 7);
assert.deepEqual(Array.from(fringeRgba.slice((3 * 7 + 2) * 4, (3 * 7 + 2) * 4 + 3)), [24, 28, 32],
  "partial-alpha edge pixels remove source-background color fringe");

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
