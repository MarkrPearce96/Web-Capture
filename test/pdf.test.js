"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildPdf } = require("../extension/pdf.js");

// Minimal fake JPEG payload (SOI/APP0 header + a few bytes + EOI). buildPdf
// must treat this as an opaque byte blob — it never parses JPEG internals.
const FAKE_JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

function page(overrides) {
  return Object.assign({ jpeg: FAKE_JPEG, width: 100, height: 100 }, overrides);
}

// Non-overlapping count of `needle`'s bytes inside `haystack`.
function countOccurrences(haystack, needle) {
  const hay = Buffer.from(haystack);
  const need = Buffer.from(needle);
  let count = 0;
  let idx = 0;
  while ((idx = hay.indexOf(need, idx)) !== -1) {
    count++;
    idx += need.length;
  }
  return count;
}

test("buildPdf: starts with the PDF header and ends with %%EOF", () => {
  const pdf = buildPdf([page()]);
  const header = Buffer.from("%PDF-1.4\n", "ascii");
  assert.deepEqual(Buffer.from(pdf.subarray(0, header.length)), header);

  const footer = Buffer.from(pdf.subarray(pdf.length - 5)).toString("latin1");
  assert.equal(footer, "%%EOF");
});

test("buildPdf: catalog reports the page count and one /Type /Page per page", () => {
  const pdf = buildPdf([page(), page()]);
  const text = Buffer.from(pdf).toString("latin1");

  assert.ok(text.includes("/Count 2"), "catalog should report /Count 2");

  const pageMatches = text.match(/\/Type \/Page /g) || [];
  assert.equal(pageMatches.length, 2, "should find exactly two /Type /Page objects (trailing space excludes /Pages)");
});

test("buildPdf: embeds each page's JPEG bytes verbatim, once per page", () => {
  const pdf = buildPdf([page(), page(), page()]);
  assert.equal(countOccurrences(pdf, FAKE_JPEG), 3);
});

test("buildPdf: top-aligns a page whose aspect ratio differs from A4", () => {
  // 1000x1414 px -> drawn height = 595.28 * 1414/1000 = 841.72592 -> 841.73 (2dp)
  // y = 841.89 - 841.73 = 0.16
  const pdf = buildPdf([page({ width: 1000, height: 1414 })]);
  const text = Buffer.from(pdf).toString("latin1");

  assert.ok(
    text.includes("595.28 0 0 841.73 0 0.16 cm"),
    "content stream should contain the expected cm transform"
  );
});

test("buildPdf: xref table offsets point at the start of the matching object", () => {
  const pdf = buildPdf([page(), page({ width: 200, height: 300 })]);
  const text = Buffer.from(pdf).toString("latin1");

  const trailerMatch = text.match(/startxref\n(\d+)\n%%EOF$/);
  assert.ok(trailerMatch, "trailer must end with startxref/<offset>/%%EOF");
  const xrefOffset = Number(trailerMatch[1]);
  assert.equal(text.slice(xrefOffset, xrefOffset + 4), "xref", "startxref offset must point at the xref table");

  const xrefSectionMatch = text.match(/xref\n0 (\d+)\n([\s\S]*?)trailer\n/);
  assert.ok(xrefSectionMatch, "xref section must be present with a header line");
  const total = Number(xrefSectionMatch[1]);
  const entryLines = xrefSectionMatch[2].split("\n").filter((line) => line.length > 0);
  assert.equal(entryLines.length, total, "there should be exactly `total` xref entry lines (free + real)");

  // Every entry line, including the free entry, is exactly 20 bytes (19 chars + \n).
  for (const line of entryLines) {
    assert.equal(line.length, 19, `xref entry line should be 19 chars before its \\n: ${JSON.stringify(line)}`);
  }
  assert.equal(entryLines[0], "0000000000 65535 f ", "first entry must be the free-list head");

  for (let objNum = 1; objNum < total; objNum++) {
    const offset = Number(entryLines[objNum].slice(0, 10));
    const expectedStart = `${objNum} 0 obj`;
    assert.equal(
      text.slice(offset, offset + expectedStart.length),
      expectedStart,
      `xref entry for object ${objNum} should point at "${expectedStart}"`
    );
  }
});

test("buildPdf: throws for a missing or empty pages array", () => {
  assert.throws(() => buildPdf([]), { message: "buildPdf: pages must be a non-empty array" });
  assert.throws(() => buildPdf(undefined), { message: "buildPdf: pages must be a non-empty array" });
});
