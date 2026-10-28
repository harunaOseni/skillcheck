import type { Claim, Finding, CheckerResult } from "../types.js";
import type { Sources } from "../sources.js";

const SDK_ALIASES: Record<string, string> = { batch: "emails" };

export async function checkEndpoints(claims: Claim[], src: Sources): Promise<CheckerResult> {
  const checker = "endpoints";
  const eps = claims.filter((c) => c.kind === "endpoint");
  const sdk = claims.filter((c) => c.kind === "sdk");
  if (!src.openapi) return { checker, findings: [], checked: 0, skipped: "no OpenAPI source" };
  let api;
  try {
    api = await src.openapi();
  } catch (e) {
    return { checker, findings: [], checked: 0, skipped: `cannot load OpenAPI: ${(e as Error).message}` };
  }
  const findings: Finding[] = [];
  for (const c of eps) {
    if (c.kind !== "endpoint") continue;
    const methods = api.paths.get(c.path);
    if (!methods) {
      findings.push({
        checker, severity: "error", file: c.file, line: c.line, claim: c.text,
        message: `${c.method} ${c.path} - path not found in OpenAPI spec`,
        expected: "a path defined in resend.json", source: api.label,
      });
    } else if (!methods.has(c.method)) {
      findings.push({
        checker, severity: "error", file: c.file, line: c.line, claim: c.text,
        message: `${c.method} ${c.path} - method not defined for this path`,
        expected: `${c.path} supports ${[...methods].join(", ")}`, source: api.label,
      });
    }
  }
  for (const c of sdk) {
    if (c.kind !== "sdk") continue;
    // SDK convention: resend.batch.send() maps to POST /emails/batch
    const res = (SDK_ALIASES[c.resource.toLowerCase()] ?? c.resource).toLowerCase().replace(/[-_]/g, "");
    if (!api.resources.has(res)) {
      findings.push({
        checker, severity: "warn", file: c.file, line: c.line, claim: c.text,
        message: `SDK resource \`resend.${c.resource}\` has no matching top-level path in the OpenAPI spec`,
        expected: `one of ${[...api.resources].sort().join(", ")}`, source: api.label,
      });
    }
  }
  return { checker, findings, checked: eps.length + sdk.length };
}
