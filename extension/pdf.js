"use strict";

// Dependency-free multi-page PDF assembler. Pure module (no DOM, no browser
// APIs) so it can run in Node for tests and be loaded as a plain script in
// the extension. No ES modules, matching shared.js's build-step-free setup.

// var (not const): tolerates re-declaration if this file is ever injected
// more than once, same rationale as shared.js's MAX_CANVAS_PX.
var A4_WIDTH_PT = 595.28;
var A4_HEIGHT_PT = 841.89;

// ASCII/latin1 text -> bytes. Safe here because every string this module
// builds (PDF syntax, numbers) is pure ASCII.
function encodeAscii(str) {
  return new TextEncoder().encode(str);
}

// Zero-pad a non-negative integer to a fixed width (used for xref offsets).
function padDigits(n, width) {
  const s = String(n);
  return "0".repeat(Math.max(0, width - s.length)) + s;
}

// Assemble a multi-page PDF from pre-encoded JPEG page images.
// pages: non-empty array of { jpeg: Uint8Array, width: number, height: number }
// Returns a Uint8Array containing a valid PDF 1.4 byte stream.
function buildPdf(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error("buildPdf: pages must be a non-empty array");
  }

  const chunks = [];
  let length = 0;
  const offsets = []; // offsets[objNum] = byte offset of "<objNum> 0 obj"

  function push(bytes) {
    chunks.push(bytes);
    length += bytes.length;
  }

  function pushText(str) {
    push(encodeAscii(str));
  }

  function beginObject(objNum) {
    offsets[objNum] = length;
  }

  // 1. Header
  pushText("%PDF-1.4\n");

  const n = pages.length;
  const totalObjects = 2 + n * 3; // catalog + pages + 3 objects per page

  // 2. Object 1 - catalog
  beginObject(1);
  pushText("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  // 3. Object 2 - pages (page object numbers are 3 + i*3)
  const kids = [];
  for (let i = 0; i < n; i++) {
    kids.push(`${3 + i * 3} 0 R`);
  }
  beginObject(2);
  pushText(`2 0 obj\n<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${n} >>\nendobj\n`);

  // 4. Per-page objects
  for (let i = 0; i < n; i++) {
    const p = pages[i];
    const pageNum = 3 + i * 3;
    const contentNum = pageNum + 1;
    const imageNum = pageNum + 2;

    // Full page width, top-aligned: drawn height keeps the image's aspect
    // ratio; any leftover space (a shorter last page) is left blank below.
    const h = (A4_WIDTH_PT * (p.height / p.width)).toFixed(2);
    const y = (A4_HEIGHT_PT - Number(h)).toFixed(2);

    beginObject(pageNum);
    pushText(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] ` +
        `/Contents ${contentNum} 0 R /Resources << /XObject << /Im0 ${imageNum} 0 R >> >> >>\nendobj\n`
    );

    const body = `q\n595.28 0 0 ${h} 0 ${y} cm\n/Im0 Do\nQ\n`;
    const bodyBytes = encodeAscii(body);
    beginObject(contentNum);
    pushText(`${contentNum} 0 obj\n<< /Length ${bodyBytes.length} >>\nstream\n`);
    push(bodyBytes);
    pushText("endstream\nendobj\n");

    beginObject(imageNum);
    pushText(
      `${imageNum} 0 obj\n<< /Type /XObject /Subtype /Image /Name /Im0 /Width ${p.width} ` +
        `/Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
        `/Length ${p.jpeg.length} >>\nstream\n`
    );
    push(p.jpeg);
    pushText("\nendstream\nendobj\n");
  }

  // 5. xref table
  const xrefOffset = length;
  pushText(`xref\n0 ${totalObjects + 1}\n`);
  pushText("0000000000 65535 f \n");
  for (let objNum = 1; objNum <= totalObjects; objNum++) {
    pushText(`${padDigits(offsets[objNum], 10)} 00000 n \n`);
  }

  // 6. Trailer
  pushText(`trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  const result = new Uint8Array(length);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  return result;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildPdf };
}
