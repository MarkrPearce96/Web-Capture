# Web Capture

A Safari Web Extension for macOS that captures full-page, visible-area, or
selected-region screenshots, with a built-in annotation suite (pen, shapes,
lines, text boxes, and an OCR-powered highlighter) in the capture preview.

## Install

```bash
brew tap markrpearce96/tap
brew trust markrpearce96/tap
brew install --cask web-capture
```

The `brew trust` step is needed because Homebrew refuses to install casks
from a third-party tap until you explicitly trust it — a one-time,
per-Mac step.

**This build is signed with a personal Apple Development certificate, not
notarized** (personal Apple ID, no paid Apple Developer account behind it).
After installing:

1. Open it once (double-click or right-click → Open). If Gatekeeper blocks
   it, go to **System Settings → Privacy & Security**, scroll down, and
   click **Open Anyway** next to the Web Capture warning (only needed
   once).
2. In Safari: **Settings → Advanced** → check **Show Develop menu**, then
   **Develop → Allow Unsigned Extensions** (this resets every time Safari
   fully quits, so you'll redo it each session).
3. Enable the extension under **Safari → Settings → Extensions**.

## Building from source

Requires the full Xcode app (not just Command Line Tools), signed in with an
Apple ID that has a free "Apple Development" certificate (Xcode → Settings →
Accounts → Manage Certificates → **+**) — Safari refuses to register
extensions signed ad-hoc or self-signed, even for local personal builds.

```bash
xcodebuild -project "xcode/Web Capture/Web Capture.xcodeproj" -scheme "Web Capture" -configuration Debug build
```

Then open the built `.app` from Xcode's DerivedData output.
