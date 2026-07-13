"use strict";

// Page-side capture engine. Injected on demand (after shared.js) by
// background.js. Guarded so repeated injections don't add extra listeners.
(() => {
  // Wraps the persistent message handler in an onMessage listener.
  function makeCaptureListener(handleFn) {
    return function (message, _sender, sendResponse) {
      handleFn(message)
        .then(sendResponse)
        .catch((err) => sendResponse({ error: String(err && err.message ? err.message : err) }));
      return true; // keep the channel open for the async response
    };
  }

  // This script is re-injected on every capture. On any injection after the
  // first, swap in a FRESH listener bound to the existing handler, then stop.
  // Safari tears down and revives the non-persistent background after the
  // extension idles; that revival orphans the previously-registered listener
  // so its responses no longer route back (measure() then resolves to
  // undefined and the capture fails). Re-registering restores the channel
  // while preserving the persistent page state (overlay, in-flight capture).
  if (window.__webCapture) {
    browser.runtime.onMessage.removeListener(window.__webCapture.listener);
    var relisten = makeCaptureListener(window.__webCapture.handle);
    window.__webCapture.listener = relisten;
    browser.runtime.onMessage.addListener(relisten);
    return;
  }

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
    regionSelect: null, // { host, onKeydown } while the region-select UI is open
  };

  // First initialization: register the listener and remember it (plus the
  // handler) on window so later re-injections can re-register (see top).
  const listener = makeCaptureListener(handle);
  browser.runtime.onMessage.addListener(listener);
  window.__webCapture = { listener: listener, handle: handle };

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
      case "previewImage":
        return previewImage(message);
      case "selectRegion":
        return selectRegion();
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
    removeRegionSelect();
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
    const blob = await canvasToBlob(canvas, "image/png");
    showOverlay(canvas, blob, filename);
    return { ok: true };
  }

  // Wraps canvas.toBlob in a promise, rejecting when the browser can't
  // produce a blob (e.g. a tainted or zero-size canvas). Shared by `finish`
  // and `previewImage` — the two PNG-export call sites — so the pattern
  // isn't duplicated between them.
  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error(`canvas export to ${type} failed`))),
        type,
        quality
      );
    });
  }

  // Builds the cropped or full-page preview canvas for the visible-area and
  // region-capture flows (background.js's `captureVisibleArea` /
  // `handleRegionSelected`). `dataUrl` is a single `captureVisibleTab` PNG;
  // `rect` (viewport CSS px) is present only for the region-select flow.
  async function previewImage({ dataUrl, rect }) {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    // Derive the real capture scale from the frame itself rather than
    // trusting devicePixelRatio — Safari decides the capture resolution.
    const scale = img.naturalWidth / window.innerWidth;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    if (rect) {
      const sx = Math.round(Math.max(0, rect.x * scale));
      const sy = Math.round(Math.max(0, rect.y * scale));
      const sw = Math.round(Math.min(rect.w * scale, img.naturalWidth - sx));
      const sh = Math.round(Math.min(rect.h * scale, img.naturalHeight - sy));
      if (sw < 1 || sh < 1) {
        throw new Error("selected region is empty after clamping to the captured frame");
      }
      canvas.width = sw;
      canvas.height = sh;
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    } else {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
    }

    const blob = await canvasToBlob(canvas, "image/png");
    closeOverlay();
    showOverlay(canvas, blob, buildFilename(location.hostname || "page", new Date()));
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
  // only call site is `finish()`. `canvas` is the full-resolution stitched
  // capture (kept around for JPEG re-encoding, PDF paging, and as the base
  // layer for baking in annotations); `blob` is always the PNG export, used
  // for the preview `<img>` and (when there are no annotations) the Copy
  // button. Async because it waits for the preview image to finish loading
  // (needed for the annotator's coordinate math) before wiring up markup
  // tools; not awaited by its callers (fire-and-forget), matching the rest
  // of this file's message-handler contracts.
  async function showOverlay(canvas, blob, filename) {
    const url = URL.createObjectURL(blob);
    let annotator = null;

    // Returns the canvas to export from: the plain capture when there are no
    // annotations, or a freshly-composited canvas (capture + annotations
    // baked in at full resolution) otherwise. Used by every export path
    // (PNG/JPEG/PDF download and Copy) so annotations always end up in the
    // saved/copied output.
    function exportCanvas() {
      return annotator && annotator.hasAnnotations() ? annotator.renderComposite() : canvas;
    }

    async function exportPngBlob() {
      return annotator && annotator.hasAnnotations()
        ? canvasToBlob(exportCanvas(), "image/png")
        : blob;
    }

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
        max-width: 900px;
        max-height: 88vh;
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
        overscroll-behavior: contain;
      }
      .image-wrapper {
        position: relative;
      }
      .image-area img {
        width: 100%;
        display: block;
      }
      .field {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .field-label {
        color: #666;
        font-size: 12px;
      }
      .button-row select {
        font: inherit;
        font-size: 13px;
        padding: 4px 6px;
        border-radius: 6px;
        border: 1px solid #d0d0d0;
        background: #fff;
        color: #222;
      }
      .quality-group input[type="range"] {
        width: 100px;
      }
      .quality-value {
        color: #666;
        min-width: 32px;
        text-align: right;
      }
      .button-row {
        display: flex;
        align-items: center;
        gap: 18px;
        padding: 12px 16px;
        border-top: 1px solid #e2e2e2;
        flex: none;
        flex-wrap: wrap;
      }
      .button-row .format-controls {
        display: flex;
        align-items: center;
        gap: 18px;
      }
      .button-row .button-group {
        display: flex;
        gap: 8px;
        margin-left: auto;
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
        min-width: 28px;
        min-height: 28px;
        padding: 0;
        border-radius: 50%;
        border: 1.5px solid rgba(255, 255, 255, 0.9);
        background: rgba(0, 0, 0, 0.55);
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
        color: #fff;
        font-size: 15px;
        line-height: 1;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .close:hover {
        background: rgba(0, 0, 0, 0.75);
      }
    `;

    const backdrop = document.createElement("div");
    backdrop.className = "backdrop";
    backdrop.addEventListener("click", closeOverlay);

    const panel = document.createElement("div");
    panel.className = "panel";

    const imageArea = document.createElement("div");
    imageArea.className = "image-area";
    const wrapper = document.createElement("div");
    wrapper.className = "image-wrapper";
    const img = document.createElement("img");
    img.src = url;
    wrapper.appendChild(img);
    imageArea.appendChild(wrapper);

    const formatField = document.createElement("div");
    formatField.className = "field";
    const formatLabel = document.createElement("span");
    formatLabel.className = "field-label";
    formatLabel.textContent = "Format";
    const formatSelect = document.createElement("select");
    [
      { value: "png", label: "PNG" },
      { value: "jpeg", label: "JPEG" },
      { value: "pdf", label: "PDF" },
    ].forEach(({ value, label }) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      formatSelect.appendChild(option);
    });
    formatField.append(formatLabel, formatSelect);

    const qualityGroup = document.createElement("div");
    qualityGroup.className = "field quality-group";
    qualityGroup.style.display = "none";
    const qualityLabel = document.createElement("span");
    qualityLabel.className = "field-label";
    qualityLabel.textContent = "Quality";
    const qualityInput = document.createElement("input");
    qualityInput.type = "range";
    qualityInput.min = "50";
    qualityInput.max = "100";
    qualityInput.step = "5";
    qualityInput.value = "85";
    const qualityValue = document.createElement("span");
    qualityValue.className = "quality-value";
    qualityValue.textContent = "85%";
    qualityInput.addEventListener("input", () => {
      qualityValue.textContent = `${qualityInput.value}%`;
    });
    qualityGroup.append(qualityLabel, qualityInput, qualityValue);

    formatSelect.addEventListener("change", () => {
      qualityGroup.style.display = formatSelect.value === "jpeg" ? "flex" : "none";
    });

    const formatControls = document.createElement("div");
    formatControls.className = "format-controls";
    formatControls.append(formatField, qualityGroup);

    const buttonRow = document.createElement("div");
    buttonRow.className = "button-row";

    const downloadBtn = document.createElement("button");
    downloadBtn.className = "primary";
    downloadBtn.textContent = "Download";
    downloadBtn.addEventListener("click", async () => {
      const format = formatSelect.value;

      if (format === "png") {
        downloadBlob(await exportPngBlob(), filename);
        downloadBtn.textContent = "Saved ✓";
        const mine = state.overlay;
        setTimeout(() => {
          if (state.overlay === mine) {
            closeOverlay();
          }
        }, 600);
        return;
      }

      downloadBtn.disabled = true;
      downloadBtn.textContent = "Exporting…";
      try {
        if (format === "jpeg") {
          const quality = Number(qualityInput.value) / 100;
          const jpegBlob = await new Promise((resolve, reject) => {
            exportCanvas().toBlob(
              (b) => (b ? resolve(b) : reject(new Error("JPEG export failed"))),
              "image/jpeg",
              quality
            );
          });
          downloadBlob(jpegBlob, filename.replace(/\.png$/i, ".jpg"));
        } else if (format === "pdf") {
          // Slice the full-resolution (annotations-baked-in, if any) canvas
          // into A4-portrait-aspect chunks so each page of the PDF is a 1:1
          // crop (no re-scaling) of the stitched capture.
          const pdfSource = exportCanvas();
          const sliceHeight = Math.round(pdfSource.width * (841.89 / 595.28));
          const pages = [];
          for (let top = 0; top < pdfSource.height; top += sliceHeight) {
            const w = pdfSource.width;
            const h = Math.min(sliceHeight, pdfSource.height - top);
            const chunk = document.createElement("canvas");
            chunk.width = w;
            chunk.height = h;
            chunk.getContext("2d").drawImage(pdfSource, 0, top, w, h, 0, 0, w, h);
            const chunkBlob = await new Promise((resolve, reject) => {
              chunk.toBlob(
                (b) => (b ? resolve(b) : reject(new Error("PDF page export failed"))),
                "image/jpeg",
                0.85
              );
            });
            pages.push({ jpeg: new Uint8Array(await chunkBlob.arrayBuffer()), width: w, height: h });
          }
          const pdfBytes = buildPdf(pages);
          const pdfBlob = new Blob([pdfBytes], { type: "application/pdf" });
          downloadBlob(pdfBlob, filename.replace(/\.png$/i, ".pdf"));
        }
        downloadBtn.textContent = "Saved ✓";
        const mine = state.overlay;
        setTimeout(() => {
          if (state.overlay === mine) {
            closeOverlay();
          }
        }, 600);
      } catch (err) {
        downloadBtn.textContent = "Export failed";
        downloadBtn.disabled = false;
        console.error("Web Capture: export failed", err);
      }
    });

    const copyBtn = document.createElement("button");
    copyBtn.className = "secondary";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", async () => {
      try {
        // Must run synchronously inside the click handler to count as a user
        // gesture for the Clipboard API. Safari accepts a promise as a
        // ClipboardItem value, so pass exportPngBlob()'s promise straight
        // through (no await before this call) rather than resolving it
        // first — awaiting first would push the actual write() call past
        // the gesture and Safari would reject it.
        await navigator.clipboard.write([new ClipboardItem({ "image/png": exportPngBlob() })]);
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

    const buttonGroup = document.createElement("div");
    buttonGroup.className = "button-group";
    buttonGroup.append(downloadBtn, copyBtn);

    buttonRow.append(formatControls, buttonGroup);
    panel.append(imageArea, buttonRow, closeBtn);
    shadow.append(style, backdrop, panel);
    document.documentElement.appendChild(host);

    // Lock page scroll while the overlay is open — reaching the end of the
    // preview's own scrollable image area must not chain into scrolling the
    // page behind it. Saved as plain inline-style strings (not a
    // before/after diff) so closeOverlay can restore exactly what was there,
    // including "no inline value at all" (removeProperty).
    const priorHtmlOverflow = document.documentElement.style.getPropertyValue("overflow");
    const priorBodyOverflow = document.body
      ? document.body.style.getPropertyValue("overflow")
      : null;
    document.documentElement.style.overflow = "hidden";
    if (document.body) {
      document.body.style.overflow = "hidden";
    }

    const onKeydown = (event) => {
      // `state.overlay`/`.annotator` are null-safe here since this listener
      // can fire before the annotator (created async, after the preview image
      // decodes) exists yet.
      const annotator = state.overlay && state.overlay.annotator;
      const editingText = annotator && annotator.isEditingText && annotator.isEditingText();
      if (event.key === "Escape") {
        // A text annotation's inline editor handles its own Escape (commit
        // + close, see annotate.js) — let it, rather than closing the whole
        // preview out from under it.
        if (editingText) {
          return;
        }
        closeOverlay();
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        // Delete the selected annotation — but not while typing in a text box
        // (there Backspace edits the text), and only if something is selected
        // (else let the key do its normal thing, e.g. browser navigation).
        if (editingText || !annotator || !annotator.deleteSelected) {
          return;
        }
        if (annotator.deleteSelected()) {
          event.preventDefault();
        }
      }
    };
    window.addEventListener("keydown", onKeydown, true);

    const overlayRecord = {
      host,
      url,
      onKeydown,
      annotator: null,
      priorHtmlOverflow,
      priorBodyOverflow,
    };
    state.overlay = overlayRecord;

    // Wait until the preview image has actually loaded — createAnnotator
    // needs img.clientWidth/naturalWidth for its coordinate math, and the
    // host is already in the DOM (appended just above) so layout is
    // available once decode resolves. Guarded against a race where the
    // overlay is closed (or replaced by a newer capture) while this decode
    // is still pending.
    await img.decode();
    if (state.overlay !== overlayRecord) {
      return;
    }
    annotator = createAnnotator({ img, sourceCanvas: canvas, wrapper, shadowRoot: shadow });
    panel.insertBefore(annotator.toolbar, buttonRow);
    overlayRecord.annotator = annotator;

    // Freeze the panel's natural height so zooming (which grows the image
    // wrapper) can only scroll inside the image area, never reshape the panel.
    if (state.overlay === overlayRecord) {
      panel.style.height = Math.ceil(panel.getBoundingClientRect().height) + "px";
    }

    function onWindowResize() {
      applyZoomWidth();
      annotator.refresh();
    }
    window.addEventListener("resize", onWindowResize);
    overlayRecord.onResize = onWindowResize;

    // ---- pinch-to-zoom (trackpad pinch via Safari's non-standard gesture
    // events, or ctrl+wheel as the emulated equivalent) ----------------
    // Zoom factor 1 (fit width, current look) to 6, applied to the img's
    // width (see setZoom below for why wrapper is sized to match
    // explicitly rather than left to auto-fill imageArea); the annotator's
    // `inset: 0` layer then follows the wrapper automatically, but its
    // canvas backing store has to be re-synced (via refresh()) after every
    // change since it isn't observing layout on its own. These listeners
    // live entirely on overlay-internal elements (inside `host`), so —
    // unlike the window keydown listener above — nothing needs to
    // explicitly remove them at close: they die with the rest of the
    // subtree when `host.remove()` runs.
    let zoom = 1;

    function applyZoomWidth() {
      if (zoom === 1) {
        img.style.removeProperty("width");
        wrapper.style.removeProperty("width");
      } else {
        var targetWidth = imageArea.clientWidth * zoom;
        img.style.width = targetWidth + "px";
        wrapper.style.width = targetWidth + "px";
      }
    }

    function setZoom(next, clientX, clientY) {
      next = Math.min(6, Math.max(1, next));
      if (Math.abs(next - zoom) < 0.001) {
        return;
      }
      const rect = imageArea.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const ratio = next / zoom;
      const newScrollLeft = (imageArea.scrollLeft + px) * ratio - px;
      const newScrollTop = (imageArea.scrollTop + py) * ratio - py;
      zoom = next;
      // img.style.width is conceptually "(zoom * 100) + '%'" of the fit
      // width (the base CSS rule stays `width: 100%` for the never-zoomed
      // case) — expressed here in px, computed from imageArea's own width
      // (stable, unaffected by the img/wrapper), rather than as a live
      // percentage of `wrapper`. A percentage of `wrapper` would be
      // self-referential once `wrapper` is also resized to match: wrapper's
      // width would feed back into img's resolved width (which feeds back
      // into wrapper's target width next time), compounding every call.
      // `wrapper` is sized to match explicitly (not left to auto-fill)
      // because its normal-flow "auto" width always fills imageArea and
      // ignores an overflowing child's actual size — only its *height*
      // auto-grows with in-flow content — so without this, the annotation
      // layer (annot-layer is `inset: 0` of wrapper) would stay clipped to
      // the un-zoomed width instead of covering the zoomed image.
      applyZoomWidth();
      imageArea.scrollLeft = newScrollLeft;
      imageArea.scrollTop = newScrollTop;
      annotator.refresh();
    }

    let startZoom = 1;
    imageArea.addEventListener(
      "gesturestart",
      (e) => {
        e.preventDefault();
        startZoom = zoom;
      },
      { passive: false }
    );
    imageArea.addEventListener(
      "gesturechange",
      (e) => {
        e.preventDefault();
        setZoom(startZoom * e.scale, e.clientX, e.clientY);
      },
      { passive: false }
    );
    imageArea.addEventListener(
      "gestureend",
      (e) => {
        e.preventDefault();
      },
      { passive: false }
    );
    imageArea.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey) {
          return;
        }
        e.preventDefault();
        setZoom(zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
      },
      { passive: false }
    );
  }

  // Idempotent: a no-op when no overlay is open, so every close path (✕,
  // backdrop click, Escape, post-Download, post-Copy, and the next
  // measure()) can call it unconditionally.
  function closeOverlay() {
    if (!state.overlay) {
      return;
    }
    const { host, url, onKeydown, onResize, annotator, priorHtmlOverflow, priorBodyOverflow } =
      state.overlay;
    if (annotator) {
      annotator.destroy();
    }
    window.removeEventListener("keydown", onKeydown, true);
    if (onResize) {
      window.removeEventListener("resize", onResize);
    }
    URL.revokeObjectURL(url);
    host.remove();
    if (priorHtmlOverflow) {
      document.documentElement.style.overflow = priorHtmlOverflow;
    } else {
      document.documentElement.style.removeProperty("overflow");
    }
    // priorBodyOverflow is null (not just falsy) when there was no
    // document.body to touch at open time — only restore it if we actually
    // set it.
    if (priorBodyOverflow !== null && document.body) {
      if (priorBodyOverflow) {
        document.body.style.overflow = priorBodyOverflow;
      } else {
        document.body.style.removeProperty("overflow");
      }
    }
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

  // Builds the drag-to-select overlay used by the "Capture Selected Region"
  // context-menu item. Idempotent against double-invocation (e.g. a second
  // menu click while the UI is already up): returns immediately if
  // `state.regionSelect` is already set. On a completed drag, sends the
  // selected rect (viewport CSS px) to background.js via
  // `regionSelected`, which captures the tab and replies with a
  // "previewImage" message.
  function selectRegion() {
    if (state.regionSelect) {
      return { ok: true }; // already active
    }

    const host = document.createElement("div");
    host.style.position = "fixed";
    host.style.inset = "0";
    host.style.zIndex = "2147483647";
    host.style.cursor = "crosshair";

    // Open shadow root so page CSS can never leak in (or out).
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      .surface {
        position: absolute;
        inset: 0;
      }
      .hint {
        position: fixed;
        top: 24px;
        left: 50%;
        transform: translateX(-50%);
        padding: 10px 16px;
        background: rgba(20, 20, 20, 0.85);
        border-radius: 999px;
        font: 12px -apple-system, BlinkMacSystemFont, sans-serif;
        color: #fff;
        white-space: nowrap;
        pointer-events: none;
      }
      .box {
        position: absolute;
        box-sizing: border-box;
        border: 1.5px dashed #fff;
        background: rgba(255, 255, 255, 0.15);
        display: none;
        pointer-events: none;
      }
      .size-label {
        position: absolute;
        bottom: 100%;
        right: 0;
        margin-bottom: 4px;
        padding: 2px 6px;
        background: rgba(20, 20, 20, 0.85);
        border-radius: 4px;
        font: 11px -apple-system, BlinkMacSystemFont, sans-serif;
        color: #fff;
        white-space: nowrap;
      }
    `;

    const surface = document.createElement("div");
    surface.className = "surface";

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Drag to select an area — press Esc to cancel";

    const box = document.createElement("div");
    box.className = "box";
    const sizeLabel = document.createElement("div");
    sizeLabel.className = "size-label";
    box.appendChild(sizeLabel);
    surface.appendChild(box);

    shadow.append(style, surface, hint);
    document.documentElement.appendChild(host);

    let dragging = false;
    let startX = 0;
    let startY = 0;

    function paintBox(x, y, w, h) {
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
      sizeLabel.textContent = `${Math.round(w)} × ${Math.round(h)}`;
    }

    function onMouseDown(event) {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      box.style.display = "block";
      paintBox(startX, startY, 0, 0);
    }

    function onMouseMove(event) {
      if (!dragging) {
        return;
      }
      const x = Math.min(startX, event.clientX);
      const y = Math.min(startY, event.clientY);
      const w = Math.abs(event.clientX - startX);
      const h = Math.abs(event.clientY - startY);
      paintBox(x, y, w, h);
    }

    function onMouseUp(event) {
      if (!dragging) {
        return;
      }
      dragging = false;
      const x = Math.min(startX, event.clientX);
      const y = Math.min(startY, event.clientY);
      const w = Math.abs(event.clientX - startX);
      const h = Math.abs(event.clientY - startY);
      removeRegionSelect();
      if (w < 4 || h < 4) {
        return; // too small to be a deliberate selection; treat as a cancel
      }
      // Two rAFs guarantee the just-removed selection UI is not painted in
      // the frame `captureVisibleTab` grabs next.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          browser.runtime.sendMessage({ type: "regionSelected", rect: { x, y, w, h } });
        });
      });
    }

    function onDragStart(event) {
      event.preventDefault();
    }

    surface.addEventListener("mousedown", onMouseDown);
    surface.addEventListener("mousemove", onMouseMove);
    surface.addEventListener("mouseup", onMouseUp);
    surface.addEventListener("dragstart", onDragStart);

    const onKeydown = (event) => {
      if (event.key === "Escape") {
        removeRegionSelect();
      }
    };
    window.addEventListener("keydown", onKeydown, true);

    state.regionSelect = { host, onKeydown };
    return { ok: true };
  }

  // Idempotent: a no-op once the region-select UI is already torn down, so
  // every teardown path (mouseup after a completed or too-small drag,
  // Escape, and the next measure()) can call it unconditionally.
  function removeRegionSelect() {
    if (!state.regionSelect) {
      return;
    }
    const { host, onKeydown } = state.regionSelect;
    window.removeEventListener("keydown", onKeydown, true);
    host.remove();
    state.regionSelect = null;
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
