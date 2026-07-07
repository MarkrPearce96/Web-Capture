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

function drawAnnotation(ctx, a) {
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

// ---- Toolbar data -----------------------------------------------------

var ANNOT_COLORS = ["#ff3b30", "#ffcc00", "#34c759", "#007aff", "#000000", "#ffffff"];

// cssPx is the stored/display stroke width (natural px = cssPx / scale at
// creation time, see createAnnotator); dot is the diameter of the swatch's
// filled preview circle, purely cosmetic.
var ANNOT_SIZES = [
  { cssPx: 2, dot: 4 },
  { cssPx: 4, dot: 6 },
  { cssPx: 8, dot: 9 },
];

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
  }

  function selectTool(toolId) {
    selectedTool = toolId;
    updateToolbarUI();
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
    if (annotations.length === 0) {
      return;
    }
    annotations.pop();
    repaint();
  }

  function clearAll() {
    if (annotations.length === 0) {
      return;
    }
    annotations = [];
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
    repaint();
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
    var x = Math.min(a.x0, a.x1);
    var y = Math.min(a.y0, a.y1);
    return { x: x, y: y, w: Math.abs(a.x1 - a.x0), h: Math.abs(a.y1 - a.y0) };
  }

  // ---- Select tool: hit-testing + move ----

  // Topmost-first (later-drawn annotations are visually on top), all
  // tolerances in natural px per-annotation: half its stroke width plus an
  // 8 CSS px fudge factor so thin strokes are still easy to grab.
  function hitTest(pt) {
    for (var i = annotations.length - 1; i >= 0; i--) {
      var a = annotations[i];
      var tol = a.width / 2 + 8 / scale;
      if (a.tool === "pen") {
        if (hitPen(a, pt, tol)) {
          return a;
        }
      } else if (a.tool === "line" || a.tool === "arrow") {
        if (distancePointToSegment(pt.x, pt.y, a.x0, a.y0, a.x1, a.y1) <= tol) {
          return a;
        }
      } else if (a.tool === "rect" || a.tool === "ellipse") {
        if (hitBox(a, pt, tol)) {
          return a;
        }
      }
    }
    return null;
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
    a.x0 += dx;
    a.y0 += dy;
    a.x1 += dx;
    a.y1 += dy;
  }

  // ---- pointer flow ----

  function isNonDegenerate(a) {
    if (a.tool === "pen") {
      return a.points.length >= 2;
    }
    return Math.abs(a.x1 - a.x0) + Math.abs(a.y1 - a.y0) >= 3;
  }

  function onPointerDown(e) {
    if (!selectedTool || e.button !== 0) {
      return;
    }
    e.preventDefault();
    var pt = toNatural(e);

    if (selectedTool === "select") {
      var hit = hitTest(pt);
      if (!hit) {
        return;
      }
      layer.setPointerCapture(e.pointerId);
      activePointerId = e.pointerId;
      grabbed = { annotation: hit, lastX: pt.x, lastY: pt.y };
      layer.classList.add("annot-grabbing");
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
    if (!inProgress || e.pointerId !== activePointerId) {
      return;
    }
    var pt = toNatural(e);
    if (inProgress.tool === "pen") {
      inProgress.points.push(pt);
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
    if (grabbed && e.pointerId === activePointerId) {
      // The move is final on release — no undo entry is created for it.
      // Undo (see undo() above) only ever pops the most recently CREATED
      // annotation off the end of `annotations`; moving an existing one
      // in place doesn't touch that stack, so Undo after a move removes
      // whatever was last drawn, not the move itself.
      grabbed = null;
      activePointerId = null;
      layer.classList.remove("annot-grabbing");
      repaint();
      return;
    }
    if (!inProgress || e.pointerId !== activePointerId) {
      return;
    }
    var finished = inProgress;
    inProgress = null;
    activePointerId = null;
    if (isNonDegenerate(finished)) {
      annotations.push(finished);
    }
    repaint();
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
    window.removeEventListener("resize", onResize);
    layer.remove();
  }

  return {
    toolbar: toolbar,
    hasAnnotations: hasAnnotations,
    renderComposite: renderComposite,
    destroy: destroy,
    refresh: resizeLayer,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { arrowHeadPoints, distancePointToSegment };
}
