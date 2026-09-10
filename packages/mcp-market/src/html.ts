/**
 * Shared HTML primitives.
 *
 * `escapeHtml` is the single escaping function used by every renderer, so there
 * is exactly one place to audit. `safeHref` re-validates outbound links rather
 * than trusting that an upstream value was already checked.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (value: string): string =>
  value.replaceAll(/[&<>"']/g, (char) => ESCAPES[char] ?? char);

/** Only `http(s)` links reach the document. */
export const safeHref = (value: string | null): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
};

/** Design tokens shared by the public and admin surfaces. */
export const THEME_TOKENS = `
:root {
  --ink:#17191C; --muted:#686D76; --line:#E7E9EE; --fog:#F5F6F8;
  --cobalt:#315CEC; --paper:#FCFCFB; --coral:#F0643C;
}
* { box-sizing: border-box; }
body {
  margin:0; background:#fff; color:var(--ink); line-height:1.55;
  font-family: Inter, ui-sans-serif, "PingFang SC", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; }
`;
