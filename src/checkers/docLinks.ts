import type { Claim, Finding, CheckerResult } from "../types.js";
import type { Sources } from "../sources.js";

export async function checkDocLinks(claims: Claim[], src: Sources): Promise<CheckerResult> {
  const checker = "doc-links";
  const links = claims.filter((c) => c.kind === "doc_link");
  if (!src.docs) return { checker, findings: [], checked: 0, skipped: "no docs source" };
  let index: Set<string>;
  try {
    index = await src.docs.index();
  } catch (e) {
    return { checker, findings: [], checked: 0, skipped: `cannot read llms.txt: ${(e as Error).message}` };
  }
  const findings: Finding[] = [];
  for (const c of links) {
    if (c.kind !== "doc_link") continue;
    const m = /\/docs\/(.*?)(?:\.md)?$/.exec(c.url.split("#")[0].split("?")[0]);
    const p = m?.[1].replace(/\/$/, "");
    if (!p || p === "" || /\.\w+$/.test(p)) continue; // llms.txt, assets
    if (!index.has(p) && !(await resolves(src, p))) {
      findings.push({
        checker, severity: "warn", file: c.file, line: c.line, claim: c.text,
        message: `Docs page \`${c.url}\` is not listed in llms.txt and \`<page>.md\` does not resolve`,
        expected: "a page listed in llms.txt or serving <page>.md", source: src.docs.label("llms.txt"),
      });
    }
  }
  return { checker, findings, checked: links.length };
}

/** Pages missing from llms.txt can still exist (section roots, redirects): try the .md. */
async function resolves(src: Sources, p: string): Promise<boolean> {
  try {
    await src.docs!.get(`${p}.md`);
    return true;
  } catch {
    return false;
  }
}
