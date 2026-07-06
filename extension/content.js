"use strict";

// Page-side capture engine. Injected on demand (after shared.js) by
// background.js. Guarded so repeated injections don't add extra listeners.
(() => {
  if (window.__webCaptureLoaded) {
    return;
  }
  window.__webCaptureLoaded = true;

  // Longer dwell gives scroll-linked animations (GSAP reveals, etc.) and
  // lazy-loaded content time to finish before each frame is captured,
  // replacing the former separate pre-scroll pass.
  const SETTLE_MS = 700;

  const state = {
    originalX: 0,
    originalY: 0,
    hidden: [], // [{ el, priorValue, priorPriority }]
    hiddenSeen: null,
    scrollbarStyle: null,
    canvas: null,
    ctx: null,
    dpr: 1,
    restored: true,
  };

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handle(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: String(err && err.message ? err.message : err) }));
    return true; // keep the channel open for the async response
  });

  async function handle(message) {
    switch (message.type) {
      case "measure":
        return measure();
      case "scrollTo":
        return scrollToStep(message);
      case "addFrame":
        return addFrame(message);
      case "finish":
        return finish(message);
      case "restore":
        return restore();
      default:
        throw new Error(`unknown message type: ${message.type}`);
    }
  }

  function pageHeight() {
    return Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
  }

  function measure() {
    if (!state.restored) {
      // Belt-and-braces: a stale, unrestored capture (e.g. from a click that
      // never reached "finish") must never leak hidden elements or a
      // corrupted scroll position into this new capture.
      restore();
    }
    state.originalX = window.scrollX;
    state.originalY = window.scrollY;
    state.hidden = [];
    state.hiddenSeen = new WeakSet();
    state.canvas = null;
    state.ctx = null;
    state.restored = false;
    if (!state.scrollbarStyle) {
      state.scrollbarStyle = document.createElement("style");
      state.scrollbarStyle.textContent = "*::-webkit-scrollbar { display: none !important; }";
      document.documentElement.appendChild(state.scrollbarStyle);
    }
    return {
      pageHeight: pageHeight(),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      host: location.hostname || "page",
    };
  }


  async function scrollToStep({ y, hideFixed }) {
    window.scrollTo(0, y);
    await settle(SETTLE_MS);
    if (hideFixed) {
      hideFixedElements();
      await settle(80);
    }
    return { y: Math.round(window.scrollY) };
  }

  // Fixed and sticky elements would repeat in every frame; hide them so they
  // appear once, at the top of the stitched image. Re-scans on every hiding
  // step (not just the first) because some headers (e.g. Google's search
  // bar) only gain `position: fixed` from a scroll listener once scrolling
  // starts, so they aren't fixed yet when the first step runs. `hiddenSeen`
  // makes this idempotent so an element already hidden isn't recorded twice.
  function hideFixedElements() {
    for (const el of document.querySelectorAll("body *")) {
      if (state.hiddenSeen.has(el)) {
        continue;
      }
      const position = getComputedStyle(el).position;
      if (position === "fixed" || position === "sticky") {
        state.hiddenSeen.add(el);
        state.hidden.push({
          el,
          priorValue: el.style.getPropertyValue("visibility"),
          priorPriority: el.style.getPropertyPriority("visibility"),
        });
        el.style.setProperty("visibility", "hidden", "important");
      }
    }
  }

  // Two animation frames flush layout/paint after scrolling; the timeout
  // gives lazy-loaded content a chance to appear.
  function settle(ms) {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setTimeout(resolve, ms));
      });
    });
  }

  async function addFrame({ dataUrl, y }) {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    if (!state.canvas) {
      // Derive the real capture scale from the frame itself rather than
      // trusting devicePixelRatio — Safari decides the capture resolution.
      state.dpr = img.naturalWidth / window.innerWidth;
      state.canvas = document.createElement("canvas");
      state.canvas.width = img.naturalWidth;
      state.canvas.height = cappedCanvasHeight(pageHeight(), state.dpr);
      state.ctx = state.canvas.getContext("2d");
    }
    state.ctx.drawImage(img, 0, Math.round(y * state.dpr));
    return { ok: true };
  }

  async function finish({ filename }) {
    const canvas = state.canvas;
    restore();
    if (!canvas) {
      throw new Error("no frames were captured");
    }
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("PNG export failed"))),
        "image/png"
      );
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { ok: true };
  }

  function restore() {
    if (state.restored) {
      return { ok: true };
    }
    state.restored = true;
    for (const { el, priorValue, priorPriority } of state.hidden) {
      if (priorValue) {
        el.style.setProperty("visibility", priorValue, priorPriority);
      } else {
        el.style.removeProperty("visibility");
      }
    }
    state.hidden = [];
    if (state.scrollbarStyle) {
      state.scrollbarStyle.remove();
      state.scrollbarStyle = null;
    }
    window.scrollTo(state.originalX, state.originalY);
    state.canvas = null;
    state.ctx = null;
    return { ok: true };
  }
})();
