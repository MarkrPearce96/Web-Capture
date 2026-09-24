# Homebrew Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user install and upgrade Web Capture with `brew install markrpearce96/tap/web-capture` instead of building it in Xcode by hand.

**Architecture:** A GitHub Actions workflow in the `Web-Capture` repo builds an ad-hoc-signed Release configuration of the app on tag push, zips it, and publishes a GitHub Release. A separate, small `homebrew-tap` repo holds a Homebrew Cask formula pointing at that release asset. `LICENSE` and `README.md` are added to `Web-Capture` since it's public and currently has neither.

**Tech Stack:** GitHub Actions (macOS runner), `xcodebuild`, `ditto`, Ruby (Homebrew Cask DSL), Homebrew.

**Spec:** `docs/superpowers/specs/2026-09-24-homebrew-distribution-design.md`

## Global Constraints

- No paid Apple Developer account — builds are ad-hoc signed (`CODE_SIGN_IDENTITY=-`), never notarized. Every task must not introduce a dependency on a Developer ID cert or `notarytool`.
- Distribution is via a **personal tap** (`MarkrPearce96/homebrew-tap`), never the official `homebrew-cask` repo.
- Release artifact is a **zip** (via `ditto`), not a dmg.
- New repos/directories go under `~/Developer` (user's global convention) — the tap repo clones to `~/Developer/homebrew-tap`.
- Starting version is `1.0.0`, matching git tag `v1.0.0` — the Xcode project's `MARKETING_VERSION` and the git tag and the Cask's `version` must always match exactly for a given release.
- License is **MIT**, copyright holder Mark Pearce.

## Review Focus

- Re-running the release workflow against a tag that already has a published release (`gh release create` fails "already exists") — a person fixing a mistake and re-pushing the same tag should get a clear, expected failure, not a silent partial state. (Task 6)
- Every path with a space (`Web Capture.xcodeproj`, `Web Capture.app`) must stay correctly quoted through `xcodebuild`/`ditto`/`unzip` — an unquoted path silently building or zipping the wrong (or nothing) thing is the single most likely CI failure here. (Task 4, Task 6)
- The zip's internal top-level entry must be exactly `Web Capture.app` (not nested under a longer build-output path) — Homebrew's `app "Web Capture.app"` stanza only finds it there. (Task 4, Task 6)
- `brew install --cask web-capture` on a Mac that already has a manually Xcode-built `/Applications/Web Capture.app` (not Homebrew-managed) — Homebrew refuses to overwrite an app it doesn't manage. (Task 7)
- `MARKETING_VERSION` drifting from the git tag / Cask `version` on a future release (e.g. someone bumps one and forgets the other) — produces an app that reports a different version than what Homebrew thinks it installed. (Task 3, Task 6)

---

### Task 1: Add MIT LICENSE

**Files:**
- Create: `LICENSE`

**Interfaces:** None — standalone file.

- [ ] **Step 1: Write the LICENSE file**

```text
MIT License

Copyright (c) 2026 Mark Pearce

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Verify**

Run: `head -1 LICENSE && grep -c "Mark Pearce" LICENSE`
Expected: `MIT License` then `1`

- [ ] **Step 3: Commit**

```bash
git add LICENSE
git commit -m "chore: add MIT license"
```

---

### Task 2: Add README.md

**Files:**
- Create: `README.md`

**Interfaces:** References the install command from Task 5/7 (`brew tap markrpearce96/tap`, `brew install --cask web-capture`) — these exact commands must match what the tap is actually named in Task 5.

- [ ] **Step 1: Write the README**

```markdown
# Web Capture

A Safari Web Extension for macOS that captures full-page, visible-area, or
selected-region screenshots, with a built-in annotation suite (pen, shapes,
lines, text boxes, and an OCR-powered highlighter) in the capture preview.

## Install

```
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

```
xcodebuild -project "xcode/Web Capture/Web Capture.xcodeproj" -scheme "Web Capture" -configuration Debug build
```

Then open the built `.app` from Xcode's DerivedData output.
```

- [ ] **Step 2: Verify**

Run: `grep -c "^## Install" README.md && grep -c "brew install --cask web-capture" README.md`
Expected: `1` then `1`

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add README with Homebrew install instructions"
```

---

### Task 3: Bump MARKETING_VERSION to 1.0.0

**Files:**
- Modify: `xcode/Web Capture/Web Capture.xcodeproj/project.pbxproj` (4 occurrences of `MARKETING_VERSION = 1.0;`)

**Interfaces:** Produces the version string (`1.0.0`) that Task 6's git tag and Task 5's Cask `version` must match exactly.

- [ ] **Step 1: Replace all 4 occurrences**

In `xcode/Web Capture/Web Capture.xcodeproj/project.pbxproj`, change every line reading:
```
				MARKETING_VERSION = 1.0;
```
to:
```
				MARKETING_VERSION = 1.0.0;
```
(Preserve the existing leading whitespace/tabs on each line — only the value changes.)

- [ ] **Step 2: Verify**

Run:
```bash
grep -c "MARKETING_VERSION = 1.0.0;" "xcode/Web Capture/Web Capture.xcodeproj/project.pbxproj"
grep -c "MARKETING_VERSION = 1.0;" "xcode/Web Capture/Web Capture.xcodeproj/project.pbxproj"
```
Expected: `4` then `0`

- [ ] **Step 3: Commit**

```bash
git add "xcode/Web Capture/Web Capture.xcodeproj/project.pbxproj"
git commit -m "chore: bump MARKETING_VERSION to 1.0.0 for first release"
```

---

### Task 4: Add GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: git tag matching `v*.*.*` (produced manually in Task 6).
- Produces: a GitHub Release named after the tag, with `WebCapture.zip` attached — consumed by Task 6 (to get the real sha256) and by end users (Task 7).

- [ ] **Step 1: Write the workflow file**

```yaml
name: Release

on:
  push:
    tags:
      - "v*.*.*"

jobs:
  build-and-release:
    runs-on: macos-15
    permissions:
      contents: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Select latest Xcode
        uses: maxim-lobanov/setup-xcode@v1
        with:
          xcode-version: latest-stable

      - name: Build (ad-hoc signed)
        run: |
          xcodebuild \
            -project "xcode/Web Capture/Web Capture.xcodeproj" \
            -scheme "Web Capture" \
            -configuration Release \
            -derivedDataPath build \
            CODE_SIGN_IDENTITY=- \
            CODE_SIGNING_ALLOWED=YES \
            CODE_SIGNING_REQUIRED=YES \
            build

      - name: Verify built version matches the tag
        run: |
          APP_PATH="build/Build/Products/Release/Web Capture.app"
          TAG="${GITHUB_REF#refs/tags/v}"
          BUILT_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP_PATH/Contents/Info.plist")
          if [ "$BUILT_VERSION" != "$TAG" ]; then
            echo "Tag is v$TAG but built app reports version $BUILT_VERSION (MARKETING_VERSION out of sync with the tag)" >&2
            exit 1
          fi

      - name: Zip the app
        run: |
          APP_PATH="build/Build/Products/Release/Web Capture.app"
          if [ ! -d "$APP_PATH" ]; then
            echo "Built app not found at $APP_PATH" >&2
            find build/Build/Products -maxdepth 3 >&2
            exit 1
          fi
          ditto -c -k --keepParent "$APP_PATH" WebCapture.zip
          TOP_ENTRY=$(unzip -Z1 WebCapture.zip | head -1)
          if [ "$TOP_ENTRY" != "Web Capture.app/" ]; then
            echo "Zip's top-level entry is '$TOP_ENTRY', expected 'Web Capture.app/'" >&2
            unzip -Z1 WebCapture.zip >&2
            exit 1
          fi

      - name: Compute sha256
        run: shasum -a 256 WebCapture.zip | tee sha256.txt

      - name: Create GitHub Release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          TAG="${GITHUB_REF#refs/tags/}"
          gh release create "$TAG" WebCapture.zip \
            --title "$TAG" \
            --generate-notes \
            --notes-file <(echo "sha256: $(cut -d' ' -f1 sha256.txt)")
```

- [ ] **Step 2: Verify YAML syntax**

Run: `ruby -ryaml -e "YAML.load_file('.github/workflows/release.yml'); puts 'OK'"`
Expected: `OK`

- [ ] **Step 3: Verify path quoting by inspection**

Run: `grep -n 'Web Capture' .github/workflows/release.yml`
Expected: every occurrence of a path containing `Web Capture` is inside double quotes (e.g. `"xcode/Web Capture/Web Capture.xcodeproj"`, `"$APP_PATH"`) — read the output and confirm none are bare/unquoted.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add release workflow to build and publish on tag push"
```

Note: this workflow cannot be fully exercised until Task 6 pushes a real tag — Step 2/3 here only catch syntax and quoting mistakes, not build failures.

---

### Task 5: Create the `homebrew-tap` repo with the Cask formula

**Files:**
- Create (new repo): `~/Developer/homebrew-tap/Casks/web-capture.rb`

**Interfaces:**
- Consumes: version `1.0.0` (Task 3), the download URL pattern `https://github.com/MarkrPearce96/Web-Capture/releases/download/v#{version}/WebCapture.zip` (Task 4's release output).
- Produces: the `web-capture` cask name and `markrpearce96/tap` tap name that Task 2's README and Task 7's install steps depend on exactly.

- [ ] **Step 1: Create and clone the new repo**

```bash
cd ~/Developer
gh repo create MarkrPearce96/homebrew-tap --public \
  --description "Personal Homebrew tap for Mark Pearce's apps" \
  --clone
cd homebrew-tap
mkdir -p Casks
```

- [ ] **Step 2: Write the Cask formula**

Create `~/Developer/homebrew-tap/Casks/web-capture.rb`:

```ruby
cask "web-capture" do
  version "1.0.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/MarkrPearce96/Web-Capture/releases/download/v#{version}/WebCapture.zip"
  name "Web Capture"
  desc "Safari full-page screenshot and annotation extension"
  homepage "https://github.com/MarkrPearce96/Web-Capture"

  auto_updates false

  app "Web Capture.app"

  caveats <<~EOS
    Web Capture is unsigned (personal use, not notarized). On first launch:
      1. Right-click "Web Capture" in Applications and choose "Open" to
         bypass Gatekeeper (only needed once).
      2. In Safari: Settings > Advanced > check "Show Develop menu",
         then Develop > "Allow Unsigned Extensions" (resets each time
         Safari fully quits).
      3. Enable the extension in Safari > Settings > Extensions.
  EOS
end
```

(The sha256 above is a 68-character placeholder — real Homebrew sha256 values are 64 hex characters; this deliberately-wrong-length placeholder makes it obvious and impossible to mistake for a real one if Task 6 is somehow skipped. It will be replaced with the real 64-character sha256 in Task 6.)

- [ ] **Step 3: Verify Ruby syntax**

Run: `ruby -c Casks/web-capture.rb`
Expected: `Syntax OK`

- [ ] **Step 4: Verify Homebrew style**

Run: `brew style --fix Casks/web-capture.rb`
Expected: exits 0 (no offenses), or auto-fixes formatting — re-run once more after any auto-fix to confirm a clean pass.

- [ ] **Step 5: Commit and push**

```bash
git add Casks/web-capture.rb
git commit -m "feat: add web-capture cask (pending first release sha256)"
git push origin main
```

---

### Task 6: Cut the v1.0.0 release and finalize the Cask

**Files:**
- Modify: `~/Developer/homebrew-tap/Casks/web-capture.rb` (replace placeholder `sha256`)

**Interfaces:**
- Consumes: `.github/workflows/release.yml` (Task 4), `Casks/web-capture.rb` skeleton (Task 5).
- Produces: a real, installable release — consumed by Task 7's end-to-end check.

- [ ] **Step 1: Tag and push**

From the `Web-Capture` repo:

```bash
cd "/Users/marks-mac/Developer/App Projects/Web Capture"
git tag v1.0.0
git push origin v1.0.0
```

If this errors because a release for `v1.0.0` already exists (re-running after a fix), first decide deliberately whether to delete the old tag/release (`gh release delete v1.0.0 --yes && git push origin :refs/tags/v1.0.0`) before re-tagging — never silently overwrite.

- [ ] **Step 2: Watch the workflow run**

```bash
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

Expected: exits 0. If it fails, read the failing step's log (`gh run view --log-failed`) — the two most likely causes are a quoting mistake (Review Focus item 2) or the runner's Xcode not supporting this project's deployment target (SDK too old); fix and re-tag per Step 1's rule.

- [ ] **Step 3: Verify the release asset exists**

Run: `gh release view v1.0.0 --json assets --jq '.assets[].name'`
Expected: `WebCapture.zip`

- [ ] **Step 4: Get the real sha256**

```bash
curl -sL -o /tmp/WebCapture.zip \
  "https://github.com/MarkrPearce96/Web-Capture/releases/download/v1.0.0/WebCapture.zip"
shasum -a 256 /tmp/WebCapture.zip
```

- [ ] **Step 5: Update the Cask with the real sha256**

In `~/Developer/homebrew-tap/Casks/web-capture.rb`, replace the placeholder:
```ruby
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
```
with the real 64-character value from Step 4:
```ruby
  sha256 "<real sha256 from shasum output>"
```

- [ ] **Step 6: Verify**

```bash
cd ~/Developer/homebrew-tap
ruby -c Casks/web-capture.rb
brew style Casks/web-capture.rb
```
Expected: `Syntax OK`, then no style offenses.

- [ ] **Step 7: Commit and push**

```bash
git add Casks/web-capture.rb
git commit -m "fix: set real sha256 for v1.0.0 release"
git push origin main
```

---

### Task 7: End-to-end install verification

**Files:** None (verification only).

**Interfaces:** Consumes everything from Tasks 1–6.

- [ ] **Step 1: Check for a pre-existing, non-Homebrew copy of the app**

```bash
ls -la "/Applications/Web Capture.app" 2>&1
```
If it exists and was placed there manually (e.g. via Xcode's "Products" > "Show in Finder" during earlier dev work), move or remove it first — Homebrew Cask refuses to overwrite an app it doesn't manage:
```bash
rm -rf "/Applications/Web Capture.app"
```

- [ ] **Step 2: Tap and install**

```bash
brew tap markrpearce96/tap
brew install --cask web-capture
```
Expected: installs successfully, ends with `Web Capture.app was successfully installed!` and prints the `caveats` block from Task 5.

- [ ] **Step 3: Confirm the app is present**

Run: `ls -d "/Applications/Web Capture.app"`
Expected: the path exists.

- [ ] **Step 4: Manual Gatekeeper + Safari check (human partner performs this step)**

Ask the human partner to:
1. Right-click `Web Capture.app` in Applications → Open, and confirm it launches past the Gatekeeper warning.
2. Enable "Allow Unsigned Extensions" in Safari's Develop menu.
3. Check whether Web Capture appears and can be enabled under Safari → Settings → Extensions.

Report back pass/fail. **If Safari refuses to list/enable the ad-hoc-signed extension** (the one open risk flagged in the spec), the fallback is: export the existing free-personal-team certificate from Keychain Access as a `.p12`, add it as two GitHub encrypted secrets, and change Task 4's workflow to import that certificate into a temporary CI keychain and sign with it instead of `CODE_SIGN_IDENTITY=-`. That fallback is a follow-up task, not attempted speculatively here.

- [ ] **Step 5: Confirm upgrade path works (optional, once a v1.0.1 exists)**

Not part of this plan's scope — noted here only so a future release remembers to sanity-check `brew upgrade --cask web-capture` once there's a second version to upgrade to.
