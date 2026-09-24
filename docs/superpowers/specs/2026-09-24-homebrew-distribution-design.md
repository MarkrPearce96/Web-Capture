# Homebrew distribution for Web Capture

## Context

Web Capture is a personally-signed (free Apple ID team, no paid Developer
Program, no notarization), personal-use Safari Web Extension app. The repo
(`MarkrPearce96/Web-Capture`) is public. The goal is to let the primary
user (and anyone else who's willing to accept the friction of an unsigned
app) install and upgrade the app with `brew install` instead of building it
from Xcode by hand.

Constraints established during design:

- **No paid Apple Developer account** — no Developer ID cert, no
  notarization. Distribution will be ad-hoc/unsigned. Gatekeeper will block
  first launch until the user right-clicks → Open, and Safari requires
  "Allow Unsigned Extensions" (Safari's Develop menu) to enable the
  extension at all — this is already true today for the user's own local
  free-team-signed builds, so it isn't a regression.
- **Personal-use audience** — this is not going to the official
  `homebrew-cask` repo (which expects notarized, notable software). It gets
  its own personal tap.
- **This Mac currently has only Command Line Tools, not full Xcode** — but
  full Xcode is required for the project's normal edit/build/test loop
  regardless of this work (confirmed: `xcodebuild` errors under CLT alone).
  Release builds will run in GitHub Actions instead of locally, since:
  - It's free for a public repo.
  - The signing outcome is identical either way (ad-hoc/unsigned), so there
    is no functional downside to building in CI vs. locally.
  - It turns "cut a release" into `git tag vX.Y.Z && git push --tags`
    instead of a remembered manual sequence.
- **Release artifact is a zip, not a dmg** — Homebrew Cask mounts/copies
  either format silently when installing, so a dmg's main advantage (a
  polished drag-to-Applications window) is never seen by a `brew install`
  user. Zip is a one-line `ditto` command in CI with no mounting/locking
  failure modes; dmg would need `hdiutil` for no visible benefit here.
- **Repo hygiene check (done during this design pass):** `.gitignore`
  correctly excludes build artifacts/DerivedData/xcuserdata/`.DS_Store`;
  no secrets found in a scan of the full commit history. Two real gaps
  found and included in this work: no `README.md`, no `LICENSE`. User
  chose **MIT** for the license.

## Components

### 1. `LICENSE` (MIT) — Web-Capture repo

Standard MIT license text, copyright holder Mark Pearce, current year.

### 2. `README.md` — Web-Capture repo

Covers: what the app does (one paragraph, matching the existing project
description — Safari full-page screenshot + annotation suite), install via
Homebrew (`brew install markrpearce96/tap/web-capture`), a caveat that it's
unsigned/personal-use (Gatekeeper right-click-Open + Safari "Allow Unsigned
Extensions" required), and brief build-from-source instructions for anyone
who wants to build it in Xcode directly instead.

### 3. `.github/workflows/release.yml` — Web-Capture repo

Triggered on push of a tag matching `v*.*.*`. Steps:

1. Checkout.
2. `xcodebuild -project "xcode/Web Capture/Web Capture.xcodeproj" -scheme "Web Capture" -configuration Release CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES -derivedDataPath build build` — ad-hoc signed, no secrets needed.
3. Locate `Web Capture.app` under `build/Build/Products/Release/`.
4. `ditto -c -k --keepParent "Web Capture.app" WebCapture.zip` (produces a
   zip that unpacks back into a correct, Gatekeeper-inspectable `.app`
   bundle — `ditto` preserves resource forks/attributes that plain `zip`
   can mangle).
5. `shasum -a 256 WebCapture.zip` — captured and surfaced in the workflow
   run summary/output so it's easy to copy into the Cask formula.
6. `gh release create "$TAG" WebCapture.zip --title "$TAG" --generate-notes`
   using the default `GITHUB_TOKEN` (same repo, no cross-repo permissions
   needed).

### 4. Version bump — Web-Capture repo

`MARKETING_VERSION` in the Xcode project is set to match each release tag
before tagging (starting at `1.0.0`, matching the current, never-yet-shipped
marketing version). This is a manual edit + commit before running
`git tag v1.0.0`.

### 5. New repo: `MarkrPearce96/homebrew-tap`

A small new public repo containing `Casks/web-capture.rb`:

```ruby
cask "web-capture" do
  version "1.0.0"
  sha256 "<from the release workflow output>"

  url "https://github.com/MarkrPearce96/Web-Capture/releases/download/v#{version}/WebCapture.zip"
  name "Web Capture"
  desc "Safari full-page screenshot and annotation extension"
  homepage "https://github.com/MarkrPearce96/Web-Capture"

  depends_on macos: ">= :sonoma"
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

(`depends_on macos:` version symbol will be double-checked against
Homebrew's current symbol list at implementation time — the project's
actual `MACOSX_DEPLOYMENT_TARGET` is a very recent macOS release.)

Bumping `version`/`sha256` in this file after each Web-Capture release is a
manual edit + push for now. Auto-syncing it from the release workflow would
need a cross-repo personal-access-token secret for something that happens a
few times a year at most — not worth the added complexity/attack surface
until it's actually annoying (YAGNI).

### Install/upgrade UX (end state)

```
brew tap markrpearce96/tap
brew install --cask web-capture
# later:
brew upgrade --cask web-capture
```

## Testing / verification

1. Push `v1.0.0` tag, confirm the Actions workflow succeeds and produces a
   release with `WebCapture.zip` attached.
2. Create the tap repo, add the Cask with the real sha256, confirm
   `brew audit --cask web-capture` (or `brew style`) passes basic Cask
   lint rules.
3. On the user's Mac: `brew tap` + `brew install --cask web-capture`,
   confirm the app installs to `/Applications`.
4. Confirm the ad-hoc-signed, CI-built app can actually be enabled in
   Safari the same way the user's local free-team builds can (this is the
   one real open unknown from earlier discussion — ad-hoc signing has no
   App-Group/keychain entitlements to worry about, but Safari's extension
   validation hasn't been tested against a CI-built ad-hoc binary yet).
   If Safari rejects it, fall back to exporting the user's free-team
   certificate as a CI secret instead of ad-hoc signing.
