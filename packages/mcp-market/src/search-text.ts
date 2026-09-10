/**
 * Shared text preparation for the FTS5 index and its queries.
 *
 * `unicode61` treats a run of CJK ideographs as a single token, which makes
 * substring search over Chinese content useless. Both the indexer and the query
 * builder therefore expand CJK runs into overlapping bigrams and leave Latin
 * words intact. Because it is one function used on both sides, index and query
 * can never drift apart.
 */

const CJK_PATTERN =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

const LATIN_WORD_PATTERN = /[a-z0-9]+/g;

const isCjk = (char: string): boolean => CJK_PATTERN.test(char);

const pushCjkBigrams = (run: string, out: string[]): void => {
  if (run.length === 1) {
    out.push(run);
    return;
  }
  for (let index = 0; index < run.length - 1; index += 1)
    out.push(run.slice(index, index + 2));
};

/** Deterministic, space-separated token stream suitable for FTS5. */
export function toSearchTokens(input: string): string[] {
  const normalized = input.normalize("NFKC").toLowerCase();
  const tokens: string[] = [];
  let cjkRun = "";
  const flushCjk = () => {
    if (cjkRun.length > 0) pushCjkBigrams(cjkRun, tokens);
    cjkRun = "";
  };
  let latinRun = "";
  const flushLatin = () => {
    if (latinRun.length > 0) tokens.push(latinRun);
    latinRun = "";
  };

  for (const char of normalized) {
    if (isCjk(char)) {
      flushLatin();
      cjkRun += char;
      continue;
    }
    if (/[a-z0-9]/.test(char)) {
      flushCjk();
      latinRun += char;
      continue;
    }
    flushCjk();
    flushLatin();
  }
  flushCjk();
  flushLatin();
  return tokens;
}

export const toSearchText = (input: string): string =>
  toSearchTokens(input).join(" ");

export const MAX_SEARCH_QUERY_LENGTH = 128;
const MAX_QUERY_TOKENS = 24;

/**
 * Builds a MATCH expression from user input. Every token is quoted and the
 * result is OR-joined so that FTS operators an operator-typed query can never
 * reach the expression as syntax.
 */
export function toMatchExpression(query: string): string | null {
  const tokens = toSearchTokens(query)
    .filter((token) => token.length > 0)
    .slice(0, MAX_QUERY_TOKENS);
  if (tokens.length === 0) return null;
  return [...new Set(tokens)]
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" OR ");
}

/** Collects every searchable text field of a snapshot into one token stream. */
export function searchableTextOf(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null).join(" ");
}

export { LATIN_WORD_PATTERN };
