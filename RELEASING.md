# Releasing a new version

Two repos are involved: this one (`Web-Capture`, builds and publishes the
release) and `~/Developer/homebrew-tap` (holds the Homebrew Cask that
points at it). Both need updating for a release to actually reach users.

## Steps

1. **Bump the version.** Open `xcode/Web Capture/Web Capture.xcodeproj/project.pbxproj`
   and replace every `MARKETING_VERSION = <old>;` (4 occurrences) with the
   new version.
   ```bash
   grep -c "MARKETING_VERSION = <new>;" "xcode/Web Capture/Web Capture.xcodeproj/project.pbxproj"  # should be 4 after
   ```

2. **Commit and push to `main`:**
   ```bash
   git add "xcode/Web Capture/Web Capture.xcodeproj/project.pbxproj"
   git commit -m "chore: bump MARKETING_VERSION to X.Y.Z"
   git push origin main
   ```

3. **Tag and push.** The tag must exactly match the version — CI checks
   this and fails the build if it doesn't:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

4. **Watch the release workflow:**
   ```bash
   gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
   ```
   It imports the signing certificate, builds (signed with a personal Apple
   Development certificate — see "Signing" below), verifies the built
   version matches the tag, verifies the signature chains to a real Apple
   certificate and entitlements (sandboxed, no debug entitlement), verifies
   the zip's structure, and publishes a GitHub Release with `WebCapture.zip`
   attached. If it fails, read `gh run view --log-failed`, fix the
   problem, then see "If something goes wrong" below before re-tagging.

5. **Get the sha256** — either from the release notes (the workflow
   writes it there) or:
   ```bash
   curl -sL -o /tmp/WebCapture.zip "https://github.com/MarkrPearce96/Web-Capture/releases/download/vX.Y.Z/WebCapture.zip"
   shasum -a 256 /tmp/WebCapture.zip
   ```

6. **Update the Cask in the tap repo** (`~/Developer/homebrew-tap`, a
   separate repo — this step is easy to forget):
   ```bash
   cd ~/Developer/homebrew-tap
   # edit Casks/web-capture.rb: version "X.Y.Z", sha256 "<from step 5>"
   ruby -c Casks/web-capture.rb && brew style Casks/web-capture.rb
   git add Casks/web-capture.rb
   git commit -m "fix: bump web-capture to X.Y.Z"
   git push origin main
   ```

7. **Verify end to end:**
   ```bash
   git -C "$(brew --repository markrpearce96/tap)" pull
   brew upgrade --cask web-capture   # or brew install --cask web-capture if not yet installed
   ```

## If something goes wrong mid-release

If a tag's CI run fails *before* publishing a release, fix the problem,
then delete and re-push the tag:
```bash
git push origin :refs/tags/vX.Y.Z
git tag -d vX.Y.Z
git tag vX.Y.Z
git push origin vX.Y.Z
```

If a release *was* already published and needs redoing, delete it first:
```bash
gh release delete vX.Y.Z --yes
```

Never silently re-push over an existing tag or release — always delete
deliberately first, so it's a decision, not an accident.

## What CI checks for you automatically

- The signature chains to a real Apple certificate authority (Apple Root CA)
  — ad-hoc and self-signed both fail this, and Safari silently refuses to
  list an extension signed either way, with no error shown anywhere.
- The built app's `CFBundleShortVersionString` matches the git tag.
- The build carries exactly the right sandbox entitlements and no debug
  (`get-task-allow`) entitlement.
- The release zip's top-level entry is exactly `Web Capture.app`.

These aren't hypothetical — each one caught a real mistake while this
pipeline was being built (see the `v1.0.0` → `v1.0.3` git history), including
the signing-chain check, which was added after v1.0.2 turned out to not
register in Safari at all despite building and signing "successfully."

## Signing

Ad-hoc signing (`CODE_SIGN_IDENTITY=-`) used to be enough, but Safari on
current macOS refuses to list an ad-hoc or self-signed extension in
Settings → Extensions at all — no error dialog, it just never appears, even
with "Allow Unsigned Extensions" on. The fix is a real Apple-issued
certificate, and the free tier works fine:

- **Locally**: sign in to Xcode with your Apple ID (Xcode → Settings →
  Accounts), then create an "Apple Development" certificate there (Manage
  Certificates → **+**). `xcodebuild` then signs with it automatically.
- **In CI**: the workflow imports that same certificate from two repository
  secrets, `APPLE_CERT_P12_BASE64` (the certificate + private key, exported
  with `security export -k <keychain> -t identities -f pkcs12 -P <password> -o cert.p12`,
  then base64-encoded) and `APPLE_CERT_PASSWORD` (the export password), into a
  throwaway keychain before building.
- The certificate expires after about a year — if a release build ever fails
  signing, export a fresh one from Xcode and update the two secrets.
- This only fixes Safari's extension registration; the app is still not
  notarized, so Gatekeeper's first-launch warning is unchanged.

## One-time setup (already done, listed for reference only)

`gh repo create MarkrPearce96/homebrew-tap`, `brew trust markrpearce96/tap`
on any Mac installing it for the first time, the GitHub Actions workflow
itself (`.github/workflows/release.yml`), and the `APPLE_CERT_P12_BASE64` /
`APPLE_CERT_PASSWORD` repository secrets (see "Signing" above) — none of
this needs repeating for a normal release.
