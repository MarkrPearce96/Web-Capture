# Web Capture Safari Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Safari Web Extension whose toolbar icon captures a full-page screenshot of the current tab by scroll-and-stitch and saves it as a PNG to the Downloads folder.

**Architecture:** Plain-JavaScript Manifest V3 web extension in `extension/`, wrapped in an Xcode-generated macOS app via `xcrun safari-web-extension-converter`. The background script orchestrates a scroll/capture loop using `browser.tabs.captureVisibleTab`; the content script measures the page, scrolls, hides fixed/sticky elements, stitches frames onto a canvas, and saves the PNG via an anchor-click download (Safari has no `browser.downloads` API). Pure logic lives in `shared.js`, unit-tested with Node's built-in test runner.

**Tech Stack:** JavaScript (no frameworks, no build step, no npm dependencies), Node 24 built-in test runner (`node --test`) for pure functions, Swift script (AppKit) for icon generation, Xcode 26 / `safari-web-extension-converter` for packaging.

## Global Constraints

- Manifest V3, plain JavaScript only — no frameworks, no bundler, no `package.json`.
- Safari/macOS only; personal signing (no Developer account, no App Store).
- Safari does **not** support `browser.downloads` — saving MUST use the anchor-click approach in the content script.
- Permissions: exactly `["activeTab", "scripting"]`.
- Filename format: `<host> <YYYY-MM-DD> at <HH.MM.SS>.png` (host sanitized to `[\w.-]`, fallback `page`).
- Stitch canvas height capped at 16384 device pixels; taller pages capture up to the cap and still succeed.
- Any failure or abort path must restore the page (scroll position, hidden elements, scrollbars) and show a `✕` toolbar badge for ~2.5 s.
- All shell commands run from the repo root: `/Users/mark/Documents/Web Capture`.

## File Structure

```
extension/
  manifest.json      — MV3 manifest (Task 2)
  shared.js          — pure logic: scroll steps, filename, canvas cap (Task 1)
  content.js         — page-side engine: measure/scroll/hide/stitch/save/restore (Task 2)
  background.js      — toolbar click orchestration + error badge (Task 3)
  images/            — icon PNGs (Task 4)
scripts/
  make-icons.swift   — regenerates extension/images/*.png (Task 4)
test/
  shared.test.js     — Node unit tests for shared.js (Task 1)
  harness.html       — tall page w/ sticky header, gradient, lazy image for manual testing (Task 2)
xcode/               — converter-generated Xcode project (Task 5)
```

---

### Task 1: Pure logic module (`shared.js`) with unit tests

**Files:**
- Create: `.gitignore`
- Create: `extension/shared.js`
- Test: `test/shared.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 2 and 3, loaded as plain scripts so the functions are globals):
  - `computeScrollSteps(pageHeight, viewportHeight)` → `number[]` of Y offsets, ascending, always at least `[0]`, last element `max(0, pageHeight - viewportHeight)`, no duplicates.
  - `buildFilename(host, date)` → `string` like `example.com 2026-07-06 at 23.55.12.png`.
  - `cappedCanvasHeight(pageHeight, dpr)` → `number` = `min(round(pageHeight * dpr), MAX_CANVAS_PX)`.
  - `MAX_CANVAS_PX` → `16384`.

- [ ] **Step 1: Create `.gitignore`**

```gitignore
.DS_Store
xcode/**/build/
xcode/**/DerivedData/
xcode/**/xcuserdata/
```

- [ ] **Step 2: Write the failing tests**

Create `test/shared.test.js`:

```js
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/`
Expected: FAIL — `Cannot find module '../extension/shared.js'`

- [ ] **Step 4: Write the implementation**

Create `extension/shared.js`:

```js
"use strict";

// Pure helpers shared by background.js and content.js. Loaded as a plain
// script in the extension (functions become globals) and via require() in
// Node tests — no ES modules, so it can run in both without a build step.

const MAX_CANVAS_PX = 16384;

