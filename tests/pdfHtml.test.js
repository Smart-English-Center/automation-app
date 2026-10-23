import test from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml } from "../src/pdf/html.js";

test("single-asterisk examples render as emphasis without visible markers", () => {
  const html = markdownToHtml(`**To improve:**
Use *It is used for...* and check the verb after *please*.`);

  assert.match(html, /<em>It is used for\.\.\.<\/em>/);
  assert.match(html, /<em>please<\/em>/);
  assert.doesNotMatch(html, /\*/);
});

test("unmatched asterisks never leak into rendered feedback", () => {
  const html = markdownToHtml("Why?: Remove this * broken marker.");

  assert.match(html, /Remove this  broken marker\./);
  assert.doesNotMatch(html, /\*/);
});

test("numeric multiplication remains readable when asterisks are removed", () => {
  const html = markdownToHtml("Model: Calculate 5 * 2.");

  assert.match(html, /5 &times; 2/);
  assert.doesNotMatch(html, /\*/);
});
