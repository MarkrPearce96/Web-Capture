"use strict";

const BADGE_CLEAR_MS = 2500;

// Tabs with a capture currently in flight. Guards against a second
// popup click mid-capture, which would send a second "measure" and wipe
// state.hidden / corrupt the scroll-position record in content.js.
const inFlightTabs = new Set();

// The popup (see popup.js) sends "captureRequest" for all three modes; the
// content script sends "regionSelected" once the user finishes dragging a
// region (see content.js's "selectRegion" handler). The latter isn't guarded
// by handleCaptureRequest's in-flight tracking since it fires later, on its
// own message — so it needs its own inFlightTabs guard.
browser.runtime.onMessage.addListener((message, sender) => {
  if (!message) {
    return; // not ours; let other listeners (if any) handle it
  }
  if (message.type === "regionSelected" && sender.tab) {
    return handleRegionSelected(message, sender.tab);
  }
  if (message.type === "captureRequest") {
    return handleCaptureRequest(message.mode);
  }
  if (message.type === "ocrRequest") {
    return handleOcrRequest(message);
  }
});

// Relays a Highlighter-tool OCR request (see annotate.js's scanText) to the
// native app via Safari's native-messaging bridge (see
// SafariWebExtensionHandler.swift's "ocr" branch, which runs Apple Vision
// off the main thread and replies with { ok, words, imageWidth,
// imageHeight }). Any failure to reach the native side (host not installed,
// crashed, etc.) is normalized into the same { ok: false, error } shape the
// native side itself returns on decode/recognition failure, so annotate.js
// only ever has one failure shape to branch on.
async function handleOcrRequest(message) {
  try {
    var resp = await browser.runtime.sendNativeMessage("com.markpearce.WebCapture", {
      type: "ocr",
      image: message.image,
    });
    return resp;
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

async function handleCaptureRequest(mode) {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || inFlightTabs.has(tab.id)) {
    return; // no active tab, or a capture is already running for this tab
  }
  inFlightTabs.add(tab.id);
  try {
    if (mode === "full") {
      await captureFullPage(tab);
    } else if (mode === "visible") {
      await captureVisibleArea(tab);
    } else if (mode === "region") {
      await startRegionSelect(tab);
    }
  } catch (err) {
    console.error("Web Capture failed:", err);
    await showErrorBadge(tab.id, err);
  } finally {
    inFlightTabs.delete(tab.id);
  }
}

async function handleRegionSelected(message, tab) {
  if (inFlightTabs.has(tab.id)) {
    return;
  }
  inFlightTabs.add(tab.id);
  try {
    const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    await sendToTab(tab.id, { type: "previewImage", dataUrl, rect: message.rect });
  } catch (err) {
    console.error("Web Capture failed:", err);
    await showErrorBadge(tab.id, err);
  } finally {
    inFlightTabs.delete(tab.id);
  }
}

async function injectScripts(tabId) {
  // Throws on restricted pages (Safari settings, App Store, PDFs…),
  // which lands in the error-badge path in each caller.
  await browser.scripting.executeScript({
    target: { tabId },
    files: ["shared.js", "pdf.js", "annotate.js", "content.js"],
  });
}

async function captureVisibleArea(tab) {
  // Capture BEFORE injecting anything, so nothing we inject (progress pill,
  // overlay, etc.) can ever appear in this single instant frame.
  const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  await injectScripts(tab.id);
  await sendToTab(tab.id, { type: "previewImage", dataUrl });
}

async function startRegionSelect(tab) {
  await injectScripts(tab.id);
  // The content script acknowledges immediately and runs the selection UI
  // on its own; it sends a separate "regionSelected" message (handled above)
  // once the user finishes dragging.
  await sendToTab(tab.id, { type: "selectRegion" });
}

async function captureFullPage(tab) {
  await injectScripts(tab.id);

  try {
    const metrics = await sendToTab(tab.id, { type: "measure" });
    const steps = computeScrollSteps(metrics.pageHeight, metrics.viewportHeight);

    for (let i = 0; i < steps.length; i++) {
      const { y } = await sendToTab(tab.id, {
        type: "scrollTo",
        y: steps[i],
        hideFixed: i > 0,
        progress: { current: i + 1, total: steps.length },
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

const DEFAULT_ACTION_TITLE = "Capture this page";

async function showErrorBadge(tabId, err) {
  try {
    // Plain ASCII "X" — a multibyte glyph (✕) gets mangled by Safari's badge
    // renderer into mojibake.
    await browser.action.setBadgeText({ text: "X", tabId });
    // Surface the real failure as the toolbar icon's tooltip so it can be
    // read by hovering; the normal title is restored when the badge clears.
    if (err !== undefined) {
      browser.action
        .setTitle({ tabId, title: "Web Capture error: " + String(err && err.message ? err.message : err) })
        .catch(() => {});
    }
    setTimeout(() => {
      browser.action.setBadgeText({ text: "", tabId }).catch(() => {});
      browser.action.setTitle({ tabId, title: DEFAULT_ACTION_TITLE }).catch(() => {});
    }, BADGE_CLEAR_MS);
  } catch {
    // Badge is best-effort; never let it throw over the real error.
  }
}