// Y offsets to scroll to, top to bottom, so stitched frames cover the whole
// page. The last step is clamped to the lowest scrollable offset; a page no
// taller than one viewport yields a single step at 0.
function computeScrollSteps(pageHeight, viewportHeight) {
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS — 10 passing tests, 0 failing

- [ ] **Step 6: Commit**

```bash
git add .gitignore extension/shared.js test/shared.test.js
git commit -m "feat: add pure capture logic (scroll steps, filename, canvas cap)"
```

---

### Task 2: Content script, manifest, and test harness page

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/content.js`
- Create: `test/harness.html`

**Interfaces:**
- Consumes: `cappedCanvasHeight(pageHeight, dpr)` global from `extension/shared.js` (injected alongside it).
- Produces: a `browser.runtime.onMessage` handler in the page responding to these messages (all responses are plain JSON objects; on internal failure the response is `{ error: string }`):
  - `{ type: "measure" }` → `{ pageHeight, viewportWidth, viewportHeight, dpr, host }` — also records the current scroll position and hides scrollbars.
  - `{ type: "scrollTo", y: number, hideFixed: boolean }` → `{ y: number }` (the actual resulting scroll Y) — scrolls, optionally hides fixed/sticky elements first, waits for rendering to settle.
  - `{ type: "addFrame", dataUrl: string, y: number }` → `{ ok: true }` — decodes the frame and draws it onto the stitch canvas at `y * dpr`.
  - `{ type: "finish", filename: string }` → `{ ok: true }` — restores the page, exports PNG, triggers the anchor-click download.
  - `{ type: "restore" }` → `{ ok: true }` — idempotent page-state restore (safe to call after `finish` or mid-abort).

There are no automated DOM tests; `test/harness.html` provides deterministic manual verification in Task 6. Syntax is machine-checked with `node --check`.

- [ ] **Step 1: Create `extension/manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Web Capture",
  "version": "1.0",
  "description": "Capture a full-page screenshot of the current page as a PNG.",
  "icons": {
    "48": "images/icon-48.png",
    "96": "images/icon-96.png",
    "128": "images/icon-128.png",
    "256": "images/icon-256.png",
    "512": "images/icon-512.png"
  },
  "background": {
    "scripts": ["shared.js", "background.js"]
  },
  "action": {
    "default_title": "Capture full page",
    "default_icon": {
      "16": "images/toolbar-16.png",
      "32": "images/toolbar-32.png"
    }
  },
  "permissions": ["activeTab", "scripting"]
}
```

- [ ] **Step 2: Create `extension/content.js`**

```js
"use strict";

