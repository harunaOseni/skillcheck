import type { Claim, Finding, CheckerResult } from "../types.js";
import { type Sources, parseDocsRateLimit } from "../sources.js";

const RL_PAGE = "api-reference/rate-limit.md";
const ONBOARD = "ai-onboarding.md";

export async function checkRateLimits(claims: Claim[], src: Sources): Promise<CheckerResult> {
  const checker = "rate-limits";
  const mine = claims.filter((c) => c.kind === "rate_limit");
  if (!src.docs) return { checker, findings: [], checked: 0, skipped: "no docs source" };
  let primary: number | undefined;
  try {
    primary = parseDocsRateLimit(await src.docs.get(RL_PAGE));
  } catch (e) {
    return { checker, findings: [], checked: 0, skipped: `cannot read ${RL_PAGE}: ${(e as Error).message}` };
  }
  if (primary === undefined) return { checker, findings: [], checked: 0, skipped: `no "N requests per second" in ${RL_PAGE}` };
  let secondary: number | undefined;
  try {
    secondary = parseDocsRateLimit(await src.docs.get(ONBOARD));
  } catch {
    /* optional cross-reference */
  }
  const findings: Finding[] = [];
  for (const c of mine) {
    if (c.kind !== "rate_limit") continue;
    if (c.perSecond !== primary) {
      findings.push({
        checker,
        severity: "error",
        file: c.file,
        line: c.line,
        claim: c.text,
        message: `Skill says ${c.perSecond} req/s; docs say the default is ${primary} req/s`,
        expected: `${primary} requests per second (default, per team)` + (secondary !== undefined ? `; ${ONBOARD} says ${secondary}` : ""),
        source: src.docs.label(RL_PAGE),
      });
    }
  }
  return { checker, findings, checked: mine.length };
}
