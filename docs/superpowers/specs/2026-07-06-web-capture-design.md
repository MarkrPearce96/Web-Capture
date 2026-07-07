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
   - `manifest.json` — MV3 manifest. Permissions: `activeTab`, `scripting`, `contextMenus` (the latter for the right-click Visible Area / Selected Region menu items). Toolbar action with icon, no popup.
   - `background.js` — non-persistent background script. Listens for the toolbar click and the context-menu items, orchestrates the capture loop (and the single-frame/region flows), performs `captureVisibleTab` calls. Registers its context menu items at top level on every wake, removing all first so re-registration never collides.
   - `content.js` — injected on demand via `browser.scripting.executeScript`. Measures page dimensions, performs scrolling, hides/restores fixed and sticky elements and scrollbars, restores original scroll position, stitches frames onto a canvas, runs the drag-to-select region UI, and shows the preview overlay with Download/Copy options.
   - `shared.js` — pure functions (scroll-step computation, filename generation, canvas-height cap) loaded by both scripts and unit-testable in Node.
   - `pdf.js` — dependency-free multi-page PDF builder (A4 pages, JPEG-embedded), Node-tested.

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
6. Content script exports the canvas to a PNG blob and shows an in-page preview overlay (a shadow-DOM host appended to `document.documentElement`, dimmed backdrop, centered scrollable image panel). The user then chooses Download (saves the PNG via an anchor-click download), Copy (writes the PNG to the clipboard), or dismisses the overlay (✕, backdrop click, or Escape) without saving.

## Capture Modes

Left-click on the toolbar icon triggers the scroll-and-stitch full-page capture described above, unchanged. A right-click opens a context menu — on the toolbar icon where Safari supports the `action` menu context, and also on the page itself — with two additional modes:

- **Visible Area**: a single instant frame of exactly what's on screen, no scrolling. The background script captures the visible tab *before* injecting anything, so nothing the extension adds (progress pill, overlay) can appear in the image, then injects the content script and hands it the frame to preview.
- **Selected Region**: the content script shows a full-viewport drag-to-select overlay (dimmed crosshair cursor, dashed selection box with a live width × height label, a hint pill with Esc-to-cancel). Releasing the drag sends the selected rectangle back to the background script, which captures the visible tab and crops it to that rectangle at native (device) resolution — the crop math scales the viewport-CSS-px rectangle by the ratio between the captured frame's width and the viewport width, since Safari decides the capture's actual pixel resolution. A drag smaller than 4×4 CSS px is treated as a cancel; Esc at any time cancels.

Both modes feed the same preview overlay and Download/Copy/format-dropdown options as the full-page flow — only the canvas that's handed to the overlay differs (a single cropped or full frame instead of a stitched multi-frame one).

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
