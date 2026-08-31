import { expect, test } from "bun:test";
import { renderReadme } from "../src/readme.ts";

test("renders README headings and lists", () => {
  const html = renderReadme("# OpenSpec\n\n- one\n- two");
  expect(html).toContain("<h1>OpenSpec</h1>");
  expect(html).toContain("<li>one</li>");
});

test("sanitizes untrusted README HTML and URLs", () => {
  const markdown =
    "<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n[unsafe](javascript:alert(3))";
  const html = renderReadme(markdown);
  expect(html).not.toContain("<script");
  expect(html).not.toContain("onerror");
  expect(html).not.toContain("javascript:");
});
