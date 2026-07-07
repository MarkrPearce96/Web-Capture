"use strict";

// Pure helpers shared by background.js and content.js. Loaded as a plain
// script in the extension (functions become globals) and via require() in
// Node tests — no ES modules, so it can run in both without a build step.

// var (not const): this file is re-injected into the tab on every capture,
// and re-injected scripts re-evaluate in the same persistent world, so a
// top-level const/let here would throw "already declared" on the second
// capture. var (and function declarations) tolerate redeclaration.
var MAX_CANVAS_PX = 16384;

// Y offsets to scroll to, top to bottom, so stitched frames cover the whole
// page. The last step is clamped to the lowest scrollable offset; a page no
// taller than one viewport yields a single step at 0.
function computeScrollSteps(pageHeight, viewportHeight) {
  if (!(viewportHeight > 0)) {
    return [0];
  }
  const maxTop = Math.max(0, pageHeight - viewportHeight);
  const steps = [];
  for (let y = 0; y < maxTop; y += viewportHeight) {
    steps.push(y);
  }
  steps.push(maxTop);
  return steps;
}

function buildFilename(host, date) {
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const hms = `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  const safeHost = (host || "").replace(/[^\w.-]+/g, "-") || "page";
  return `${safeHost} ${ymd} at ${hms}.png`;
}

function cappedCanvasHeight(pageHeight, dpr) {
  return Math.min(Math.round(pageHeight * dpr), MAX_CANVAS_PX);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { computeScrollSteps, buildFilename, cappedCanvasHeight, MAX_CANVAS_PX };
}