// Page-side capture engine. Injected on demand (after shared.js) by
// background.js. Guarded so repeated injections don't add extra listeners.
(() => {
  if (window.__webCaptureLoaded) {
    return;
  }
  window.__webCaptureLoaded = true;

  const SETTLE_MS = 350;

  const state = {
    originalX: 0,
    originalY: 0,
    hidden: [], // [{ el, priorValue, priorPriority }]
    scrollbarStyle: null,
    canvas: null,
    ctx: null,
    dpr: 1,
    restored: true,
  };

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handle(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: String(err && err.message ? err.message : err) }));
    return true; // keep the channel open for the async response
  });

  async function handle(message) {
    switch (message.type) {
      case "measure":
        return measure();
      case "scrollTo":
        return scrollToStep(message);
      case "addFrame":
        return addFrame(message);
      case "finish":
        return finish(message);
      case "restore":
        return restore();
      default:
        throw new Error(`unknown message type: ${message.type}`);
    }
  }

  function pageHeight() {
    return Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
  }

  function measure() {
    state.originalX = window.scrollX;
    state.originalY = window.scrollY;
    state.hidden = [];
    state.canvas = null;
    state.ctx = null;
    state.restored = false;
    if (!state.scrollbarStyle) {
      state.scrollbarStyle = document.createElement("style");
      state.scrollbarStyle.textContent = "*::-webkit-scrollbar { display: none !important; }";
      document.documentElement.appendChild(state.scrollbarStyle);
    }
    return {
      pageHeight: pageHeight(),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      host: location.hostname || "page",
    };
  }

  async function scrollToStep({ y, hideFixed }) {
    if (hideFixed && state.hidden.length === 0) {
      hideFixedElements();
    }
    window.scrollTo(0, y);
    await settle(SETTLE_MS);
    return { y: Math.round(window.scrollY) };
  }

  // Fixed and sticky elements would repeat in every frame; hide them after
  // the first frame so they appear once, at the top of the stitched image.
  function hideFixedElements() {
    for (const el of document.querySelectorAll("body *")) {
      const position = getComputedStyle(el).position;
      if (position === "fixed" || position === "sticky") {
        state.hidden.push({
          el,
          priorValue: el.style.getPropertyValue("visibility"),
          priorPriority: el.style.getPropertyPriority("visibility"),
        });
        el.style.setProperty("visibility", "hidden", "important");
      }
    }
  }

  // Two animation frames flush layout/paint after scrolling; the timeout
  // gives lazy-loaded content a chance to appear.
  function settle(ms) {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setTimeout(resolve, ms));
      });
    });
  }

  async function addFrame({ dataUrl, y }) {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    if (!state.canvas) {
      // Derive the real capture scale from the frame itself rather than
      // trusting devicePixelRatio — Safari decides the capture resolution.
      state.dpr = img.naturalWidth / window.innerWidth;
      state.canvas = document.createElement("canvas");
      state.canvas.width = img.naturalWidth;
      state.canvas.height = cappedCanvasHeight(pageHeight(), state.dpr);
      state.ctx = state.canvas.getContext("2d");
    }
    state.ctx.drawImage(img, 0, Math.round(y * state.dpr));
    return { ok: true };
  }

  async function finish({ filename }) {
    const canvas = state.canvas;
    restore();
    if (!canvas) {
      throw new Error("no frames were captured");
    }
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("PNG export failed"))),
        "image/png"
      );
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { ok: true };
  }

  function restore() {
    if (state.restored) {
      return { ok: true };
    }
    state.restored = true;
    for (const { el, priorValue, priorPriority } of state.hidden) {
      if (priorValue) {
        el.style.setProperty("visibility", priorValue, priorPriority);
      } else {
        el.style.removeProperty("visibility");
      }
    }
    state.hidden = [];
    if (state.scrollbarStyle) {
      state.scrollbarStyle.remove();
      state.scrollbarStyle = null;
    }
    window.scrollTo(state.originalX, state.originalY);
    state.canvas = null;
    state.ctx = null;
    return { ok: true };
  }
})();
```

- [ ] **Step 3: Syntax-check both files**

Run: `node --check extension/content.js && python3 -c "import json; json.load(open('extension/manifest.json')); print('manifest OK')"`
Expected: no output from `node --check`, then `manifest OK`

- [ ] **Step 4: Create `test/harness.html`**

A deterministic page for manual verification: 5000 px tall continuous gradient (stitch seams are instantly visible as banding), numbered section markers every 500 px (ordering/omission is visible), a sticky header (must appear exactly once in the output), and a lazy-loaded image near the bottom (must not be blank).

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Web Capture Test Harness</title>
<style>
  body { margin: 0; font-family: -apple-system, sans-serif; }
  .page {
    height: 5000px;
    background: linear-gradient(to bottom, #ff5f6d, #ffc371, #47c9af, #4568dc, #b06ab3);
    position: relative;
  }
  .sticky-header {
    position: sticky;
    top: 0;
    background: #111;
    color: #fff;
    padding: 12px 20px;
    font-size: 18px;
    z-index: 10;
  }
  .marker {
    position: absolute;
    left: 20px;
    color: #fff;
    font-size: 28px;
    font-weight: 700;
    text-shadow: 0 1px 3px rgba(0,0,0,.6);
  }
  .lazy-wrap { position: absolute; bottom: 120px; left: 20px; }
</style>
</head>
<body>
<div class="page">
  <div class="sticky-header">STICKY HEADER — must appear exactly once in the capture</div>
  <div class="marker" style="top: 100px;">Marker 1 — 100px</div>
  <div class="marker" style="top: 600px;">Marker 2 — 600px</div>
  <div class="marker" style="top: 1100px;">Marker 3 — 1100px</div>
  <div class="marker" style="top: 1600px;">Marker 4 — 1600px</div>
  <div class="marker" style="top: 2100px;">Marker 5 — 2100px</div>
  <div class="marker" style="top: 2600px;">Marker 6 — 2600px</div>
  <div class="marker" style="top: 3100px;">Marker 7 — 3100px</div>
  <div class="marker" style="top: 3600px;">Marker 8 — 3600px</div>
  <div class="marker" style="top: 4100px;">Marker 9 — 4100px</div>
  <div class="marker" style="top: 4600px;">Marker 10 — 4600px</div>
  <div class="lazy-wrap">
    <img loading="lazy" width="400" height="100" alt="lazy test image"
         src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='100'%3E%3Crect width='400' height='100' fill='%23222'/%3E%3Ctext x='200' y='55' fill='%23fff' text-anchor='middle' font-size='20' font-family='sans-serif'%3ELAZY IMAGE LOADED%3C/text%3E%3C/svg%3E">
  </div>
</div>
</body>
</html>
```

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json extension/content.js test/harness.html
git commit -m "feat: add manifest, content-script capture engine, and test harness"
```

---

### Task 3: Background orchestration script

**Files:**
- Create: `extension/background.js`

**Interfaces:**
- Consumes:
  - `computeScrollSteps(pageHeight, viewportHeight)`, `buildFilename(host, date)`, `MAX_CANVAS_PX` globals from `shared.js` (loaded before it via the manifest `background.scripts` order).
  - The content-script message protocol from Task 2 (`measure` / `scrollTo` / `addFrame` / `finish` / `restore`).
  - `browser.tabs.captureVisibleTab(windowId, { format: "png" })` → PNG data URL of the visible viewport.
- Produces: nothing consumed by other tasks — this is the top of the call chain.

- [ ] **Step 1: Create `extension/background.js`**

```js
"use strict";

