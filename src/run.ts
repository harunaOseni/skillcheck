import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { extractClaims } from "./extract.js";
import { CHECKERS } from "./checkers/index.js";
import type { CheckerResult, Claim, Finding } from "./types.js";
import type { Sources } from "./sources.js";

export async function collectMarkdown(targets: string[]): Promise<string[]> {
  const out: string[] = [];
  async function visit(p: string) {
    const s = await stat(p);
    if (s.isDirectory()) {
      for (const e of await readdir(p)) {
        if (e === "node_modules" || e === ".git") continue;
        await visit(path.join(p, e));
      }
    } else if (/\.mdx?$/i.test(p)) out.push(p);
  }
  for (const t of targets) await visit(t);
  return out.sort();
}

export interface IgnoreRule {
  checker?: string;
  file?: string;
  /** substring of the claim line */
  claim?: string;
  reason?: string;
}

export interface RunOptions {
  ignore?: IgnoreRule[];
  targets: string[];
  sources: Sources;
  only?: string[];
  skip?: string[];
  /** report paths relative to this dir */
  cwd?: string;
}
export interface RunResult {
  files: string[];
  claims: Claim[];
  results: CheckerResult[];
  findings: Finding[];
  ignored: Finding[];
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const cwd = opts.cwd ?? process.cwd();
  const files = await collectMarkdown(opts.targets);
  const claims: Claim[] = [];
  for (const f of files) {
    const rel = path.relative(cwd, f) || f;
    claims.push(...extractClaims(rel, await readFile(f, "utf8")));
  }
  const names = Object.keys(CHECKERS).filter((n) => (!opts.only?.length || opts.only.includes(n)) && !opts.skip?.includes(n));
  const results: CheckerResult[] = [];
  for (const n of names) results.push(await CHECKERS[n](claims, opts.sources));
  const all = results.flatMap((r) => r.findings).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const rules = opts.ignore ?? [];
  const isIgnored = (f: Finding) =>
    rules.some((r) => (!r.checker || r.checker === f.checker) && (!r.file || f.file.endsWith(r.file)) && (!r.claim || f.claim.includes(r.claim)));
  return { files, claims, results, findings: all.filter((f) => !isIgnored(f)), ignored: all.filter(isIgnored) };
}
