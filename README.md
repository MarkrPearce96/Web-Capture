# Web Capture

A Safari Web Extension for macOS that captures full-page, visible-area, or
selected-region screenshots, with a built-in annotation suite (pen, shapes,
lines, text boxes, and an OCR-powered highlighter) in the capture preview.

## Install

```bash
brew tap markrpearce96/tap
brew install --cask web-capture
```

**This build is unsigned** (personal Apple ID, not notarized — no paid
Apple Developer account behind it). After installing:

1. Right-click **Web Capture** in Applications and choose **Open** once,
   to get past Gatekeeper's "unidentified developer" warning.
2. In Safari: **Settings → Advanced** → check **Show Develop menu**, then
   **Develop → Allow Unsigned Extensions** (this resets every time Safari
   fully quits, so you'll redo it each session).
3. Enable the extension under **Safari → Settings → Extensions**.

## Building from source

Requires the full Xcode app (not just Command Line Tools).

```bash
xcodebuild -project "xcode/Web Capture/Web Capture.xcodeproj" -scheme "Web Capture" -configuration Debug build
```

Then open the built `.app` from Xcode's DerivedData output.