const BADGE_CLEAR_MS = 2500;

browser.action.onClicked.addListener(async (tab) => {
  try {
    await captureFullPage(tab);
  } catch (err) {
    console.error("Web Capture failed:", err);
    await showErrorBadge(tab.id);
  }
});

async function captureFullPage(tab) {
  // Throws on restricted pages (Safari settings, App Store, PDFs…),
  // which lands in the error-badge path above.
  await browser.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["shared.js", "content.js"],
  });

  const metrics = await sendToTab(tab.id, { type: "measure" });
  const steps = computeScrollSteps(metrics.pageHeight, metrics.viewportHeight);

  try {
    for (let i = 0; i < steps.length; i++) {
      const { y } = await sendToTab(tab.id, {
        type: "scrollTo",
        y: steps[i],
        hideFixed: i > 0,
      });
      if (y * metrics.dpr >= MAX_CANVAS_PX) {
        break; // page is taller than the canvas cap; keep what we have
      }
      const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      await sendToTab(tab.id, { type: "addFrame", dataUrl, y });
    }
    await sendToTab(tab.id, {
      type: "finish",
      filename: buildFilename(metrics.host, new Date()),
    });
  } finally {
    // Idempotent: a no-op after a successful finish, restores the page on
    // any abort. Its own failure must not mask the original error.
    await sendToTab(tab.id, { type: "restore" }).catch(() => {});
  }
}

async function sendToTab(tabId, message) {
  const response = await browser.tabs.sendMessage(tabId, message);
  if (response && response.error) {
    throw new Error(`content script: ${response.error}`);
  }
  return response;
}

