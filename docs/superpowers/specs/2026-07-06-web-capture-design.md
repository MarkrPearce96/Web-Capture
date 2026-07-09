# Web Capture — Safari Full-Page Screenshot Extension

**Date:** 2026-07-06
**Status:** Approved

## Purpose

A Safari Web Extension for macOS. Clicking its toolbar icon captures a screenshot of the entire current web page (not just the visible viewport) and shows an in-page preview overlay with Download and Copy options: Download saves the PNG to the Downloads folder, Copy puts it on the clipboard.

Personal use only: built and run locally via Xcode with personal signing. No App Store distribution, no Apple Developer account.

## Approach

Scroll-and-stitch. Safari's extension API (`browser.tabs.captureVisibleTab`) can only capture the visible viewport, so the extension scrolls the page one viewport at a time, captures each frame, and stitches the frames onto an offscreen canvas to produce one tall PNG.

Alternatives considered and rejected:

- **DOM re-rendering (html2canvas):** re-draws HTML to canvas without scrolling; inaccurate with fonts, cross-origin images, video, and modern CSS.
- **Print-to-PDF automation:** no Safari extension API for this; would abandon the click-the-icon flow.

## Architecture

An Xcode project with two targets:

1. **Wrapper app (`Web Capture`)** — minimal macOS app required to host a Safari extension. Its only job is to exist and point the user to Safari's extension settings. No custom logic beyond the Xcode template.
2. **Safari Web Extension (`Web Capture Extension`)** — plain JavaScript, Manifest V3, no frameworks or build step. Components:
   - `manifest.json` — MV3 manifest. Permissions: `activeTab`, `scripting`. Toolbar action with icon and a `default_popup` (`popup.html`) offering the three capture modes.
   - `background.js` — non-persistent background script. Listens for the popup's `captureRequest` message, orchestrates the capture loop (and the single-frame/region flows), performs `captureVisibleTab` calls.
   - `content.js` — injected on demand via `browser.scripting.executeScript`. Measures page dimensions, performs scrolling, hides/restores fixed and sticky elements and scrollbars, restores original scroll position, stitches frames onto a canvas, runs the drag-to-select region UI, and shows the preview overlay with Download/Copy options.
   - `shared.js` — pure functions (scroll-step computation, filename generation, canvas-height cap) loaded by both scripts and unit-testable in Node.
   - `pdf.js` — dependency-free multi-page PDF builder (A4 pages, JPEG-embedded), Node-tested.
   - `annotate.js` — markup toolbar and drawing layer for the preview overlay (pen, highlighter, Shapes dropdown, Lines dropdown, text); pure arrowhead geometry Node-tested.

Note: Safari does not support the `browser.downloads` WebExtension API, so when the user clicks Download in the preview overlay, the save is triggered from the content script via an invisible `<a download>` anchor click on a blob URL — this saves to the Downloads folder with the chosen filename, with no dialog under Safari's default settings.

Stitching happens in the content script (not the background script) so each captured frame is sent as its own modest-sized message rather than one very large final image crossing the messaging boundary.

## Capture Flow

1. User clicks the toolbar icon.
2. Background script injects the content script into the active tab.
3. Content script reports: full page width/height, viewport width/height, device pixel ratio, current scroll position.
4. Loop, from page top to bottom in viewport-height steps:
   - Content script scrolls to the target offset and waits ~700 ms (long enough for scroll-linked animations and lazy-loaded content to finish before the frame is captured; this single longer dwell replaces an earlier separate scroll pass, so the page is only scrolled through once).
   - When hiding is requested, `position: fixed` and `position: sticky` elements are hidden so they appear once at the top of the image rather than repeating. This hiding scan re-runs after every scroll step (not just the first) so headers that only become fixed once scrolling starts (e.g. a scroll-listener-driven search bar) are still caught, even though they weren't fixed yet at the first step.
   - Background script calls `captureVisibleTab` (PNG data URL) and draws the frame onto the stitch canvas at the correct offset. The final frame is cropped so overlapping content is not duplicated. A bottom-center progress pill (bar plus percentage) shows capture progress while the loop runs; it is hidden at the instant each frame is captured so it never appears in the screenshot, and reappears for the next step. It is removed entirely when capture finishes or aborts.
