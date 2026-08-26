import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

const allowedTags = [
  "a", "blockquote", "br", "code", "del", "details", "em", "h1", "h2", "h3",
  "h4", "h5", "h6", "hr", "img", "li", "ol", "p", "pre", "strong", "summary",
  "table", "tbody", "td", "th", "thead", "tr", "ul",
];

export function renderReadme(markdown: string) {
  const rendered = marked.parse(markdown, { async: false, gfm: true });
  return sanitizeHtml(rendered, {
    allowedTags,
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      code: ["class"],
      img: ["src", "alt", "title", "width", "height"],
      th: ["align"],
      td: ["align"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tagName, attribs) => ({
        tagName: "a",
        attribs: {
          ...attribs,
          target: "_blank",
          rel: "noopener noreferrer nofollow",
        },
      }),
    },
  });
}