async function showErrorBadge(tabId) {
  try {
    await browser.action.setBadgeText({ text: "✕", tabId });
    setTimeout(() => {
      browser.action.setBadgeText({ text: "", tabId }).catch(() => {});
    }, BADGE_CLEAR_MS);
  } catch {
    // Badge is best-effort; never let it throw over the real error.
  }
}
```

- [ ] **Step 2: Syntax-check**

Run: `node --check extension/background.js`
Expected: no output (exit 0)

- [ ] **Step 3: Commit**

```bash
git add extension/background.js
git commit -m "feat: add background capture orchestration with error badge"
```

---

### Task 4: Icon generation

**Files:**
- Create: `scripts/make-icons.swift`
- Create (generated): `extension/images/icon-{48,96,128,256,512}.png`, `extension/images/toolbar-{16,32}.png`

**Interfaces:**
- Consumes: nothing.
- Produces: the seven PNG files referenced by `extension/manifest.json` (Task 2). App icons: white camera glyph on a blue rounded square. Toolbar icons: black camera glyph with a transparent punched-out lens (Safari renders toolbar icons as templates).

- [ ] **Step 1: Create `scripts/make-icons.swift`**

```swift
#!/usr/bin/swift
import AppKit

let outDir = "extension/images"
try FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

func cameraPath(in rect: NSRect) -> NSBezierPath {
    let path = NSBezierPath()
    let body = NSRect(
        x: rect.minX + rect.width * 0.08,
        y: rect.minY + rect.height * 0.16,
        width: rect.width * 0.84,
        height: rect.height * 0.56
    )
    path.append(NSBezierPath(roundedRect: body, xRadius: rect.width * 0.08, yRadius: rect.width * 0.08))
    let bump = NSRect(
        x: rect.minX + rect.width * 0.34,
        y: body.maxY - rect.height * 0.02,
        width: rect.width * 0.32,
        height: rect.height * 0.14
    )
    path.append(NSBezierPath(roundedRect: bump, xRadius: rect.width * 0.04, yRadius: rect.width * 0.04))
    return path
}

func lensRect(in rect: NSRect) -> NSRect {
    let d = rect.width * 0.30
    return NSRect(x: rect.midX - d / 2, y: rect.minY + rect.height * 0.29, width: d, height: d)
}

func renderIcon(pixels: Int, toolbar: Bool, to path: String) {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let full = NSRect(x: 0, y: 0, width: CGFloat(pixels), height: CGFloat(pixels))
    if toolbar {
        NSColor.black.setFill()
        cameraPath(in: full).fill()
        NSGraphicsContext.current?.compositingOperation = .destinationOut
        NSBezierPath(ovalIn: lensRect(in: full)).fill()
    } else {
        let bg = NSColor(calibratedRed: 0.13, green: 0.45, blue: 0.95, alpha: 1)
        let inner = full.insetBy(dx: full.width * 0.12, dy: full.height * 0.12)
        bg.setFill()
        NSBezierPath(
            roundedRect: full.insetBy(dx: full.width * 0.04, dy: full.height * 0.04),
            xRadius: full.width * 0.18, yRadius: full.width * 0.18
        ).fill()
        NSColor.white.setFill()
        cameraPath(in: inner).fill()
        bg.setFill()
        NSBezierPath(ovalIn: lensRect(in: inner)).fill()
    }
    NSGraphicsContext.current?.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
    print("wrote \(path)")
}

