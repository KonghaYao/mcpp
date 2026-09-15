/**
 * 构建 helper：HTML 入口校验（MCPP/mcp-apps.md §5.1–5.2）。
 */

const EXTERNAL_SCRIPT_RE = /<script[^>]+src=["'](https?:|\/\/)/i;
const BARE_MODULE_IMPORT_RE =
  /\bfrom\s+["'](?!\.|\/)|import\s*\(\s*["'](?!\.|\/)/;

export type ValidateAppHtmlOptions = {
  /** 是否允许外部 script src（重前端 + CSP 声明时）。 */
  allowExternalScripts?: boolean;
};

export type ValidateAppHtmlResult =
  | { ok: true }
  | { ok: false; issues: string[] };

/** 发布前检查单文件 HTML 常见陷阱（§5.1）。 */
export function validateAppHtml(
  html: string,
  options: ValidateAppHtmlOptions = {},
): ValidateAppHtmlResult {
  const issues: string[] = [];
  if (!html.trim()) {
    issues.push("HTML body is empty");
  }
  if (!/<!DOCTYPE\s+html/i.test(html) && !/<html[\s>]/i.test(html)) {
    issues.push("Expected HTML5 document (<!DOCTYPE html> or <html>)");
  }
  if (BARE_MODULE_IMPORT_RE.test(html)) {
    issues.push(
      "Bare module imports detected; bundle dependencies for sandbox loading",
    );
  }
  if (!options.allowExternalScripts && EXTERNAL_SCRIPT_RE.test(html)) {
    issues.push(
      "External script src without allowExternalScripts; declare CSP resourceDomains if intentional",
    );
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/** 多入口清单项（§5.1 public/ → dist/）。 */
export type AppHtmlEntryManifest = {
  templatePath: string;
  html: string;
};

export function validateAppHtmlEntries(
  entries: AppHtmlEntryManifest[],
  options?: ValidateAppHtmlOptions,
): ValidateAppHtmlResult {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.templatePath)) {
      issues.push(`Duplicate template path: ${entry.templatePath}`);
    }
    seen.add(entry.templatePath);
    const result = validateAppHtml(entry.html, options);
    if (!result.ok) {
      for (const issue of result.issues) {
        issues.push(`${entry.templatePath}: ${issue}`);
      }
    }
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
