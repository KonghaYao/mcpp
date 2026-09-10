/**
 * HTML primitives.
 *
 * `escapeHtml` is the only escaping function in the codebase, and `safeHref`
 * re-validates outbound links at render time instead of trusting that an
 * upstream value was already checked. Both are security boundaries, so both are
 * tested directly rather than only through a rendered page.
 */

import { describe, expect, test } from "bun:test";
import { escapeHtml, safeHref } from "../../src/html.ts";

describe("escapeHtml", () => {
  test("escapes every character that can break out of text or an attribute", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
  });

  test("escapes the single quote so attribute injection fails", () => {
    expect(escapeHtml("' onmouseover='alert(1)")).toBe(
      "&#39; onmouseover=&#39;alert(1)",
    );
  });

  test("escapes the ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  test("leaves ordinary text and CJK untouched", () => {
    expect(escapeHtml("投资研究专家团队 · 1.4.0")).toBe(
      "投资研究专家团队 · 1.4.0",
    );
  });

  test("returns an empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("safeHref", () => {
  test("keeps an https link", () => {
    expect(safeHref("https://www.npmjs.com/package/acme")).toBe(
      "https://www.npmjs.com/package/acme",
    );
  });

  test("keeps an http link", () => {
    // `URL` normalises a bare origin to include a path, which is harmless here.
    expect(safeHref("http://localhost:4873/registry")).toBe(
      "http://localhost:4873/registry",
    );
    expect(safeHref("http://localhost:4873")).toBe("http://localhost:4873/");
  });

  test("drops a javascript: link", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
  });

  test("drops a data: link", () => {
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  test("drops a file: link", () => {
    expect(safeHref("file:///etc/passwd")).toBeNull();
  });

  test("drops a link that is not a URL at all", () => {
    expect(safeHref("not a url")).toBeNull();
  });

  test("drops null and empty input", () => {
    expect(safeHref(null)).toBeNull();
    expect(safeHref("")).toBeNull();
  });

  test("normalises the URL it keeps", () => {
    expect(safeHref("HTTPS://Example.com/a b")).toBe(
      "https://example.com/a%20b",
    );
  });
});