for size in [48, 96, 128, 256, 512] {
    renderIcon(pixels: size, toolbar: false, to: "\(outDir)/icon-\(size).png")
}
for size in [16, 32] {
    renderIcon(pixels: size, toolbar: true, to: "\(outDir)/toolbar-\(size).png")
}
```

- [ ] **Step 2: Run the script**

Run: `swift scripts/make-icons.swift`
Expected: seven `wrote extension/images/….png` lines

- [ ] **Step 3: Verify the PNGs are valid**

Run: `for f in extension/images/*.png; do sips -g pixelWidth -g pixelHeight "$f" | tail -2 | xargs echo "$f:"; done`
Expected: each file reports its expected square pixel dimensions (48…512, 16, 32)

Also open one visually: `open extension/images/icon-512.png` — a white camera on a blue rounded square.

- [ ] **Step 4: Commit**

```bash
git add scripts/make-icons.swift extension/images
git commit -m "feat: add icon generator and generated extension icons"
```

---

### Task 5: Xcode project generation and build

**Files:**
- Create (generated): `xcode/Web Capture/` — Xcode project with app + extension targets, referencing (not copying) the files in `extension/`.

**Interfaces:**
- Consumes: the complete `extension/` directory (manifest, three scripts, icons).
- Produces: a built `Web Capture.app` that registers the extension with Safari when launched.

- [ ] **Step 1: Generate the Xcode project**

Run:
```bash
xcrun safari-web-extension-converter extension \
  --project-location xcode \
  --app-name "Web Capture" \
  --bundle-identifier com.markpearce.WebCapture \
  --macos-only --swift --no-open --no-prompt --force
```
Expected: output ending with a summary listing the app name, bundle identifier, platform `macOS`, and the project location `xcode/Web Capture/Web Capture.xcodeproj`. Warnings about unsupported manifest keys are OK; errors are not.

- [ ] **Step 2: Confirm the scheme name**

Run: `xcodebuild -project "xcode/Web Capture/Web Capture.xcodeproj" -list`
Expected: a scheme named `Web Capture`. If it differs (e.g. `Web Capture (macOS)`), use that name in the following steps.

- [ ] **Step 3: Build**

Run:
```bash
xcodebuild -project "xcode/Web Capture/Web Capture.xcodeproj" \
  -scheme "Web Capture" -configuration Debug build \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_ALLOWED=YES
```
Expected: `** BUILD SUCCEEDED **`

- [ ] **Step 4: Locate and launch the built app**

Run:
```bash
APP_DIR=$(xcodebuild -project "xcode/Web Capture/Web Capture.xcodeproj" \
  -scheme "Web Capture" -configuration Debug -showBuildSettings 2>/dev/null \
  | awk '/ BUILT_PRODUCTS_DIR =/{print $3}' | head -1)
open "$APP_DIR/Web Capture.app"
```
Expected: the wrapper app opens with its "open Safari settings" template UI. Launching it registers the extension with Safari.

- [ ] **Step 5: Commit the generated project**

```bash
git add xcode
git commit -m "feat: add generated Xcode wrapper project"
```

---

### Task 6: Enable in Safari and run the manual test matrix

**Files:** none (verification only; fixes discovered here become follow-up edits committed individually).

This task requires the user at the machine — the agent cannot click through Safari UI. Present these steps to the user and wait for their results.

- [ ] **Step 1: One-time Safari setup (user)**

1. Safari → Settings → Advanced → check "Show features for web developers" (if not already).
2. Safari → Settings → Developer → check "Allow unsigned extensions" (needs an admin password; resets when Safari fully quits).
3. Safari → Settings → Extensions → enable "Web Capture".
4. When first clicking the toolbar icon on a site, choose "Always Allow on Every Website" (or per-site as preferred).

- [ ] **Step 2: Harness test (user + agent verifies output)**

Open the harness: `open -a Safari "test/harness.html"` — then click the Web Capture toolbar icon.

Verify in the downloaded PNG (`~/Downloads/<host or 'page'> <date> at <time>.png`):
- Gradient is continuous with no banding/seams at frame boundaries.
- Markers 1–10 all present, in order, none duplicated.
- Sticky header appears exactly once, at the very top.
- "LAZY IMAGE LOADED" box is visible near the bottom, not blank.
- After capture, the page is scrolled back to where it was and the sticky header is visible again.

- [ ] **Step 3: Real-site matrix (user)**

| Case | Site suggestion | Pass criteria |
| --- | --- | --- |
| Short page (no scroll) | example.com | Single-viewport PNG downloads |
| Long article | any long Wikipedia article | Full article, no seams |
| Sticky header | theverge.com article | Header appears once |
| Lazy images | a long image-heavy page | Images rendered, not placeholders |
| Retina sharpness | any | PNG pixel width ≈ 2× viewport width |
| Restricted page | Safari's Favorites/start page | ✕ badge for ~2.5 s, no crash |

- [ ] **Step 4: Fix and commit any issues found**

Each fix: edit the file in `extension/`, rebuild is NOT needed for script changes if the converter referenced (didn't copy) resources — quit and relaunch Safari, or turn the extension off/on in Safari Settings, to pick up changes. Re-run the failing case. Commit each fix separately.

- [ ] **Step 5: Final commit and completion**

Once the matrix passes, use the superpowers:finishing-a-development-branch skill to close out.
