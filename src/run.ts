import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { extractClaims } from "./extract.js";
import { CHECKERS } from "./checkers/index.js";
import type { CheckerResult, Claim, Finding } from "./types.js";
import type { Sources } from "./sources.js";
import { aiExtract, mergeClaims, type AiOptions, type AiStats } from "./ai.js";

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
  /** optional AI claim extraction; checkers stay deterministic */
  ai?: AiOptions;
}
export interface RunResult {
  files: string[];
  claims: Claim[];
  results: CheckerResult[];
  findings: Finding[];
  ignored: Finding[];
  ai?: AiStats & { regexClaims: number; aiOnly: number };
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const cwd = opts.cwd ?? process.cwd();
  const files = await collectMarkdown(opts.targets);
  const regexClaims: Claim[] = [];
  const sourcesText: { file: string; content: string }[] = [];
  for (const f of files) {
    const rel = path.relative(cwd, f) || f;
    const content = await readFile(f, "utf8");
    sourcesText.push({ file: rel, content });
    regexClaims.push(...extractClaims(rel, content));
  }
  let claims = regexClaims;
  let ai: RunResult["ai"];
  if (opts.ai) {
    const got = await aiExtract(sourcesText, opts.ai);
    const merged = mergeClaims(regexClaims, got.claims);
    claims = merged.claims;
    ai = { ...got.stats, regexClaims: regexClaims.length, aiOnly: merged.aiOnly };
  }
  const names = Object.keys(CHECKERS).filter((n) => (!opts.only?.length || opts.only.includes(n)) && !opts.skip?.includes(n));
  const results: CheckerResult[] = [];
  for (const n of names) results.push(await CHECKERS[n](claims, opts.sources));
  // Findings the regex-only claim set would not have produced are flagged [ai].
  if (ai && ai.aiOnly) {
    const fk = (f: Finding) => `${f.checker}|${f.file}|${f.line}|${f.message}`;
    const base = new Set<string>();
    for (const n of names) for (const f of (await CHECKERS[n](regexClaims, opts.sources)).findings) base.add(fk(f));
    for (const r of results) for (const f of r.findings) if (!base.has(fk(f))) f.ai = true;
  }
  const all = results.flatMap((r) => r.findings).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const rules = opts.ignore ?? [];
  const isIgnored = (f: Finding) =>
    rules.some((r) => (!r.checker || r.checker === f.checker) && (!r.file || f.file.endsWith(r.file)) && (!r.claim || f.claim.includes(r.claim)));
  return { files, claims, results, findings: all.filter((f) => !isIgnored(f)), ignored: all.filter(isIgnored), ai };
}
