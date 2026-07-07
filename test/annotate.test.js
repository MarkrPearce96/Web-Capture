"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { arrowHeadPoints, distancePointToSegment } = require("../extension/annotate.js");

test("arrowHeadPoints: horizontal arrow barbs sit ~91.34px back, ±5px off the shaft", () => {
  const barbs = arrowHeadPoints(0, 0, 100, 0, 10);
  const expectedX = 100 - 10 * Math.cos(Math.PI / 6);
  const expectedY = 10 * Math.sin(Math.PI / 6);
  assert.equal(barbs.length, 2);
  for (const b of barbs) {
    assert.ok(Math.abs(b.x - expectedX) < 0.01);
    assert.ok(Math.abs(Math.abs(b.y) - expectedY) < 0.01);
  }
  // One barb above the shaft (y < 0), one below (y > 0).
  assert.ok(barbs.some((b) => b.y < 0));
  assert.ok(barbs.some((b) => b.y > 0));
});

test("arrowHeadPoints: both barbs are exactly headLength from the tip on a diagonal shaft", () => {
  const headLength = 10;
  const barbs = arrowHeadPoints(0, 0, 3, 4, headLength);
  for (const b of barbs) {
    const dist = Math.hypot(b.x - 3, b.y - 4);
    assert.ok(Math.abs(dist - headLength) < 0.01);
  }
});

test("arrowHeadPoints: vertical arrow barbs are symmetric about the shaft and both above the tip", () => {
  const barbs = arrowHeadPoints(0, 0, 0, 50, 10);
  assert.equal(barbs.length, 2);
  assert.ok(Math.abs(barbs[0].x + barbs[1].x) < 0.01);
  for (const b of barbs) {
    assert.ok(b.y < 50);
  }
});

test("distancePointToSegment: a point on the segment is distance 0", () => {
  assert.equal(distancePointToSegment(5, 0, 0, 0, 10, 0), 0);
});

test("distancePointToSegment: a point beyond an endpoint clamps to that endpoint", () => {
  assert.equal(distancePointToSegment(13, 4, 0, 0, 10, 0), 5);
});

test("distancePointToSegment: perpendicular distance to the middle of the segment", () => {
  assert.equal(distancePointToSegment(5, 7, 0, 0, 10, 0), 7);
});

test("distancePointToSegment: a degenerate zero-length segment is just distance to the point", () => {
  assert.equal(distancePointToSegment(3, 4, 0, 0, 0, 0), 5);
});
