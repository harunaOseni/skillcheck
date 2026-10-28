import type { Claim, Finding, CheckerResult } from "../types.js";
import { type Sources, parseDocsErrors } from "../sources.js";

const ERR_PAGE = "api-reference/errors.md";

export async function checkStatusCodes(claims: Claim[], src: Sources): Promise<CheckerResult> {
  const checker = "status-codes";
  const mine = claims.filter((c) => c.kind === "status");
  if (!src.docs) return { checker, findings: [], checked: 0, skipped: "no docs source" };
  let errors: Map<string, Set<number>>;
  try {
    errors = parseDocsErrors(await src.docs.get(ERR_PAGE));
  } catch (e) {
    return { checker, findings: [], checked: 0, skipped: `cannot read ${ERR_PAGE}: ${(e as Error).message}` };
  }
  if (!errors.size) return { checker, findings: [], checked: 0, skipped: `no error sections parsed from ${ERR_PAGE}` };
  const docStatuses = new Set([...errors.values()].flatMap((s) => [...s]));
  let apiStatuses = new Set<number>();
  if (src.openapi) {
    try {
      apiStatuses = (await src.openapi()).statuses;
    } catch {
      /* optional */
    }
  }
  const source = src.docs.label(ERR_PAGE);
  const findings: Finding[] = [];
  for (const c of mine) {
    if (c.kind !== "status") continue;
    for (const st of c.statuses) {
      if (st >= 400 && !docStatuses.has(st) && !apiStatuses.has(st)) {
        findings.push({
          checker, severity: "warn", file: c.file, line: c.line, claim: c.text,
          message: `HTTP ${st} is not documented as an API error status`,
          expected: `one of ${[...docStatuses].sort().join(", ")}`, source,
        });
      }
    }
    for (const code of c.errorCodes) {
      const known = errors.get(code);
      if (!known) {
        findings.push({
          checker, severity: "error", file: c.file, line: c.line, claim: c.text,
          message: `Error code \`${code}\` does not exist in the API error docs`,
          expected: `a code from ${ERR_PAGE}` + closest(code, errors), source,
        });
      } else if (!c.statuses.some((s) => known.has(s))) {
        findings.push({
          checker, severity: "error", file: c.file, line: c.line, claim: c.text,
          message: `\`${code}\` is listed with HTTP ${c.statuses.join("/")} but docs say ${[...known].join("/")}`,
          expected: `${code} -> ${[...known].join("/")}`, source,
        });
      }
    }
  }
  return { checker, findings, checked: mine.length };
}

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function closest(code: string, errors: Map<string, unknown>): string {
  let best: string | undefined, bd = 99;
  for (const k of errors.keys()) {
    const d = lev(code, k);
    if (d < bd) { bd = d; best = k; }
  }
  return best && bd <= 3 ? ` (did you mean \`${best}\`?)` : "";
}
