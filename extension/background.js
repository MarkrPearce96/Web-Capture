"use strict";

const BADGE_CLEAR_MS = 2500;

browser.action.onClicked.addListener(async (tab) => {
  try {
    await captureFullPage(tab);
  } catch (err) {
    console.error("Web Capture failed:", err);
    await showErrorBadge(tab.id);
  }
});

async function captureFullPage(tab) {
  // Throws on restricted pages (Safari settings, App Store, PDFs…),
  // which lands in the error-badge path above.
  await browser.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["shared.js", "content.js"],
  });

  const metrics = await sendToTab(tab.id, { type: "measure" });
  const steps = computeScrollSteps(metrics.pageHeight, metrics.viewportHeight);

  try {
    for (let i = 0; i < steps.length; i++) {
      const { y } = await sendToTab(tab.id, {
        type: "scrollTo",
        y: steps[i],
        hideFixed: i > 0,
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
