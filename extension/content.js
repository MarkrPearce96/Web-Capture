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
    overlay: null, // { host, url, onKeydown } while the preview overlay is open
    progressPill: null, // { host, bar, label } while a capture is in progress
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
    // Must run first: a lingering overlay from a previous capture is
    // position: fixed and would otherwise be visible in every frame of the
    // new capture if it were still around when dimensions are measured.
    closeOverlay();
    removeProgressPill();
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


  async function scrollToStep({ y, hideFixed, progress }) {
    if (progress) {
      updateProgressPill(progress.current, progress.total);
    }
    window.scrollTo(0, y);
    await settle(SETTLE_MS);
    if (hideFixed) {
      hideFixedElements();
      await settle(80);
    }
    const result = { y: Math.round(window.scrollY) };
    hideProgressPill();
    return result;
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
    showOverlay(blob, filename);
    return { ok: true };
  }

  // Saves `blob` to the Downloads folder via an invisible <a download> anchor
  // click on a blob URL — Safari has no `browser.downloads` API. Used only by
  // the overlay's Download button.
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // Builds and shows the in-page preview overlay for a finished capture. The
  // only call site is `finish()`.
  function showOverlay(blob, filename) {
    const url = URL.createObjectURL(blob);

    const host = document.createElement("div");
    host.style.position = "fixed";
    host.style.inset = "0";
    host.style.zIndex = "2147483647";

    // Open shadow root so page CSS can never leak in (or out).
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      .backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
      }
      .panel {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 90vw;
        max-width: 720px;
        max-height: 85vh;
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .image-area {
        overflow: auto;
        flex: 1;
      }
      .image-area img {
        width: 100%;
        display: block;
      }
      .button-row {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 12px 16px;
        border-top: 1px solid #e2e2e2;
        flex: none;
      }
      button {
        font: inherit;
        font-size: 14px;
        border: none;
        border-radius: 6px;
        padding: 8px 16px;
        cursor: pointer;
      }
      .primary {
        background: #2273f2;
        color: #fff;
      }
      .secondary {
        background: #e5e5e5;
        color: #222;
      }
      .close {
        position: absolute;
        top: 12px;
        right: 12px;
        width: 28px;
        height: 28px;
        padding: 0;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.08);
        color: #333;
        font-size: 15px;
        line-height: 1;
        display: flex;
        align-items: center;
        justify-content: center;
      }
    `;

    const backdrop = document.createElement("div");
    backdrop.className = "backdrop";
    backdrop.addEventListener("click", closeOverlay);

    const panel = document.createElement("div");
    panel.className = "panel";

    const imageArea = document.createElement("div");
    imageArea.className = "image-area";
    const img = document.createElement("img");
    img.src = url;
    imageArea.appendChild(img);

    const buttonRow = document.createElement("div");
    buttonRow.className = "button-row";

    const downloadBtn = document.createElement("button");
    downloadBtn.className = "primary";
    downloadBtn.textContent = "Download";
    downloadBtn.addEventListener("click", () => {
      downloadBlob(blob, filename);
      downloadBtn.textContent = "Saved ✓";
      const mine = state.overlay;
      setTimeout(() => {
        if (state.overlay === mine) {
          closeOverlay();
        }
      }, 600);
    });

    const copyBtn = document.createElement("button");
    copyBtn.className = "secondary";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", async () => {
      try {
        // Must run synchronously inside the click handler to count as a user
        // gesture for the Clipboard API.
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        copyBtn.textContent = "Copied ✓";
        const mine = state.overlay;
        setTimeout(() => {
          if (state.overlay === mine) {
            closeOverlay();
          }
        }, 600);
      } catch (err) {
        copyBtn.textContent = "Copy failed";
        console.error("Web Capture: copy to clipboard failed", err);
      }
    });

    const closeBtn = document.createElement("button");
    closeBtn.className = "close";
    closeBtn.textContent = "✕";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", closeOverlay);

    buttonRow.append(downloadBtn, copyBtn);
    panel.append(imageArea, buttonRow, closeBtn);
    shadow.append(style, backdrop, panel);
    document.documentElement.appendChild(host);

    const onKeydown = (event) => {
      if (event.key === "Escape") {
        closeOverlay();
      }
    };
    window.addEventListener("keydown", onKeydown, true);

    state.overlay = { host, url, onKeydown };
  }

  // Idempotent: a no-op when no overlay is open, so every close path (✕,
  // backdrop click, Escape, post-Download, post-Copy, and the next
  // measure()) can call it unconditionally.
  function closeOverlay() {
    if (!state.overlay) {
      return;
    }
    const { host, url, onKeydown } = state.overlay;
    window.removeEventListener("keydown", onKeydown, true);
    URL.revokeObjectURL(url);
    host.remove();
    state.overlay = null;
  }

  // Creates (on first call) or updates the bottom-center progress pill shown
  // while a capture is running. Must be hidden (not just left alone) before
  // each `captureVisibleTab` call — see `hideProgressPill()` — so it never
  // appears in a captured frame.
  function updateProgressPill(current, total) {
    const pct = Math.round((current / total) * 100);
    if (!state.progressPill) {
      const host = document.createElement("div");
      host.style.position = "fixed";
      host.style.left = "50%";
      host.style.transform = "translateX(-50%)";
      host.style.bottom = "24px";
      host.style.zIndex = "2147483647";

      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `
        .pill {
          display: flex;
          align-items: center;
          gap: 10px;
          width: 240px;
          box-sizing: border-box;
          padding: 10px 16px;
          background: rgba(20, 20, 20, 0.85);
          border-radius: 999px;
          font: 12px -apple-system, BlinkMacSystemFont, sans-serif;
          color: #fff;
        }
        .track {
          flex: 1;
          width: 160px;
          height: 6px;
          background: rgba(255, 255, 255, 0.25);
          border-radius: 999px;
          overflow: hidden;
        }
        .fill {
          height: 100%;
          width: 0%;
          background: #fff;
          border-radius: 999px;
          transition: width 0.2s;
        }
        .label {
          flex: none;
          white-space: nowrap;
        }
      `;

      const pill = document.createElement("div");
      pill.className = "pill";
      const track = document.createElement("div");
      track.className = "track";
      const bar = document.createElement("div");
      bar.className = "fill";
      track.appendChild(bar);
      const label = document.createElement("span");
      label.className = "label";
      pill.append(track, label);
      shadow.append(style, pill);
      document.documentElement.appendChild(host);

      state.progressPill = { host, bar, label };
    }
    const { host, bar, label } = state.progressPill;
    bar.style.width = `${pct}%`;
    label.textContent = formatProgress(current, total);
    host.style.visibility = "visible";
  }

  // Hides (does not remove) the pill so it's gone at the instant
  // `captureVisibleTab` fires; `updateProgressPill` makes it visible again at
  // the next step.
  function hideProgressPill() {
    if (state.progressPill) {
      state.progressPill.host.style.visibility = "hidden";
    }
  }

  // Idempotent: tears the pill down entirely once a capture finishes or
  // aborts, so a stale pill never leaks into a later capture.
  function removeProgressPill() {
    if (!state.progressPill) {
      return;
    }
    state.progressPill.host.remove();
    state.progressPill = null;
  }

  function restore() {
    if (state.restored) {
      return { ok: true };
    }
    state.restored = true;
    removeProgressPill();
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
