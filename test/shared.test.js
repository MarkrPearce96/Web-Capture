"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeScrollSteps,
  buildFilename,
  cappedCanvasHeight,
  MAX_CANVAS_PX,
} = require("../extension/shared.js");

test("computeScrollSteps: page needing a partial last frame", () => {
  assert.deepEqual(computeScrollSteps(2500, 1000), [0, 1000, 1500]);
});

test("computeScrollSteps: page exactly one viewport tall", () => {
  assert.deepEqual(computeScrollSteps(1000, 1000), [0]);
});

test("computeScrollSteps: page shorter than the viewport", () => {
  assert.deepEqual(computeScrollSteps(600, 1000), [0]);
});

test("computeScrollSteps: page an exact multiple of the viewport", () => {
  assert.deepEqual(computeScrollSteps(2000, 1000), [0, 1000]);
});

test("buildFilename: formats host, date, and time", () => {
  const date = new Date(2026, 6, 6, 23, 55, 12); // 2026-07-06 23:55:12 local
  assert.equal(buildFilename("example.com", date), "example.com 2026-07-06 at 23.55.12.png");
});

test("buildFilename: zero-pads single-digit fields", () => {
  const date = new Date(2026, 0, 5, 9, 4, 3);
  assert.equal(buildFilename("example.com", date), "example.com 2026-01-05 at 09.04.03.png");
});

test("buildFilename: sanitizes unsafe host characters", () => {
  const date = new Date(2026, 6, 6, 12, 0, 0);
  assert.equal(buildFilename("weird host/name", date), "weird-host-name 2026-07-06 at 12.00.00.png");
});

test("buildFilename: falls back to 'page' for an empty host", () => {
  const date = new Date(2026, 6, 6, 12, 0, 0);
  assert.equal(buildFilename("", date), "page 2026-07-06 at 12.00.00.png");
});

test("cappedCanvasHeight: below the cap is untouched", () => {
  assert.equal(cappedCanvasHeight(5000, 2), 10000);
});

test("cappedCanvasHeight: above the cap is clamped", () => {
  assert.equal(cappedCanvasHeight(10000, 2), MAX_CANVAS_PX);
  assert.equal(MAX_CANVAS_PX, 16384);
});
