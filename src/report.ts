import type { RunResult } from "./run.js";
import type { Finding } from "./types.js";

const color = (n: number, s: string, on: boolean) => (on ? `\u001b[${n}m${s}\u001b[0m` : s);

export function terminalReport(r: RunResult, useColor: boolean): string {
  const L: string[] = [];
  L.push(`skillcheck: ${r.files.length} files, ${r.claims.length} claims extracted`);
  for (const c of r.results)
    L.push(`  ${c.checker.padEnd(13)} ${c.skipped ? `SKIPPED (${c.skipped})` : `${c.checked} checked, ${c.findings.length} finding(s)`}`);
  L.push("");
  for (const f of r.findings) {
    const sev = f.severity === "error" ? color(31, "error", useColor) : f.severity === "warn" ? color(33, "warn ", useColor) : "info ";
    L.push(`${sev} ${f.file}:${f.line}  [${f.checker}]`);
    L.push(`      ${f.message}`);
    L.push(`      claim:    ${f.claim.length > 150 ? f.claim.slice(0, 147) + "..." : f.claim}`);
    L.push(`      expected: ${f.expected}`);
    L.push(`      source:   ${f.source}`);
  }
  const e = r.findings.filter((f) => f.severity === "error").length;
  const w = r.findings.filter((f) => f.severity === "warn").length;
  L.push("");
  L.push((e || w ? `${e} error(s), ${w} warning(s)` : "No drift detected.") + (r.ignored.length ? ` (${r.ignored.length} ignored via config)` : ""));
  return L.join("\n");
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function markdownReport(r: RunResult, generated = new Date().toISOString()): string {
  const e = r.findings.filter((f) => f.severity === "error").length;
  const w = r.findings.filter((f) => f.severity === "warn").length;
  const L: string[] = ["# SkillCheck report", "", `Generated ${generated}. ${r.files.length} files, ${r.claims.length} claims extracted. **${e} error(s), ${w} warning(s).**${r.ignored.length ? ` ${r.ignored.length} finding(s) ignored via config.` : ""}`, ""];
  L.push("| Checker | Claims checked | Findings | Status |", "|---|---|---|---|");
  for (const c of r.results) L.push(`| ${c.checker} | ${c.checked} | ${c.findings.length} | ${c.skipped ? `skipped: ${esc(c.skipped)}` : "ran"} |`);
  L.push("");
  if (!r.findings.length) L.push("No drift detected.");
  else {
    L.push("| Severity | Location | Checker | Claim | Problem | Expected | Source |", "|---|---|---|---|---|---|---|");
    for (const f of r.findings as Finding[])
      L.push(`| ${f.severity} | \`${f.file}:${f.line}\` | ${f.checker} | \`${esc(f.claim.slice(0, 120)).replace(/`/g, "'")}\` | ${esc(f.message)} | ${esc(f.expected)} | ${esc(f.source)} |`);
  }
  return L.join("\n") + "\n";
}

export function jsonReport(r: RunResult): string {
  return JSON.stringify(
    {
      files: r.files.length,
      claims: r.claims.length,
      checkers: r.results.map((c) => ({ checker: c.checker, checked: c.checked, findings: c.findings.length, skipped: c.skipped ?? null })),
      findings: r.findings,
      ignored: r.ignored.length,
    },
    null,
    2,
  );
}
