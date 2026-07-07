"use strict";

for (const button of document.querySelectorAll(".option")) {
  button.addEventListener("click", () => {
    browser.runtime.sendMessage({ type: "captureRequest", mode: button.dataset.mode });
    window.close();
  });
}