5. Content script restores hidden elements, scrollbars, and the original scroll position.
6. Content script exports the canvas to a PNG blob and shows an in-page preview overlay (a shadow-DOM host appended to `document.documentElement`, dimmed backdrop, centered scrollable image panel). The user then chooses Download (saves the PNG via an anchor-click download), Copy (writes the PNG to the clipboard), or dismisses the overlay (✕, backdrop click, or Escape) without saving. The page behind the overlay is scroll-locked while it is open, and the preview supports pinch-to-zoom (trackpad pinch or ctrl+scroll, 1×–6×, cursor-anchored).

## Capture Modes

Clicking the toolbar icon opens a small popup (`popup.html`/`popup.js`) with three options — Full Page, Visible Area, Select Region — each with a glyph and a short sublabel. Choosing one sends a `captureRequest` message (`{ mode: "full" | "visible" | "region" }`) to the background script and immediately closes the popup; the background script looks up the active tab and dispatches to the matching flow. The popup does not wait for the capture to finish — closing it immediately keeps it from blocking region selection or a long full-page capture.

- **Full Page**: the scroll-and-stitch capture described above, unchanged.
- **Visible Area**: a single instant frame of exactly what's on screen, no scrolling. The background script captures the visible tab *before* injecting anything, so nothing the extension adds (progress pill, overlay) can appear in the image, then injects the content script and hands it the frame to preview.
- **Select Region**: the content script shows a full-viewport drag-to-select overlay (dimmed crosshair cursor, dashed selection box with a live width × height label, a hint pill with Esc-to-cancel). Releasing the drag sends the selected rectangle back to the background script, which captures the visible tab and crops it to that rectangle at native (device) resolution — the crop math scales the viewport-CSS-px rectangle by the ratio between the captured frame's width and the viewport width, since Safari decides the capture's actual pixel resolution. A drag smaller than 4×4 CSS px is treated as a cancel; Esc at any time cancels.

All three modes feed the same preview overlay and Download/Copy/format-dropdown options — only the canvas that's handed to the overlay differs (a single cropped, single full, or stitched multi-frame canvas).

## Annotation

The preview overlay includes a markup toolbar (a row directly above the image area) for drawing on the captured image before exporting it:

