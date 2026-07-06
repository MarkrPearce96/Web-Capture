# Web Capture — Safari Full-Page Screenshot Extension

**Date:** 2026-07-06
**Status:** Approved

## Purpose

A Safari Web Extension for macOS. Clicking its toolbar icon captures a screenshot of the entire current web page (not just the visible viewport) and saves it as a PNG to the Downloads folder.

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
   - `manifest.json` — MV3 manifest. Permissions: `activeTab`, `scripting`. Toolbar action with icon, no popup.
   - `background.js` — non-persistent background script. Listens for the toolbar click, orchestrates the capture loop, performs `captureVisibleTab` calls.
   - `content.js` — injected on demand via `browser.scripting.executeScript`. Measures page dimensions, performs scrolling, hides/restores fixed and sticky elements and scrollbars, restores original scroll position, stitches frames onto a canvas, and saves the PNG.
   - `shared.js` — pure functions (scroll-step computation, filename generation, canvas-height cap) loaded by both scripts and unit-testable in Node.

Note: Safari does not support the `browser.downloads` WebExtension API, so the save is triggered from the content script via an invisible `<a download>` anchor click on a blob URL — this saves to the Downloads folder with the chosen filename, with no dialog under Safari's default settings.

Stitching happens in the content script (not the background script) so each captured frame is sent as its own modest-sized message rather than one very large final image crossing the messaging boundary.

## Capture Flow

1. User clicks the toolbar icon.
2. Background script injects the content script into the active tab.
3. Content script reports: full page width/height, viewport width/height, device pixel ratio, current scroll position.
4. Content script does a pre-scroll pass: quickly scrolls the whole page top to bottom and back, so scroll-linked animations (e.g. GSAP ScrollTrigger reveals) and lazy-loaded content have fired and finished before capture, then re-measures page height in case that growth changed it (e.g. from lazy loading).
5. Loop, from page top to bottom in viewport-height steps:
   - Content script scrolls to the target offset and waits briefly (~350 ms) for rendering and lazy-loaded content.
   - When hiding is requested, `position: fixed` and `position: sticky` elements are hidden so they appear once at the top of the image rather than repeating. This hiding scan re-runs after every scroll step (not just the first) so headers that only become fixed once scrolling starts (e.g. a scroll-listener-driven search bar) are still caught, even though they weren't fixed yet at the first step.
   - Background script calls `captureVisibleTab` (PNG data URL) and draws the frame onto the stitch canvas at the correct offset. The final frame is cropped so overlapping content is not duplicated.
6. Content script restores hidden elements, scrollbars, and the original scroll position.
7. Content script exports the canvas to a PNG blob and saves it via an anchor-click download.

## Output

- Format: PNG at native device resolution (2x on Retina).
- Destination: Downloads folder via an anchor-click download (no save dialog under Safari's default download settings).
- Filename: `<host> <YYYY-MM-DD> at <HH.MM.SS>.png`, e.g. `example.com 2026-07-06 at 23.55.12.png`.

## Error Handling

- **Restricted pages** (Safari settings pages, App Store, PDFs, pages where the user hasn't granted access): the toolbar icon shows a brief badge (e.g. "✕") instead of failing silently.
- **Canvas size cap:** stitched height is capped (~16,384 px). Taller pages are captured up to the cap; the capture still completes and downloads.
- **Per-frame capture failure:** capture aborts, page state (scroll position, hidden elements) is restored, error badge shown.
- Any abort path must restore the page: element visibility, scrollbars, and scroll position are reset in a `finally`-equivalent step.

## Testing

- Manual test matrix: a short page (no scrolling needed), a long article page, a page with a sticky header (verify no repeats), a lazy-loading page (verify images render), a Retina display check (verify sharpness), and a restricted page (verify the error badge).
- JavaScript logic that is testable in isolation (filename generation, scroll-step computation, frame-crop math) is written as pure functions so it can be sanity-checked without Safari.

## One-Time Setup After Building

1. Build and run the wrapper app once from Xcode.
2. Safari → Settings → Extensions → enable "Web Capture".
3. Safari → Settings → Developer → check "Allow unsigned extensions" (required for personally-signed builds; resets on Safari restart).
4. Grant the extension access ("Always Allow on Every Website" or per-site).
