"use strict";

const BADGE_CLEAR_MS = 2500;

// Tabs with a capture currently in flight. Guards against a second
// icon-click mid-capture, which would send a second "measure" and wipe
// state.hidden / corrupt the scroll-position record in content.js.
const inFlightTabs = new Set();

// Non-persistent background: this top-level code re-runs on every wake, so
// the menu items must be torn down first or re-registration throws on the
// duplicate id.
browser.contextMenus
  .removeAll()
  .then(() => {
    browser.contextMenus.create({
      id: "capture-visible",
      title: "Capture Visible Area",
      contexts: ["action", "page"],
    });
    browser.contextMenus.create({
      id: "capture-region",
      title: "Capture Selected Region",
      contexts: ["action", "page"],
    });
  })
  .catch((err) => console.error("Web Capture: menu setup failed:", err));

browser.action.onClicked.addListener(async (tab) => {
  if (inFlightTabs.has(tab.id)) {
    return; // a capture is already running for this tab; ignore the click
  }
  inFlightTabs.add(tab.id);
  try {
    await captureFullPage(tab);
  } catch (err) {
    console.error("Web Capture failed:", err);
    await showErrorBadge(tab.id);
  } finally {
    inFlightTabs.delete(tab.id);
  }
});

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || inFlightTabs.has(tab.id)) {
    return; // no tab context, or a capture is already running for this tab
  }
  inFlightTabs.add(tab.id);
  try {
    if (info.menuItemId === "capture-visible") {
      await captureVisibleArea(tab);
    } else if (info.menuItemId === "capture-region") {
      await startRegionSelect(tab);
    }
  } catch (err) {
    console.error("Web Capture failed:", err);
    await showErrorBadge(tab.id);
  } finally {
    inFlightTabs.delete(tab.id);
  }
});

// The content script sends this once the user finishes dragging a region
// (see content.js's "selectRegion" handler). Not guarded by the
// contextMenus.onClicked in-flight tracking above since it fires later, on
// its own message — so it needs its own inFlightTabs guard.
browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== "regionSelected" || !sender.tab) {
    return; // not ours; let other listeners (if any) handle it
  }
  return handleRegionSelected(message, sender.tab);
});

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
    await showErrorBadge(tab.id);
  } finally {
    inFlightTabs.delete(tab.id);
  }
}

async function injectScripts(tabId) {
  // Throws on restricted pages (Safari settings, App Store, PDFs…),
  // which lands in the error-badge path in each caller.
  await browser.scripting.executeScript({
    target: { tabId },
    files: ["shared.js", "pdf.js", "content.js"],
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