- **Tools**: Select, Pen (freehand), Highlighter, Shapes, Lines, Text. Selecting a tool switches the image area from its normal scroll/pan behavior to drawing mode (crosshair cursor); clicking the active tool again deselects it and returns to normal scrolling. No tool is selected by default.
- **Shapes**: a single toolbar button (between Highlighter and Lines) opens a small flyout to pick one of five shapes — rectangle, ellipse, triangle, diamond, star (each also available as a filled variant). The picked shape becomes the active drawing tool and stays the button's default until another shape is picked; the button's icon reflects the last-picked shape. All five draw within a drag bounding box exactly like rectangle/ellipse always have, and share the same resize handles, hit-testing, and Shift-to-square constraint.
- **Lines**: a single toolbar button (between Shapes and Text) opens a small flyout to pick one of six line/arrow variants — solid line, dashed line, dotted line, arrow, double-headed arrow, dashed arrow. The picked variant becomes the active drawing tool and stays the button's default until another variant is picked; the button's icon reflects the last-picked variant. All six draw a straight segment from drag-start to drag-end and share the same 2-endpoint resize handles and segment-based hit-testing line/arrow always have; only the arrowhead(s) are ever drawn solid, never dashed/dotted.
- **Text**: click to place a box, then type inline into an editor shown right on the image (auto-growing to fit, previewing the font/color/background live). Committing (clicking elsewhere, pressing Escape, blurring, or switching tools) finalizes the box; leaving it empty discards it instead. The selected box shows a floating options bar above it (below if there's no room above) for per-box text color, background color (or none), and font size, all applied immediately. Double-click a text box to re-edit it inline.
- **Highlighter**: on-device Apple Vision OCR (via the native host) detects words in the captured image the first time the tool is selected for a capture, showing a brief "Scanning text…" indicator while it runs. Dragging the highlighter snaps a translucent highlight to individual words it passes over, and falls back to a translucent freehand band in areas with no detected text (e.g. images, whitespace). Like every other annotation, highlights are baked into all exports (PNG/JPEG/PDF/copy) at full resolution, not just the on-screen preview.
- **Colors**: six swatches — red `#ff3b30` (default), yellow `#ffcc00`, green `#34c759`, blue `#007aff`, black `#000000`, white `#ffffff`.
- **Stroke sizes**: three presets — S (2px), M (4px), L (8px), shown as small/medium/large filled dots.
- **Undo** removes the most recent annotation; **Clear** removes all of them. Both are no-ops when there are no annotations.

Annotations are stored as vectors (points/endpoints, color, stroke width) in the captured image's native pixel coordinates, not screen coordinates, so they stay pixel-accurate regardless of how large or small the preview panel is rendered on screen. They are drawn live on a transparent canvas layered exactly over the preview `<img>`, and — critically — are baked into every export at full resolution: PNG and JPEG downloads, the PDF's paginated slices, and the Copy-to-clipboard PNG all render from a composite of the original capture plus the annotations, not just the on-screen preview. Dismissing the overlay discards all annotations; there is no separate "save annotations" step.

## Output

- Format: captured at native device resolution (2x on Retina); Download exports the format chosen in the preview overlay's dropdown — PNG (default, lossless), JPEG with a 50–100% quality slider, or PDF paginated into A4 pages (image embedded as JPEG at 85%). The filename extension follows the chosen format (`.png` / `.jpg` / `.pdf`). Copy always places a PNG on the clipboard, regardless of the dropdown's selection.
- The file is saved only when the user clicks Download in the preview overlay — via an anchor-click download to the Downloads folder (no save dialog under Safari's default download settings), using the same filename format. Copy places the PNG on the clipboard instead of saving a file. Dismissing the overlay without choosing either does neither.
- Filename: `<host> <YYYY-MM-DD> at <HH.MM.SS>.png`, e.g. `example.com 2026-07-06 at 23.55.12.png` (extension swapped to `.jpg`/`.pdf` when that format is chosen for Download).

## Error Handling

- **Restricted pages** (Safari settings pages, App Store, PDFs, pages where the user hasn't granted access): the toolbar icon shows a brief badge (e.g. "✕") instead of failing silently.
- **Canvas size cap:** stitched height is capped (~16,384 px). Taller pages are captured up to the cap; the capture still completes and the preview overlay is shown.
- **Per-frame capture failure:** capture aborts, page state (scroll position, hidden elements) is restored, error badge shown.
- Any abort path must restore the page: element visibility, scrollbars, and scroll position are reset in a `finally`-equivalent step.

## Testing

- Manual test matrix: a short page (no scrolling needed), a long article page, a page with a sticky header (verify no repeats), a lazy-loading page (verify images render), a Retina display check (verify sharpness), a restricted page (verify the error badge), and the preview overlay (verify Download saves the file, Copy puts the PNG on the clipboard, and ✕ / backdrop click / Escape dismiss without saving).
- JavaScript logic that is testable in isolation (filename generation, scroll-step computation, frame-crop math) is written as pure functions so it can be sanity-checked without Safari.

## One-Time Setup After Building

1. Build and run the wrapper app once from Xcode.
2. Safari → Settings → Extensions → enable "Web Capture".
3. Safari → Settings → Developer → check "Allow unsigned extensions" (required for personally-signed builds; resets on Safari restart).
4. Grant the extension access ("Always Allow on Every Website" or per-site).
