"use strict";

// Markup tools (pen/line/arrow/rectangle/ellipse) for the preview overlay.
// Injected between pdf.js and content.js (see background.js's
// injectScripts) — content.js owns the overlay chrome and calls
// createAnnotator() once the preview <img> has finished loading. Also
// Node-requirable for its pure geometry (arrowHeadPoints), which is why the
// top level below sticks to `function`/`var` only, same re-injection-safety
// convention as shared.js and pdf.js: this script is injected into the page
// on every capture, and a top-level const/let would throw "already
// declared" on a second injection.

// ---- Pure geometry (Node-testable) -------------------------------------

// Returns the two barb endpoints of an arrowhead for a shaft (x1,y1)->(x2,y2),
// barbs swept back 30° either side of the shaft at distance headLength from the tip.
function arrowHeadPoints(x1, y1, x2, y2, headLength) {
  var angle = Math.atan2(y2 - y1, x2 - x1);
  var spread = Math.PI / 6;
  return [
    { x: x2 - headLength * Math.cos(angle - spread), y: y2 - headLength * Math.sin(angle - spread) },
    { x: x2 - headLength * Math.cos(angle + spread), y: y2 - headLength * Math.sin(angle + spread) },
  ];
}

// Distance from point (px,py) to the segment (x1,y1)-(x2,y2). Used by the
// Select tool's hit-testing (see onPointerDown / hitTest below): every
// tool's stroke geometry reduces to one or more segments (or a single point
// for a degenerate one-point pen stroke, handled by the lengthSq === 0
// clamp), so this one function covers pen/line/arrow hit-testing.
function distancePointToSegment(px, py, x1, y1, x2, y2) {
  var dx = x2 - x1;
  var dy = y2 - y1;
  var lengthSq = dx * dx + dy * dy;
  var t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
  var cx = x1 + t * dx;
  var cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// ---- Painting -------------------------------------------------------------
// Shared by the live drawing layer (repaint, in natural-px-scaled device
// coordinates) and renderComposite (identity transform, also natural px) —
// see createAnnotator below for why those two coordinate spaces coincide.

// Highlighter tuning: HIGHLIGHT_ALPHA is the fill/stroke opacity for both
// word-snapped rects and the freehand fallback band (see
// drawHighlightAnnotation); HIGHLIGHT_BAND_CSS is the freehand band's
// default CSS-px thickness at creation time, converted to natural px the
// same way ANNOT_SIZES.cssPx is (see onPointerDown's highlight branch).
var HIGHLIGHT_ALPHA = 0.4;
var HIGHLIGHT_BAND_CSS = 16;

function drawAnnotation(ctx, a) {
  // Text and Highlight annotations have no stroke (their color/width don't
  // map onto strokeStyle/lineWidth the way every other tool's does) and each
  // has its own ctx.save/restore, so both are handled entirely separately,
  // before the stroke-oriented setup below runs (that setup assumes
  // `a.width` exists, which neither of these annotations have).
  if (a.tool === "text") {
    drawTextAnnotation(ctx, a);
    return;
  }

  if (a.tool === "highlight") {
    drawHighlightAnnotation(ctx, a);
    return;
  }

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = a.color;
  ctx.lineWidth = a.width;

  if (a.tool === "pen") {
    drawPenStroke(ctx, a.points);
    return;
  }

  if (a.tool === "line") {
    ctx.beginPath();
    ctx.moveTo(a.x0, a.y0);
    ctx.lineTo(a.x1, a.y1);
    ctx.stroke();
    return;
  }

  if (a.tool === "arrow") {
    ctx.beginPath();
    ctx.moveTo(a.x0, a.y0);
    ctx.lineTo(a.x1, a.y1);
    ctx.stroke();
    var headLength = Math.max(a.width * 3, 12);
    var barbs = arrowHeadPoints(a.x0, a.y0, a.x1, a.y1, headLength);
    for (var i = 0; i < barbs.length; i++) {
      ctx.beginPath();
      ctx.moveTo(a.x1, a.y1);
      ctx.lineTo(barbs[i].x, barbs[i].y);
      ctx.stroke();
    }
    return;
  }

  if (a.tool === "rect") {
    var rx = Math.min(a.x0, a.x1);
    var ry = Math.min(a.y0, a.y1);
    var rw = Math.abs(a.x1 - a.x0);
    var rh = Math.abs(a.y1 - a.y0);
    ctx.strokeRect(rx, ry, rw, rh);
    return;
  }

  if (a.tool === "ellipse") {
    var ex = Math.min(a.x0, a.x1);
    var ey = Math.min(a.y0, a.y1);
    var ew = Math.abs(a.x1 - a.x0);
    var eh = Math.abs(a.y1 - a.y0);
    ctx.beginPath();
    ctx.ellipse(ex + ew / 2, ey + eh / 2, ew / 2, eh / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// Polyline through `points`, smoothed with quadratic curves whose control
// point is each interior point and whose endpoint is the midpoint of that
// point and the next — a standard cheap smoothing trick that avoids the
// faceted look of straight segments without needing spline math. The final
// segment (midpoint of the last two points -> the actual last point) is a
// plain lineTo so the stroke always reaches exactly where the pointer was
// released.
function drawPenStroke(ctx, points) {
  if (!points || points.length < 2) {
    return;
  }
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (var i = 1; i < points.length - 1; i++) {
    var midX = (points[i].x + points[i + 1].x) / 2;
    var midY = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
  }
  var last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

// `a.rects` (word-snapped boxes) and `a.band` (freehand fallback polyline)
// are spatially disjoint by construction (see addHighlightSample in
// createAnnotator — a sampled point either lands in a word box or gets
// added to the band, never both), so both can be drawn under one
// globalAlpha without visibly compounding at their border. The rects are
// unioned into a single fill path rather than filled one at a time so two
// overlapping/adjacent word boxes don't double up their alpha either.
function drawHighlightAnnotation(ctx, a) {
  ctx.save();
  ctx.globalAlpha = HIGHLIGHT_ALPHA;
  ctx.fillStyle = a.color;
  ctx.beginPath();
  for (var i = 0; i < a.rects.length; i++) {
    var r = a.rects[i];
    ctx.rect(r.x, r.y, r.w, r.h);
  }
  ctx.fill();
  if (a.band.length) {
    ctx.strokeStyle = a.color;
    ctx.lineWidth = a.bandWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(a.band[0].x, a.band[0].y);
    for (var j = 1; j < a.band.length; j++) {
      ctx.lineTo(a.band[j].x, a.band[j].y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// The font string text annotations are always measured/drawn with — kept in
// one place so drawTextAnnotation and textBounds can never drift apart.
function textFont(a) {
  return a.fontSize + "px -apple-system, BlinkMacSystemFont, sans-serif";
}

// Padding-inclusive bounds of a text annotation, in the same natural-px
// space as its `x,y`: {x0,y0} is the top-left of the background rect (top
// left of the text minus padding), {x1,y1} the bottom-right. Used by
// hit-testing, the selection cue, and options-popup positioning — every
// consumer that needs to know "how much room does this text box take up"
// without re-measuring itself. Always re-sets ctx.font (save/restored) so
// callers can pass any canvas 2d context regardless of its current font.
function textBounds(ctx, a) {
  ctx.save();
  ctx.font = textFont(a);
  var lines = a.text.split("\n");
  var lineHeight = a.fontSize * 1.3;
  var maxWidth = 0;
  for (var i = 0; i < lines.length; i++) {
    var w = ctx.measureText(lines[i]).width;
    if (w > maxWidth) {
      maxWidth = w;
    }
  }
  ctx.restore();
  var p = a.fontSize * 0.25;
  return {
    x0: a.x - p,
    y0: a.y - p,
    x1: a.x + maxWidth + p,
    y1: a.y + lines.length * lineHeight + p,
  };
}

// Multi-line text, top-left anchored at (a.x, a.y): an optional filled
// background (padded box from textBounds) behind left-aligned, top-baseline
// lines in a.color. save/restore brackets every ctx property this touches
// (font, textBaseline, fillStyle) so it never leaks into the next
// drawAnnotation call in the same repaint/renderComposite loop.
function drawTextAnnotation(ctx, a) {
  ctx.save();
  ctx.font = textFont(a);
  ctx.textBaseline = "top";
  var bounds = textBounds(ctx, a);
  if (a.bg) {
    ctx.fillStyle = a.bg;
    ctx.fillRect(bounds.x0, bounds.y0, bounds.x1 - bounds.x0, bounds.y1 - bounds.y0);
  }
  ctx.fillStyle = a.color;
  var lines = a.text.split("\n");
  var lineHeight = a.fontSize * 1.3;
  for (var i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], a.x, a.y + i * lineHeight);
  }
  ctx.restore();
}

// ---- Toolbar data -----------------------------------------------------

var ANNOT_COLORS = [
  "#ff3b30", // red (default)
  "#ff9500", // orange
  "#ffcc00", // yellow
  "#34c759", // green
  "#5ac8fa", // cyan
  "#007aff", // blue
  "#af52de", // purple
  "#ff2d55", // pink
  "#a2845e", // brown
  "#8e8e93", // grey
  "#000000", // black
  "#ffffff", // white
];

// cssPx is the stored/display stroke width (natural px = cssPx / scale at
// creation time, see createAnnotator); dot is the diameter of the swatch's
// filled preview circle, purely cosmetic.
var ANNOT_SIZES = [
  { cssPx: 2, dot: 4 },
  { cssPx: 4, dot: 6 },
  { cssPx: 8, dot: 9 },
];

// Target-toggle glyphs for the text-box options popup. Text colour: a capital
// "A" over a thick colour bar (the universal text-colour convention).
// Background colour: an "A" sitting on a filled rounded box (fill-behind-text).
// Both use currentColor so they pick up the button's active-blue / idle-grey.
var TEXT_TARGET_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16 12 5l6 11"/><path d="M8.5 12h7"/><path d="M5 20h14" stroke-width="3"/></svg>';
var BG_TARGET_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="none"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 16 11 7l4 9" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.7 12.5h4.6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>';

var ANNOT_TOOLS = [
  {
    id: "select",
    label: "Select",
    icon:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="M13 13l6 6"/></svg>',
  },
  {
    id: "pen",
    label: "Pen",
    icon:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
  },
  {
    id: "highlight",
    label: "Highlighter",
    icon:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>',
  },
  {
    id: "line",
    label: "Line",
    icon:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="19" x2="19" y2="5"/></svg>',
  },
  {
    id: "arrow",
    label: "Arrow",
    icon:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="19" x2="19" y2="5"/><polyline points="9 5 19 5 19 15"/></svg>',
  },
  {
    id: "rect",
    label: "Rectangle",
    icon:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="6" width="16" height="12" rx="1"/></svg>',
  },
  {
    id: "ellipse",
    label: "Ellipse",
    icon:
      '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="6.5"/></svg>',
  },
  {
    id: "text",
    label: "Text",
    icon:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 5h14M12 5v14"/></svg>',
  },
];

function annotStyleText() {
  return `
    .annot-toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      row-gap: 8px;
      padding: 8px 12px;
      font: 13px -apple-system, BlinkMacSystemFont, sans-serif;
      border-top: 1px solid rgba(0,0,0,0.08);
      flex: none;
    }
    .annot-group {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .annot-actions {
      margin-left: auto;
      gap: 8px;
    }
    .annot-divider {
      width: 1px;
      height: 20px;
      background: #e2e2e2;
      flex: none;
    }
    .annot-tool-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: #444;
      cursor: pointer;
    }
    .annot-tool-btn:hover {
      background: #f0f0f0;
    }
    .annot-tool-btn.annot-active {
      background: rgba(34, 115, 242, 0.15);
      color: #2273f2;
    }
    .annot-swatch {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      border: none;
      padding: 0;
      cursor: pointer;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.15);
    }
    .annot-swatch.annot-selected {
      box-shadow: 0 0 0 2px #2273f2;
    }
    .annot-size-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 0;
      border: none;
      border-radius: 6px;
      background: transparent;
      cursor: pointer;
    }
    .annot-size-btn:hover {
      background: #f0f0f0;
    }
    .annot-size-btn.annot-selected {
      background: rgba(34, 115, 242, 0.15);
    }
    .annot-size-dot {
      display: block;
      border-radius: 50%;
      background: #444;
    }
    .annot-text-btn {
      border: none;
      background: transparent;
      color: #2273f2;
      font: inherit;
      font-size: 13px;
      padding: 4px 6px;
      cursor: pointer;
      border-radius: 6px;
    }
    .annot-text-btn:hover {
      background: #f0f0f0;
    }
    .annot-layer {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      touch-action: none;
    }
    .annot-layer.annot-active {
      pointer-events: auto;
      cursor: crosshair;
    }
    .annot-layer.annot-active.annot-tool-select {
      cursor: default;
    }
    .annot-layer.annot-active.annot-tool-select.annot-grabbing {
      cursor: move;
    }
    .annot-layer.annot-active.annot-over-fresh {
      cursor: move;
    }
    .annot-layer.annot-active.annot-tool-text {
      cursor: text;
    }
    .annot-text-editor {
      position: absolute;
      box-sizing: border-box;
      margin: 0;
      border: 1px dashed #2273f2;
      outline: none;
      resize: none;
      overflow: hidden;
      white-space: pre;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      line-height: 1.3;
      z-index: 2;
    }
    .annot-text-options {
      position: absolute;
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-width: 300px;
      padding: 6px 8px;
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2), 0 0 0 1px rgba(0, 0, 0, 0.06);
      z-index: 3;
    }
    .annot-text-options-row {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .annot-text-options .annot-swatch {
      width: 14px;
      height: 14px;
      flex: none;
    }
    .annot-swatch.annot-bg-none {
      background-color: #fff;
      background-image:
        linear-gradient(45deg, #c8c8c8 25%, transparent 25%, transparent 75%, #c8c8c8 75%),
        linear-gradient(45deg, #c8c8c8 25%, transparent 25%, transparent 75%, #c8c8c8 75%);
      background-size: 8px 8px;
      background-position: 0 0, 4px 4px;
    }
    .annot-target-group {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .annot-target-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      background: transparent;
      color: #666;
      padding: 4px 6px;
      border-radius: 6px;
      cursor: pointer;
      flex: none;
    }
    .annot-target-btn:hover {
      background: #f0f0f0;
    }
    .annot-target-btn.annot-active {
      background: rgba(34, 115, 242, 0.15);
      color: #2273f2;
    }
    .annot-text-size-group {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-left: auto;
      flex: none;
    }
    .annot-text-size-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      padding: 0;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: #444;
      font: 13px -apple-system, BlinkMacSystemFont, sans-serif;
      cursor: pointer;
      flex: none;
    }
    .annot-text-size-btn:hover {
      background: #f0f0f0;
    }
    .annot-text-size-value {
      min-width: 20px;
      text-align: center;
      font: 12px -apple-system, BlinkMacSystemFont, sans-serif;
      color: #444;
      flex: none;
    }
    .annot-scan-pill {
      position: absolute;
      top: 10px;
      left: 50%;
      transform: translateX(-50%);
      padding: 6px 12px;
      background: rgba(20, 20, 20, 0.85);
      color: #fff;
      font: 12px -apple-system, BlinkMacSystemFont, sans-serif;
      border-radius: 999px;
      white-space: nowrap;
      pointer-events: none;
      z-index: 4;
    }
  `;
}

// Builds the markup toolbar + transparent drawing layer for one preview
// overlay instance. `options`: { img, sourceCanvas, wrapper, shadowRoot } —
// `wrapper` is a position: relative div (created by content.js) containing
// the preview `img`; `sourceCanvas` is the full-resolution stitched capture
// the `img` was rendered from. Returns { toolbar, hasAnnotations,
// renderComposite, destroy, refresh }. `toolbar` is not appended here —
// content.js places it above the image area. `refresh` re-syncs the layer's
// backing store and re-derives `scale` from the img's current
// `clientWidth` — content.js calls it after changing the preview image's
// zoom, the same way the window-resize listener does internally.
function createAnnotator(options) {
  var img = options.img;
  var sourceCanvas = options.sourceCanvas;
  var wrapper = options.wrapper;
  var shadowRoot = options.shadowRoot;

  var annotations = [];
  var inProgress = null;
  var activePointerId = null;
  // Set while the Select tool has grabbed an annotation (from pointerdown to
  // pointerup/pointercancel): { annotation, lastX, lastY } in natural px.
  // Drag-to-move only — there's no persistent "selected annotation" state
  // once the pointer is released, so this doubles as "is something being
  // dragged right now".
  var grabbed = null;
  // Set to the just-committed annotation immediately after a drawing tool
  // (pen/line/arrow/rect/ellipse) finishes a stroke (see onPointerUp's
  // drawing-commit branch), and cleared on the next drawing pointerdown,
  // tool switch, undo, clear, or once its move-drag (if any) is released.
  // While set, it shows the same dashed selection cue as `grabbed` and, if
  // the next drag starts on it, that drag moves it instead of drawing — see
  // onPointerDown's freshSelection check, ahead of the normal drawing start.
  var freshSelection = null;
  // The text annotation currently showing its dashed selection cue + the
  // floating options popup, or null. Persists across pointer releases
  // (unlike freshSelection/grabbed, which only exist mid-gesture) — see the
  // "Selecting + options popup" behavior in showTextOptions/hideTextOptions
  // below. Set on: a text editor committing non-empty text (new or
  // re-edit), or the Select tool clicking a text annotation without a
  // meaningful drag. Cleared on: a pointerdown elsewhere on the layer, tool
  // switch, undo, clearAll, destroy, or a re-edit committing to empty.
  var activeText = null;
  // Non-null while the inline `<textarea>` editor (see openTextEditor) is
  // open: the editor element itself, the annotation object it's editing
  // (not yet in `annotations` for a brand-new box until commit), and
  // whether that annotation is new (vs. re-editing an existing one — see
  // commitTextEditor's empty-text handling, which differs for each case).
  var textEditorEl = null;
  var textEditorAnnotation = null;
  var textEditorIsNew = false;
  // The floating per-box style popup element for `activeText`, or null
  // when hidden (no active text, or an edit is in progress).
  var textOptionsEl = null;
  // Which property the popup's unified color-swatch row currently applies
  // to: "text" (annotation.color) or "bg" (annotation.bg). Reset to "text"
  // whenever the popup is freshly opened via showTextOptions (see below);
  // preserved across in-popup rebuilds (color pick, target toggle, font
  // size step, resize resync) via refreshTextOptions.
  var textOptionsTarget = "text";
  // Set on a "text" tool pointerdown that isn't a freshSelection move-drag
  // (see onPointerDown), so the matching pointerup can tell a plain click
  // (open a new editor there) apart from a drag (do nothing — text has no
  // drag-to-draw). Natural px, cleared on that pointerup/pointercancel.
  var textDownPt = null;
  // Word boxes from the on-device OCR scan (see scanText), in natural px, or
  // null before the first scan / on failure. Cached for this annotator
  // instance's whole life — a new capture creates a new annotator (see
  // content.js's createAnnotator call), so there's no stale-reuse risk.
  var ocrWords = null;
  // "idle" (never scanned yet) | "scanning" | "done" | "error". Drives
  // scanText's one-shot-per-instance guard in selectTool.
  var ocrState = "idle";
  // The "Scanning text…" pill element (see showScanPill/hideScanPill), or
  // null while hidden. A plain DOM element appended to `wrapper`, never
  // drawn on canvas, so it can never leak into an export.
  var scanPillEl = null;
  // Natural-px point of the highlighter's last processed sample (pointerdown
  // or the previous pointermove), used by addHighlightSample to interpolate
  // across fast drags so they don't skip over word boxes between two
  // pointermove events. Reset on every highlight pointerdown.
  var lastHighlightPt = null;
  var selectedTool = null;
  var selectedColor = ANNOT_COLORS[0];
  var selectedSizeCssPx = ANNOT_SIZES[1].cssPx; // M, a reasonable middle default
  var scale = img.clientWidth / img.naturalWidth;
  var destroyed = false;

  var toolButtons = {};
  var colorButtons = {};
  var sizeButtons = {};

  img.draggable = false;

  shadowRoot.appendChild(buildStyleEl());

  var layer = document.createElement("canvas");
  layer.className = "annot-layer";
  wrapper.appendChild(layer);
  var ctx = layer.getContext("2d");

  var toolbar = buildToolbar();

  layer.addEventListener("pointerdown", onPointerDown);
  layer.addEventListener("pointermove", onPointerMove);
  layer.addEventListener("pointerup", onPointerUp);
  layer.addEventListener("pointercancel", onPointerUp);
  layer.addEventListener("dblclick", onDoubleClick);
  window.addEventListener("resize", onResize);

  updateToolbarUI();
  resizeLayer();

  // ---- toolbar construction ----

  function buildStyleEl() {
    var style = document.createElement("style");
    style.textContent = annotStyleText();
    return style;
  }

  function buildToolbar() {
    var bar = document.createElement("div");
    bar.className = "annot-toolbar";

    var toolsGroup = document.createElement("div");
    toolsGroup.className = "annot-group annot-tools";
    ANNOT_TOOLS.forEach(function (tool) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "annot-tool-btn";
      btn.title = tool.label;
      btn.setAttribute("aria-label", tool.label);
      btn.innerHTML = tool.icon;
      btn.addEventListener("click", function () {
        selectTool(selectedTool === tool.id ? null : tool.id);
      });
      toolButtons[tool.id] = btn;
      toolsGroup.appendChild(btn);
    });

    var colorGroup = document.createElement("div");
    colorGroup.className = "annot-group annot-colors";
    ANNOT_COLORS.forEach(function (color) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "annot-swatch";
      btn.style.background = color;
      btn.title = color;
      btn.setAttribute("aria-label", "Color " + color);
      btn.addEventListener("click", function () {
        selectColor(color);
      });
      colorButtons[color] = btn;
      colorGroup.appendChild(btn);
    });

    var sizeGroup = document.createElement("div");
    sizeGroup.className = "annot-group annot-sizes";
    ANNOT_SIZES.forEach(function (size) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "annot-size-btn";
      btn.setAttribute("aria-label", "Stroke size " + size.cssPx);
      var dot = document.createElement("span");
      dot.className = "annot-size-dot";
      dot.style.width = size.dot + "px";
      dot.style.height = size.dot + "px";
      btn.appendChild(dot);
      btn.addEventListener("click", function () {
        selectSize(size.cssPx);
      });
      sizeButtons[size.cssPx] = btn;
      sizeGroup.appendChild(btn);
    });

    var actionsGroup = document.createElement("div");
    actionsGroup.className = "annot-group annot-actions";
    var undoBtn = document.createElement("button");
    undoBtn.type = "button";
    undoBtn.className = "annot-text-btn";
    undoBtn.textContent = "Undo";
    undoBtn.addEventListener("click", undo);
    var clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "annot-text-btn";
    clearBtn.textContent = "Clear";
    clearBtn.addEventListener("click", clearAll);
    actionsGroup.append(undoBtn, clearBtn);

    var divider1 = document.createElement("div");
    divider1.className = "annot-divider";
    var divider2 = document.createElement("div");
    divider2.className = "annot-divider";

    bar.append(toolsGroup, divider1, colorGroup, divider2, sizeGroup, actionsGroup);
    return bar;
  }

  function updateToolbarUI() {
    ANNOT_TOOLS.forEach(function (tool) {
      toolButtons[tool.id].classList.toggle("annot-active", tool.id === selectedTool);
    });
    ANNOT_COLORS.forEach(function (color) {
      colorButtons[color].classList.toggle("annot-selected", color === selectedColor);
    });
    ANNOT_SIZES.forEach(function (size) {
      sizeButtons[size.cssPx].classList.toggle("annot-selected", size.cssPx === selectedSizeCssPx);
    });
    layer.classList.toggle("annot-active", !!selectedTool);
    layer.classList.toggle("annot-tool-select", selectedTool === "select");
    layer.classList.toggle("annot-tool-text", selectedTool === "text");
  }

  // Applies a tool's non-destructive state: updates selectedTool, toolbar UI,
  // and layer classes/cursor. Does NOT clear activeText, freshSelection, or
  // repaint. Used by selectTool and, after committing a text box, to switch
  // to Select without losing the just-placed box's popup.
  function applyToolState(toolId) {
    selectedTool = toolId;
    updateToolbarUI();
  }

  function selectTool(toolId) {
    // Commit before switching so a half-typed box isn't silently dropped —
    // commitTextEditor() itself handles the empty-text-discards case.
    if (textEditorEl) {
      commitTextEditor();
    }
    applyToolState(toolId);
    // First switch to Highlighter this capture: kick off the OCR scan in
    // the background. Fire-and-forget — scanText manages its own
    // scanning/done/error state and never blocks tool selection; the
    // highlighter works freehand-only until (or if) it resolves.
    if (toolId === "highlight" && ocrState === "idle") {
      scanText();
    }
    var changed = false;
    if (freshSelection) {
      freshSelection = null;
      updateFreshHoverCursor(null);
      changed = true;
    }
    if (activeText) {
      activeText = null;
      hideTextOptions();
      changed = true;
    }
    if (changed) {
      repaint();
    }
  }

  function selectColor(color) {
    selectedColor = color;
    updateToolbarUI();
  }

  function selectSize(cssPx) {
    selectedSizeCssPx = cssPx;
    updateToolbarUI();
  }

  function undo() {
    // A pending edit commits first — if it's a brand-new box, this makes it
    // the thing Undo just removed (consistent with Undo always targeting
    // the most-recently-created annotation); blur already does this in
    // practice (the Undo button steals focus from the editor before its own
    // click handler runs), this is just a non-DOM-timing-dependent backstop.
    if (textEditorEl) {
      commitTextEditor();
    }
    if (annotations.length === 0) {
      return;
    }
    annotations.pop();
    freshSelection = null;
    updateFreshHoverCursor(null);
    if (activeText) {
      activeText = null;
      hideTextOptions();
    }
    repaint();
  }

  function clearAll() {
    if (textEditorEl) {
      commitTextEditor();
    }
    if (annotations.length === 0) {
      return;
    }
    annotations = [];
    freshSelection = null;
    updateFreshHoverCursor(null);
    activeText = null;
    hideTextOptions();
    repaint();
  }

  // ---- coordinates + backing store ----

  function toNatural(e) {
    return { x: e.offsetX / scale, y: e.offsetY / scale };
  }

  function resizeLayer() {
    var dpr = window.devicePixelRatio || 1;
    scale = img.clientWidth / img.naturalWidth;
    layer.width = Math.max(1, Math.round(img.clientWidth * dpr));
    layer.height = Math.max(1, Math.round(img.clientHeight * dpr));
    // Both the live editor and the options popup are positioned/sized from
    // `scale` (see positionTextEditor/showTextOptions), which just changed
    // above — resync them so a mid-edit pinch-zoom doesn't leave either one
    // pointing at stale coordinates.
    if (textEditorEl) {
      positionTextEditor(textEditorEl, textEditorAnnotation);
      autoGrowEditor(textEditorEl);
    }
    repaint();
    if (activeText && textOptionsEl) {
      // Resync only — a pinch-zoom mid-selection shouldn't silently flip
      // the popup's active target back to Text, so this goes through
      // refreshTextOptions (preserves textOptionsTarget), not showTextOptions.
      refreshTextOptions(activeText);
    }
  }

  function onResize() {
    resizeLayer();
  }

  function repaint() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, layer.width, layer.height);
    var dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    for (var i = 0; i < annotations.length; i++) {
      drawAnnotation(ctx, annotations[i]);
    }
    if (inProgress) {
      drawAnnotation(ctx, inProgress);
    }
    if (grabbed) {
      drawSelectionCue(ctx, grabbed.annotation);
    }
    // Fresh-selection cue: skip it if `grabbed` is already dragging this
    // same annotation (its cue was just drawn above) — avoids a double draw
    // while a fresh selection's move-drag is in progress.
    if (freshSelection && (!grabbed || grabbed.annotation !== freshSelection)) {
      drawSelectionCue(ctx, freshSelection);
    }
    // activeText's cue is skipped while its editor is open (the editor's
    // own dashed border already frames it — drawing both would double up
    // and the two wouldn't even line up, since the editor's box grows with
    // scrollWidth/scrollHeight rather than measured text metrics) and
    // de-duped against grabbed/freshSelection the same way those two are
    // de-duped against each other above.
    if (
      activeText &&
      !textEditorEl &&
      activeText !== freshSelection &&
      (!grabbed || grabbed.annotation !== activeText)
    ) {
      drawSelectionCue(ctx, activeText);
    }
  }

  // Dashed selection cue around a grabbed annotation, drawn after everything
  // else so it always sits on top. `ctx` is already under repaint's
  // dpr*scale transform (natural-px coordinate space), so a 1 CSS px dash
  // needs a natural-px line width of 1/scale.
  function drawSelectionCue(ctx, a) {
    var box = annotationBoundingBox(a);
    ctx.save();
    ctx.setLineDash([4 / scale, 4 / scale]);
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = "#2273f2";
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.restore();
  }

  function annotationBoundingBox(a) {
    if (a.tool === "pen") {
      var minX = a.points[0].x;
      var maxX = a.points[0].x;
      var minY = a.points[0].y;
      var maxY = a.points[0].y;
      for (var i = 1; i < a.points.length; i++) {
        minX = Math.min(minX, a.points[i].x);
        maxX = Math.max(maxX, a.points[i].x);
        minY = Math.min(minY, a.points[i].y);
        maxY = Math.max(maxY, a.points[i].y);
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    if (a.tool === "text") {
      var tb = textBounds(ctx, a);
      return { x: tb.x0, y: tb.y0, w: tb.x1 - tb.x0, h: tb.y1 - tb.y0 };
    }
    if (a.tool === "highlight") {
      return highlightBoundingBox(a);
    }
    var x = Math.min(a.x0, a.x1);
    var y = Math.min(a.y0, a.y1);
    return { x: x, y: y, w: Math.abs(a.x1 - a.x0), h: Math.abs(a.y1 - a.y0) };
  }

  // Union bbox of every rect and band point, band points padded by
  // bandWidth/2 (a band point's actual painted extent, since the stroke is
  // centered on the polyline — see drawHighlightAnnotation). Guaranteed at
  // least one of rects/band is non-empty by isNonDegenerate, so `minX` etc.
  // are always set by the time either loop below would need them — but the
  // undefined check is kept anyway as a defensive fallback.
  function highlightBoundingBox(a) {
    var minX, minY, maxX, maxY;
    for (var i = 0; i < a.rects.length; i++) {
      var r = a.rects[i];
      minX = minX === undefined ? r.x : Math.min(minX, r.x);
      minY = minY === undefined ? r.y : Math.min(minY, r.y);
      maxX = maxX === undefined ? r.x + r.w : Math.max(maxX, r.x + r.w);
      maxY = maxY === undefined ? r.y + r.h : Math.max(maxY, r.y + r.h);
    }
    var pad = a.bandWidth / 2;
    for (var j = 0; j < a.band.length; j++) {
      var p = a.band[j];
      minX = minX === undefined ? p.x - pad : Math.min(minX, p.x - pad);
      minY = minY === undefined ? p.y - pad : Math.min(minY, p.y - pad);
      maxX = maxX === undefined ? p.x + pad : Math.max(maxX, p.x + pad);
      maxY = maxY === undefined ? p.y + pad : Math.max(maxY, p.y + pad);
    }
    if (minX === undefined) {
      return { x: 0, y: 0, w: 0, h: 0 };
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  // ---- Select tool: hit-testing + move ----

  // Topmost-first (later-drawn annotations are visually on top), all
  // tolerances in natural px per-annotation: half its stroke width plus an
  // 8 CSS px fudge factor so thin strokes are still easy to grab.
  function hitTest(pt) {
    for (var i = annotations.length - 1; i >= 0; i--) {
      var a = annotations[i];
      if (hitAnnotation(a, pt.x, pt.y)) {
        return a;
      }
    }
    return null;
  }

  // Per-annotation hit check, factored out of hitTest so onPointerDown's
  // freshSelection branch (see below) can test a single known annotation
  // without scanning the whole `annotations` array.
  function hitAnnotation(a, px, py) {
    // Text has no stroke width to fold into the tolerance — just the usual
    // 8 CSS px fudge factor other tools add on top of their stroke.
    if (a.tool === "text") {
      var tb = textBounds(ctx, a);
      var ttol = 8 / scale;
      return px >= tb.x0 - ttol && px <= tb.x1 + ttol && py >= tb.y0 - ttol && py <= tb.y1 + ttol;
    }
    var tol = a.width / 2 + 8 / scale;
    if (a.tool === "pen") {
      return hitPen(a, { x: px, y: py }, tol);
    }
    if (a.tool === "line" || a.tool === "arrow") {
      return distancePointToSegment(px, py, a.x0, a.y0, a.x1, a.y1) <= tol;
    }
    if (a.tool === "rect" || a.tool === "ellipse") {
      return hitBox(a, { x: px, y: py }, tol);
    }
    if (a.tool === "highlight") {
      return hitHighlight(a, px, py);
    }
    return false;
  }

  // Hit if the point falls inside any word rect (expanded by the usual 8
  // CSS px fudge factor, same as the other no-stroke-width case above,
  // text) or within bandWidth/2 (the band's actual painted half-thickness)
  // plus that same fudge factor of any band segment.
  function hitHighlight(a, px, py) {
    var tol = 8 / scale;
    for (var i = 0; i < a.rects.length; i++) {
      var r = a.rects[i];
      if (px >= r.x - tol && px <= r.x + r.w + tol && py >= r.y - tol && py <= r.y + r.h + tol) {
        return true;
      }
    }
    if (a.band.length === 0) {
      return false;
    }
    var bandTol = a.bandWidth / 2 + tol;
    if (a.band.length === 1) {
      var only = a.band[0];
      return Math.hypot(px - only.x, py - only.y) <= bandTol;
    }
    for (var j = 0; j < a.band.length - 1; j++) {
      if (distancePointToSegment(px, py, a.band[j].x, a.band[j].y, a.band[j + 1].x, a.band[j + 1].y) <= bandTol) {
        return true;
      }
    }
    return false;
  }

  function hitPen(a, pt, tol) {
    var points = a.points;
    if (points.length < 2) {
      var only = points[0];
      return Math.hypot(pt.x - only.x, pt.y - only.y) <= tol;
    }
    for (var i = 0; i < points.length - 1; i++) {
      if (distancePointToSegment(pt.x, pt.y, points[i].x, points[i].y, points[i + 1].x, points[i + 1].y) <= tol) {
        return true;
      }
    }
    return false;
  }

  // Simple containment inside the normalized bounding box expanded by tol —
  // intentionally generous (no exact ellipse-boundary math).
  function hitBox(a, pt, tol) {
    var minX = Math.min(a.x0, a.x1) - tol;
    var maxX = Math.max(a.x0, a.x1) + tol;
    var minY = Math.min(a.y0, a.y1) - tol;
    var maxY = Math.max(a.y0, a.y1) + tol;
    return pt.x >= minX && pt.x <= maxX && pt.y >= minY && pt.y <= maxY;
  }

  function translateAnnotation(a, dx, dy) {
    if (a.tool === "pen") {
      for (var i = 0; i < a.points.length; i++) {
        a.points[i].x += dx;
        a.points[i].y += dy;
      }
      return;
    }
    if (a.tool === "text") {
      a.x += dx;
      a.y += dy;
      return;
    }
    if (a.tool === "highlight") {
      for (var j = 0; j < a.rects.length; j++) {
        a.rects[j].x += dx;
        a.rects[j].y += dy;
      }
      for (var k = 0; k < a.band.length; k++) {
        a.band[k].x += dx;
        a.band[k].y += dy;
      }
      // Keep the source words in step with the moved bars so a later
      // click-to-link adjacency test uses the highlight's current position.
      if (a.words) {
        for (var m = 0; m < a.words.length; m++) {
          a.words[m] = {
            x: a.words[m].x + dx,
            y: a.words[m].y + dy,
            w: a.words[m].w,
            h: a.words[m].h,
            breakAfter: a.words[m].breakAfter,
          };
        }
      }
      return;
    }
    a.x0 += dx;
    a.y0 += dy;
    a.x1 += dx;
    a.y1 += dy;
  }

  // ---- Highlighter tool: OCR scan + word-snap/freehand sampling ----

  // Fires the on-device OCR scan for this capture, once (see selectTool's
  // ocrState === "idle" guard — every later Highlighter selection is a
  // no-op here). Fire-and-forget: never blocks tool selection, and the
  // highlighter still works in freehand-fallback-only mode the whole time
  // it's scanning (ocrWords stays null until/unless this resolves
  // successfully).
  async function scanText() {
    ocrState = "scanning";
    showScanPill("Scanning text…");
    try {
      var sourceMaxSide = Math.max(sourceCanvas.width, sourceCanvas.height);
      var ocrCanvas = sourceCanvas;
      var ocrScale = 1;
      if (sourceMaxSide > 4096) {
        var tempMaxSide = 4096;
        ocrScale = tempMaxSide / sourceMaxSide;
        ocrCanvas = document.createElement("canvas");
        ocrCanvas.width = Math.round(sourceCanvas.width * ocrScale);
        ocrCanvas.height = Math.round(sourceCanvas.height * ocrScale);
        ocrCanvas.getContext("2d").drawImage(sourceCanvas, 0, 0, ocrCanvas.width, ocrCanvas.height);
      }
      var dataUrl = ocrCanvas.toDataURL("image/jpeg", 0.85);
      var base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      var resp = await browser.runtime.sendMessage({ type: "ocrRequest", image: base64 });
      if (destroyed) {
        // The overlay was closed while the native round trip was in
        // flight — nothing left to update.
        return;
      }
      if (resp && resp.ok) {
        // Map each word box back to natural px: it came back in pixel
        // coordinates of whatever image was actually sent (ocrCanvas),
        // which is sourceCanvas scaled down by ocrScale when downscaling
        // kicked in above (ocrScale stays 1, a no-op divide, otherwise).
        ocrWords = resp.words.map(function (w) {
          var text = w.text || "";
          return {
            x: w.x / ocrScale,
            y: w.y / ocrScale,
            w: w.w / ocrScale,
            h: w.h / ocrScale,
            // A run of highlighted words merges into one bar unless the word
            // ends a clause/sentence — then the highlight breaks after it.
            breakAfter: /[.,;:!?]$/.test(text),
          };
        });
        ocrState = "done";
      } else {
        ocrState = "error";
        await flashScanPill("Couldn’t scan text");
      }
    } catch (err) {
      if (!destroyed) {
        ocrState = "error";
        await flashScanPill("Couldn’t scan text");
      }
    } finally {
      hideScanPill();
    }
  }

  function showScanPill(text) {
    if (scanPillEl) {
      scanPillEl.textContent = text;
      return;
    }
    var el = document.createElement("div");
    el.className = "annot-scan-pill";
    el.textContent = text;
    wrapper.appendChild(el);
    scanPillEl = el;
  }

  function hideScanPill() {
    if (scanPillEl) {
      scanPillEl.remove();
      scanPillEl = null;
    }
  }

  // Briefly swaps the pill to an error message before scanText's `finally`
  // hides it, so a failed scan is visible for a moment instead of the pill
  // just silently vanishing.
  function flashScanPill(text) {
    if (scanPillEl) {
      scanPillEl.textContent = text;
    }
    return new Promise(function (resolve) {
      setTimeout(resolve, 1200);
    });
  }

  // True if natural-px point (px,py) falls inside word box r.
  function pointInWordBox(px, py, r) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  function findWordAt(px, py) {
    if (!ocrWords) {
      return null;
    }
    for (var i = 0; i < ocrWords.length; i++) {
      if (pointInWordBox(px, py, ocrWords[i])) {
        return ocrWords[i];
      }
    }
    return null;
  }

  // True if (px,py) is within a padded margin of any detected word — i.e. in
  // "text territory" (an inter-word gap, or a little above/below a line). Used
  // to suppress the freehand band there, so dragging the highlighter across a
  // line of text produces only the clean snapped word bars, not a freehand
  // smear over the gaps and wobble. The freehand fallback then only appears
  // where there's genuinely no nearby text (over an image or blank space).
  function nearAnyWord(px, py) {
    if (!ocrWords) {
      return false;
    }
    for (var i = 0; i < ocrWords.length; i++) {
      var wd = ocrWords[i];
      var padX = wd.h * 0.5;
      var padY = wd.h * 0.7;
      if (px >= wd.x - padX && px <= wd.x + wd.w + padX && py >= wd.y - padY && py <= wd.y + wd.h + padY) {
        return true;
      }
    }
    return false;
  }

  function wordAlreadyIncluded(words, r) {
    for (var i = 0; i < words.length; i++) {
      var e = words[i];
      if (e.x === r.x && e.y === r.y && e.w === r.w && e.h === r.h) {
        return true;
      }
    }
    return false;
  }

  // Overlap of two boxes' vertical extents, in natural px (negative if they
  // don't share any rows) — the "are these on the same line?" test.
  function verticalOverlap(a, b) {
    return Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  }

  // Turns the set of picked words into highlight bars: words on the same line
  // that sit next to each other merge into one continuous bar (filling the
  // inter-word gaps), but the run breaks after any word that ends a clause or
  // sentence (comma, full stop, etc. — see `breakAfter`). Words separated by a
  // large gap (an un-highlighted word between them) also start a new bar.
  function mergeHighlightWords(words) {
    if (!words.length) {
      return [];
    }
    // Bucket into lines by vertical overlap.
    var lines = [];
    words
      .slice()
      .sort(function (a, b) {
        return a.y - b.y;
      })
      .forEach(function (w) {
        for (var i = 0; i < lines.length; i++) {
          var L = lines[i];
          if (verticalOverlap(L, w) > 0.5 * Math.min(L.h, w.h)) {
            L.words.push(w);
            var bottom = Math.max(L.y + L.h, w.y + w.h);
            L.y = Math.min(L.y, w.y);
            L.h = bottom - L.y;
            return;
          }
        }
        lines.push({ y: w.y, h: w.h, words: [w] });
      });

    var rects = [];
    lines.forEach(function (L) {
      L.words.sort(function (a, b) {
        return a.x - b.x;
      });
      var run = null;
      var prev = null;
      L.words.forEach(function (w) {
        var avgH = prev ? (prev.h + w.h) / 2 : w.h;
        var gap = prev ? w.x - (prev.x + prev.w) : 0;
        // Adjacent = a small gap (roughly one space) and the previous word
        // didn't close a clause/sentence.
        var adjacent = prev && !prev.breakAfter && gap < 0.6 * avgH && gap > -avgH;
        if (run && adjacent) {
          run.x1 = Math.max(run.x1, w.x + w.w);
          run.y0 = Math.min(run.y0, w.y);
          run.y1 = Math.max(run.y1, w.y + w.h);
        } else {
          if (run) {
            rects.push({ x: run.x0, y: run.y0, w: run.x1 - run.x0, h: run.y1 - run.y0 });
          }
          run = { x0: w.x, y0: w.y, x1: w.x + w.w, y1: w.y + w.h };
        }
        prev = w;
      });
      if (run) {
        rects.push({ x: run.x0, y: run.y0, w: run.x1 - run.x0, h: run.y1 - run.y0 });
      }
    });
    return rects;
  }

  // Natural-px sampling step for addHighlightSample below — comfortably
  // smaller than a typical word's width/height so a fast drag can't skip
  // clean over a whole word between two pointer events.
  var HIGHLIGHT_SAMPLE_STEP = 6;

  // Samples the segment prevPt -> pt (inclusive of pt; a single sample at
  // pt itself when prevPt === pt, i.e. the initial pointerdown) and, for
  // each sample, either records the detected word under it (deduped into
  // inProgress.words by exact box match, so re-crossing the same word doesn't
  // add it twice) or — no word under that sample — appends the raw point to
  // inProgress.band, the freehand fallback polyline. After collecting words,
  // rebuilds inProgress.rects by merging same-line adjacent words into
  // continuous bars (breaking at punctuation). Called from both onPointerDown
  // (prevPt = pt) and onPointerMove (prevPt = lastHighlightPt) so the two
  // share one sampling/dedup implementation.
  function addHighlightSample(inProgress, pt, prevPt) {
    var dx = pt.x - prevPt.x;
    var dy = pt.y - prevPt.y;
    var dist = Math.hypot(dx, dy);
    var steps = Math.max(1, Math.ceil(dist / HIGHLIGHT_SAMPLE_STEP));
    var addedWord = false;
    for (var i = 1; i <= steps; i++) {
      var t = i / steps;
      var sx = prevPt.x + dx * t;
      var sy = prevPt.y + dy * t;
      var word = findWordAt(sx, sy);
      if (word) {
        if (!wordAlreadyIncluded(inProgress.words, word)) {
          inProgress.words.push(word);
          addedWord = true;
        }
      } else if (!nearAnyWord(sx, sy)) {
        // Only lay down freehand where there's no nearby text — inter-word
        // gaps and slight vertical wobble over a highlighted line are covered
        // by the merged word bars instead.
        inProgress.band.push({ x: sx, y: sy });
      }
    }
    if (addedWord) {
      inProgress.rects = mergeHighlightWords(inProgress.words);
    }
  }

  // True if two words sit next to each other on the same line with only a
  // word-gap between them and the left one doesn't close a clause — the same
  // rule mergeHighlightWords uses within a stroke, but applied across two
  // separate highlights so a newly-clicked word can link onto an existing bar.
  function wordsAdjacent(a, b) {
    if (verticalOverlap(a, b) <= 0.5 * Math.min(a.h, b.h)) {
      return false;
    }
    var left = a.x <= b.x ? a : b;
    var right = a.x <= b.x ? b : a;
    if (left.breakAfter) {
      return false;
    }
    var avgH = (a.h + b.h) / 2;
    var gap = right.x - (left.x + left.w);
    return gap < 0.6 * avgH && gap > -avgH;
  }

  function highlightsConnect(wordsA, wordsB) {
    for (var i = 0; i < wordsA.length; i++) {
      for (var j = 0; j < wordsB.length; j++) {
        if (wordsAdjacent(wordsA[i], wordsB[j])) {
          return true;
        }
      }
    }
    return false;
  }

  function dedupeWords(words) {
    var out = [];
    for (var i = 0; i < words.length; i++) {
      if (!wordAlreadyIncluded(out, words[i])) {
        out.push(words[i]);
      }
    }
    return out;
  }

  // Before a freshly finished word-highlight is committed, fold in any
  // existing highlights it now touches (adjacent same-line words with no
  // punctuation break between), so clicking a word beside an existing bar
  // links them into one continuous highlight. Removes the absorbed
  // annotations and returns the combined one (bars recomputed).
  function absorbAdjacentHighlights(nh) {
    var connected = [];
    for (var i = 0; i < annotations.length; i++) {
      var a = annotations[i];
      if (a.tool === "highlight" && a.words && a.words.length && highlightsConnect(a.words, nh.words)) {
        connected.push(a);
      }
    }
    if (!connected.length) {
      return nh;
    }
    var allWords = nh.words.slice();
    var allBand = (nh.band || []).slice();
    connected.forEach(function (a) {
      allWords = allWords.concat(a.words);
      if (a.band) {
        allBand = allBand.concat(a.band);
      }
    });
    annotations = annotations.filter(function (a) {
      return connected.indexOf(a) === -1;
    });
    var merged = {
      tool: "highlight",
      color: nh.color,
      words: dedupeWords(allWords),
      band: allBand,
      bandWidth: nh.bandWidth,
      rects: [],
    };
    merged.rects = mergeHighlightWords(merged.words);
    return merged;
  }

  // ---- pointer flow ----

  function updateFreshHoverCursor(pt) {
    var over = !!(freshSelection && pt && hitAnnotation(freshSelection, pt.x, pt.y));
    layer.classList.toggle("annot-over-fresh", over);
  }

  function isNonDegenerate(a) {
    if (a.tool === "pen") {
      return a.points.length >= 2;
    }
    if (a.tool === "highlight") {
      return a.rects.length > 0 || a.band.length >= 2;
    }
    return Math.abs(a.x1 - a.x0) + Math.abs(a.y1 - a.y0) >= 3;
  }

  function onPointerDown(e) {
    if (!selectedTool || e.button !== 0) {
      return;
    }
    e.preventDefault();
    var pt = toNatural(e);

    // Any pointerdown on the layer is, by definition, "elsewhere" relative
    // to whatever the editor/popup were anchored to — commit the one and
    // drop the other before doing anything tool-specific below. (A hit on
    // activeText's own bounds is handled as "still here" further down, not
    // cleared here.)
    if (textEditorEl) {
      commitTextEditor();
    }
    if (activeText && !hitAnnotation(activeText, pt.x, pt.y)) {
      activeText = null;
      hideTextOptions();
      // Repaint immediately (rather than relying on a branch further down
      // to do it) — some paths below return without ever repainting
      // (notably the Text tool's click-tracking branch), which would
      // otherwise leave activeText's dashed cue stuck on the canvas after
      // its popup has already disappeared.
      repaint();
    }

    if (selectedTool === "select") {
      var hit = hitTest(pt);
      if (!hit) {
        return;
      }
      layer.setPointerCapture(e.pointerId);
      activePointerId = e.pointerId;
      grabbed = { annotation: hit, lastX: pt.x, lastY: pt.y };
      layer.classList.add("annot-grabbing");
      // Hide (rather than clear) the popup for the duration of the drag —
      // it's shown again, repositioned, on release (see onPointerUp).
      // Harmless no-op if `hit` isn't activeText (nothing is showing).
      hideTextOptions();
      repaint();
      return;
    }

    // A drawing tool is active. If the previous stroke is still "live"
    // (freshSelection) and this drag starts on top of it, move it instead
    // of starting a new drawing — same move-drag machinery as the Select
    // tool's grab above, just triggered from a drawing tool. Applies to the
    // Text tool too: it's how a just-created text box can be nudged without
    // switching to Select.
    if (freshSelection && hitAnnotation(freshSelection, pt.x, pt.y)) {
      layer.setPointerCapture(e.pointerId);
      activePointerId = e.pointerId;
      grabbed = { annotation: freshSelection, lastX: pt.x, lastY: pt.y };
      layer.classList.add("annot-grabbing");
      hideTextOptions();
      repaint();
      return;
    }
    freshSelection = null;
    updateFreshHoverCursor(null);

    if (selectedTool === "text") {
      // No drag-to-draw for text — remember the down point so pointerup
      // can tell a click (open an editor there) from a drag (do nothing;
      // there's nothing sensible to draw from a text-tool drag).
      layer.setPointerCapture(e.pointerId);
      activePointerId = e.pointerId;
      textDownPt = pt;
      return;
    }

    if (selectedTool === "highlight") {
      layer.setPointerCapture(e.pointerId);
      activePointerId = e.pointerId;
      inProgress = { tool: "highlight", color: selectedColor, words: [], rects: [], band: [], bandWidth: HIGHLIGHT_BAND_CSS / scale };
      lastHighlightPt = pt;
      addHighlightSample(inProgress, pt, pt);
      repaint();
      return;
    }

    layer.setPointerCapture(e.pointerId);
    activePointerId = e.pointerId;
    var widthNatural = selectedSizeCssPx / scale;
    if (selectedTool === "pen") {
      inProgress = { tool: "pen", color: selectedColor, width: widthNatural, points: [pt] };
    } else {
      inProgress = {
        tool: selectedTool,
        color: selectedColor,
        width: widthNatural,
        x0: pt.x,
        y0: pt.y,
        x1: pt.x,
        y1: pt.y,
      };
    }
    repaint();
  }

  function onPointerMove(e) {
    if (grabbed && e.pointerId === activePointerId) {
      var gpt = toNatural(e);
      translateAnnotation(grabbed.annotation, gpt.x - grabbed.lastX, gpt.y - grabbed.lastY);
      grabbed.lastX = gpt.x;
      grabbed.lastY = gpt.y;
      repaint();
      return;
    }
    if (!inProgress) {
      // Plain hover: update fresh-selection cursor
      var pt = toNatural(e);
      updateFreshHoverCursor(pt);
      return;
    }
    if (e.pointerId !== activePointerId) {
      return;
    }
    var pt = toNatural(e);
    if (inProgress.tool === "pen") {
      inProgress.points.push(pt);
    } else if (inProgress.tool === "highlight") {
      addHighlightSample(inProgress, pt, lastHighlightPt || pt);
      lastHighlightPt = pt;
    } else {
      var x1 = pt.x;
      var y1 = pt.y;
      // Shift-constrain rect/ellipse drags to a square: keep the drag's
      // signed direction (which corner it's dragged towards) but force
      // |dx| and |dy| to match, using whichever is currently larger.
      // Lines/arrows/pen are unaffected.
      if (e.shiftKey && (inProgress.tool === "rect" || inProgress.tool === "ellipse")) {
        var dx = x1 - inProgress.x0;
        var dy = y1 - inProgress.y0;
        var side = Math.max(Math.abs(dx), Math.abs(dy));
        x1 = inProgress.x0 + (dx < 0 ? -side : side);
        y1 = inProgress.y0 + (dy < 0 ? -side : side);
      }
      inProgress.x1 = x1;
      inProgress.y1 = y1;
    }
    repaint();
  }

  function onPointerUp(e) {
    var pt = toNatural(e);
    if (grabbed && e.pointerId === activePointerId) {
      // The move is final on release — no undo entry is created for it.
      // Undo (see undo() above) only ever pops the most recently CREATED
      // annotation off the end of `annotations`; moving an existing one
      // in place doesn't touch that stack, so Undo after a move removes
      // whatever was last drawn, not the move itself.
      var releasedAnnotation = grabbed.annotation;
      grabbed = null;
      activePointerId = null;
      layer.classList.remove("annot-grabbing");
      // Releasing a move-drag on the live fresh selection ends its "live"
      // state — whether the grab came from the freshSelection path above or
      // the Select tool happening to grab the same object.
      if (releasedAnnotation === freshSelection) {
        freshSelection = null;
        updateFreshHoverCursor(null);
      }
      // Moving a text box (via Select or a freshSelection nudge) keeps it
      // (or makes it) the active one — re-show its popup, repositioned to
      // match wherever the drag left it. Also covers the Select tool's
      // plain click case (pointerdown-hit immediately followed by
      // pointerup with no net movement): there's no separate "click vs.
      // drag" branch for Select, so a click just becomes a zero-distance
      // move, which lands here the same as a real drag would.
      if (releasedAnnotation.tool === "text") {
        activeText = releasedAnnotation;
        showTextOptions(releasedAnnotation);
      }
      repaint();
      return;
    }
    if (textDownPt && e.pointerId === activePointerId) {
      var textDown = textDownPt;
      textDownPt = null;
      activePointerId = null;
      // pointercancel has no reliable "where did this end up" position —
      // treat it as an abandoned click, not a placement.
      if (e.type === "pointerup" && Math.hypot(pt.x - textDown.x, pt.y - textDown.y) * scale < 6) {
        openTextEditorForNew(textDown);
      }
      return;
    }
    if (!inProgress || e.pointerId !== activePointerId) {
      return;
    }
    var finished = inProgress;
    inProgress = null;
    activePointerId = null;
    lastHighlightPt = null;
    if (isNonDegenerate(finished)) {
      if (finished.tool === "highlight" && finished.words && finished.words.length) {
        finished = absorbAdjacentHighlights(finished);
      }
      annotations.push(finished);
      freshSelection = finished;
      updateFreshHoverCursor(pt);
    }
    repaint();
  }

  // Double-click re-edit: with the Select tool, on any text annotation; with
  // any other tool, search all text annotations topmost-first, mirroring the
  // Select-tool branch behavior.
  function onDoubleClick(e) {
    var pt = toNatural(e);
    var target = null;
    if (selectedTool === "select") {
      var hit = hitTest(pt);
      if (hit && hit.tool === "text") {
        target = hit;
      }
    } else {
      // Iterate all annotations topmost-first, find the first text annotation
      // that hits the point. Mirroring the Select-tool branch lets the Text
      // tool double-click re-edit any text box, not just activeText.
      for (var i = annotations.length - 1; i >= 0; i--) {
        var a = annotations[i];
        if (a.tool === "text" && hitAnnotation(a, pt.x, pt.y)) {
          target = a;
          break;
        }
      }
    }
    if (!target) {
      return;
    }
    e.preventDefault();
    // Commit any open editor first (e.g., a phantom from the double-click's
    // single-click phase) before opening the target's editor.
    if (textEditorEl) {
      commitTextEditor();
    }
    openTextEditorForExisting(target);
  }

  // ---- Text tool: inline editor + per-box options popup ----

  function isEditingText() {
    return !!textEditorEl;
  }

  function openTextEditorForNew(pt) {
    var annotation = {
      tool: "text",
      x: pt.x,
      y: pt.y,
      text: "",
      color: selectedColor,
      bg: null,
      fontSize: 16 / scale, // 16 CSS px at the current zoom
    };
    openTextEditor(annotation, true);
  }

  function openTextEditorForExisting(annotation) {
    if (activeText === annotation) {
      activeText = null;
    }
    hideTextOptions();
    openTextEditor(annotation, false);
  }

  function openTextEditor(annotation, isNew) {
    // Defensive: every caller is expected to have already committed a
    // previous editor (onPointerDown/selectTool/undo/clearAll all do), but
    // this is the one choke point that actually creates a new one, so make
    // it impossible to silently orphan an open editor's DOM node/state
    // regardless of how a future caller gets here.
    if (textEditorEl) {
      commitTextEditor();
    }
    hideTextOptions();
    var el = buildTextEditor(annotation);
    wrapper.appendChild(el);
    autoGrowEditor(el);
    el.focus();
    if (!isNew) {
      // Land the cursor at the end rather than selecting everything, so
      // re-opening to append text doesn't require clearing a selection
      // first.
      el.setSelectionRange(el.value.length, el.value.length);
    }
    textEditorEl = el;
    textEditorAnnotation = annotation;
    textEditorIsNew = isNew;
    repaint(); // suppresses activeText's canvas cue now that textEditorEl is set
  }

  function buildTextEditor(annotation) {
    var el = document.createElement("textarea");
    el.className = "annot-text-editor";
    el.value = annotation.text;
    el.spellcheck = false;
    positionTextEditor(el, annotation);
    el.addEventListener("input", function () {
      autoGrowEditor(el);
      // Flip the toolbar to Select on the first keystroke (not at commit),
      // so the moment something is typed the next click selects/moves the
      // box instead of placing another one. commitTextEditor's own switch
      // then becomes a no-op backstop.
      if (selectedTool === "text") {
        applyToolState("select");
      }
    });
    el.addEventListener("blur", function () {
      commitTextEditor();
    });
    // The overlay's own window-capture Escape handler (content.js) would
    // otherwise close the whole preview while this editor is open; that's
    // guarded there via isEditingText(), so it's safe for this handler to
    // just commit — no need to fight over event order.
    el.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        commitTextEditor();
      }
    });
    return el;
  }

  // Sets everything about the editor that depends on `scale` or the
  // annotation's own styling — split out from buildTextEditor so resizeLayer
  // can resync a mid-edit box after a zoom change without rebuilding it.
  function positionTextEditor(el, annotation) {
    var pCss = annotation.fontSize * 0.25 * scale;
    el.style.left = annotation.x * scale - pCss - 1 + "px";
    el.style.top = annotation.y * scale - pCss - 1 + "px";
    el.style.fontSize = annotation.fontSize * scale + "px";
    el.style.color = annotation.color;
    el.style.background = annotation.bg || "transparent";
    el.style.padding = pCss + "px";
  }

  function autoGrowEditor(el) {
    el.style.width = "auto";
    el.style.height = "auto";
    el.style.width = el.scrollWidth + "px";
    el.style.height = el.scrollHeight + "px";
  }

  // Commit = trim-right; empty text discards (a new box is never added, an
  // existing one is removed outright — including dropping it from
  // freshSelection/activeText if it was either). Non-empty text always ends
  // with the box as activeText and its options popup shown, whether it was
  // brand new or a re-edit.
  function commitTextEditor() {
    if (!textEditorEl) {
      return;
    }
    var editor = textEditorEl;
    var annotation = textEditorAnnotation;
    var isNew = textEditorIsNew;
    textEditorEl = null;
    textEditorAnnotation = null;
    textEditorIsNew = false;
    editor.remove();

    var value = editor.value.trimEnd();

    if (value === "") {
      if (!isNew) {
        var idx = annotations.indexOf(annotation);
        if (idx !== -1) {
          annotations.splice(idx, 1);
        }
      }
      if (activeText === annotation) {
        activeText = null;
        hideTextOptions();
      }
      if (freshSelection === annotation) {
        freshSelection = null;
        updateFreshHoverCursor(null);
      }
      repaint();
      return;
    }

    annotation.text = value;
    if (isNew) {
      annotations.push(annotation);
      freshSelection = annotation;
      updateFreshHoverCursor(null);
    }
    activeText = annotation;
    showTextOptions(annotation);
    // Auto-switch to Select tool after placing text, preserving the just-placed
    // box's selection state (activeText, popup, freshSelection remain intact).
    // Guard: only switch if Text tool is currently active; other paths (e.g.,
    // Select tool's double-click re-edit) leave the tool unchanged.
    if (selectedTool === "text") {
      applyToolState("select");
    }
    repaint();
  }

  function hideTextOptions() {
    if (textOptionsEl) {
      textOptionsEl.remove();
      textOptionsEl = null;
    }
  }

  // Opens (or re-opens) the popup for `annotation`, resetting the active
  // color-target to Text — the entry point for callers that are showing the
  // popup fresh for a (possibly different) selection: committing a text
  // edit (new box or re-edit) and the Select tool's click-to-show path.
  function showTextOptions(annotation) {
    textOptionsTarget = "text";
    refreshTextOptions(annotation);
  }

  // Rebuilds the popup from scratch every time it's (re)shown — the popup
  // is small and this keeps every button's rendered state (selected swatch,
  // active target, current size) trivially in sync with `annotation`
  // without a separate update path. Unlike showTextOptions, this preserves
  // whatever color-target (Text/Background) is currently active — used for
  // in-popup interactions (swatch clicks, target toggle, font-size
  // stepper) and the resize resync, none of which should silently flip the
  // target back to Text.
  function refreshTextOptions(annotation) {
    hideTextOptions();
    var el = buildTextOptions(annotation);
    wrapper.appendChild(el);
    positionTextOptions(annotation, el);
    textOptionsEl = el;
  }

  function positionTextOptions(annotation, el) {
    var bounds = textBounds(ctx, annotation);
    var popupHeight = el.offsetHeight || 34;
    var top = annotation.y * scale - popupHeight - 8;
    if (top < 4) {
      // No room above — hang it below the box instead.
      top = bounds.y1 * scale + 8;
    }
    el.style.left = annotation.x * scale + "px";
    el.style.top = Math.max(4, top) + "px";
  }

  function buildTextOptions(annotation) {
    var el = document.createElement("div");
    el.className = "annot-text-options";
    // Every button below also preventDefaults its own pointerdown, but this
    // catches any click on the popup's own padding/background too.
    el.addEventListener("pointerdown", function (e) {
      e.preventDefault();
    });

    // Row 1: one unified swatch set. Each swatch applies its color to
    // whichever target (Text / Background) is active in row 2; the ring
    // marks the active target's CURRENT value, so toggling the target
    // re-rings without touching the annotation.
    var colorRow = document.createElement("div");
    colorRow.className = "annot-text-options-row";
    var isBg = textOptionsTarget === "bg";

    ANNOT_COLORS.forEach(function (color) {
      var selected = isBg ? annotation.bg === color : annotation.color === color;
      var label = (isBg ? "Background " : "Text color ") + color;
      colorRow.appendChild(
        buildTextSwatch(label, color, selected, function () {
          if (isBg) {
            annotation.bg = color;
          } else {
            annotation.color = color;
          }
          repaint();
          refreshTextOptions(annotation);
        })
      );
    });

    // "None" (transparent) applies only to the background, so it's shown
    // only while Background is the active target — a checkerboard swatch,
    // the standard "no fill" indicator.
    if (isBg) {
      var noneSwatch = buildTextSwatch("No background", null, !annotation.bg, function () {
        annotation.bg = null;
        repaint();
        refreshTextOptions(annotation);
      });
      noneSwatch.classList.add("annot-bg-none");
      colorRow.appendChild(noneSwatch);
    }

    // Row 2: the target toggle (left) and the font-size stepper (right).
    var controlsRow = document.createElement("div");
    controlsRow.className = "annot-text-options-row";

    var targetGroup = document.createElement("div");
    targetGroup.className = "annot-target-group";
    [
      { id: "text", label: "Text colour", icon: TEXT_TARGET_ICON },
      { id: "bg", label: "Background colour", icon: BG_TARGET_ICON },
    ].forEach(function (target) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "annot-target-btn";
      if (textOptionsTarget === target.id) {
        btn.classList.add("annot-active");
      }
      btn.innerHTML = target.icon;
      btn.title = target.label;
      btn.setAttribute("aria-label", target.label);
      btn.addEventListener("pointerdown", function (e) {
        e.preventDefault();
      });
      btn.addEventListener("click", function () {
        textOptionsTarget = target.id;
        refreshTextOptions(annotation);
      });
      targetGroup.appendChild(btn);
    });

    var minusBtn = document.createElement("button");
    minusBtn.type = "button";
    minusBtn.className = "annot-text-size-btn";
    minusBtn.textContent = "−";
    minusBtn.setAttribute("aria-label", "Decrease font size");
    minusBtn.addEventListener("pointerdown", function (e) {
      e.preventDefault();
    });
    minusBtn.addEventListener("click", function () {
      stepFontSize(annotation, -2);
    });

    var sizeValue = document.createElement("span");
    sizeValue.className = "annot-text-size-value";
    sizeValue.textContent = String(Math.round(annotation.fontSize * scale));

    var plusBtn = document.createElement("button");
    plusBtn.type = "button";
    plusBtn.className = "annot-text-size-btn";
    plusBtn.textContent = "+";
    plusBtn.setAttribute("aria-label", "Increase font size");
    plusBtn.addEventListener("pointerdown", function (e) {
      e.preventDefault();
    });
    plusBtn.addEventListener("click", function () {
      stepFontSize(annotation, 2);
    });

    var sizeGroup = document.createElement("div");
    sizeGroup.className = "annot-text-size-group";
    sizeGroup.append(minusBtn, sizeValue, plusBtn);
    controlsRow.append(targetGroup, sizeGroup);

    el.append(colorRow, controlsRow);
    return el;
  }

  function buildTextSwatch(label, color, selected, onClick) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "annot-swatch";
    if (color) {
      btn.style.background = color;
    }
    btn.title = label;
    btn.setAttribute("aria-label", label);
    if (selected) {
      btn.classList.add("annot-selected");
    }
    btn.addEventListener("pointerdown", function (e) {
      e.preventDefault();
    });
    btn.addEventListener("click", onClick);
    return btn;
  }

  // CSS-px-at-current-zoom step of 2, clamped to an 8-72 CSS px range —
  // stored back as natural px (fontSize) so it stays visually the same size
  // through further zoom changes, same convention as selectedSizeCssPx.
  function stepFontSize(annotation, deltaCssPx) {
    var currentCssPx = Math.round(annotation.fontSize * scale);
    var nextCssPx = Math.max(8, Math.min(72, currentCssPx + deltaCssPx));
    annotation.fontSize = nextCssPx / scale;
    repaint();
    refreshTextOptions(annotation);
  }

  // ---- public API ----

  function hasAnnotations() {
    return annotations.length > 0;
  }

  // sourceCanvas is at capture (natural) resolution, and every stored
  // annotation coordinate is already in img.naturalWidth/Height units — the
  // same pixel grid, since `img` was created from `sourceCanvas` — so the
  // composite is drawn with an identity transform straight in natural px,
  // no scaling needed.
  function renderComposite() {
    if (annotations.length === 0) {
      return sourceCanvas;
    }
    var composite = document.createElement("canvas");
    composite.width = sourceCanvas.width;
    composite.height = sourceCanvas.height;
    var cctx = composite.getContext("2d");
    cctx.drawImage(sourceCanvas, 0, 0);
    for (var i = 0; i < annotations.length; i++) {
      drawAnnotation(cctx, annotations[i]);
    }
    return composite;
  }

  function destroy() {
    if (destroyed) {
      return;
    }
    destroyed = true;
    // The overlay is going away regardless, so just discard any live edit
    // rather than committing it — there's nowhere for the result to go.
    if (textEditorEl) {
      textEditorEl.remove();
      textEditorEl = null;
    }
    hideTextOptions();
    hideScanPill();
    activeText = null;
    freshSelection = null;
    updateFreshHoverCursor(null);
    window.removeEventListener("resize", onResize);
    layer.remove();
  }

  return {
    toolbar: toolbar,
    hasAnnotations: hasAnnotations,
    renderComposite: renderComposite,
    destroy: destroy,
    refresh: resizeLayer,
    isEditingText: isEditingText,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { arrowHeadPoints, distancePointToSegment };
}
