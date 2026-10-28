import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { normalizePath } from "./extract.js";

const execFileP = promisify(execFile);

const isUrl = (s: string) => /^https?:\/\//.test(s);

async function readText(loc: string): Promise<string> {
  if (isUrl(loc)) {
    const res = await fetch(loc, { headers: { "user-agent": "skillcheck" } });
    if (!res.ok) throw new Error(`GET ${loc} -> ${res.status}`);
    return res.text();
  }
  return readFile(loc, "utf8");
}

// ---------------- OpenAPI ----------------
export interface OpenApi {
  /** normalised path -> set of upper-case methods */
  paths: Map<string, Set<string>>;
  /** all documented response status codes across operations */
  statuses: Set<number>;
  /** normalised first path segment, lower-cased, no separators ("apikeys", "contactproperties") */
  resources: Set<string>;
  label: string;
}

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

export function parseOpenApi(json: any, label: string): OpenApi {
  const paths = new Map<string, Set<string>>();
  const statuses = new Set<number>();
  const resources = new Set<string>();
  for (const [p, item] of Object.entries<any>(json.paths ?? {})) {
    const np = normalizePath(p);
    const ms = paths.get(np) ?? new Set<string>();
    for (const m of METHODS) {
      if (!item[m]) continue;
      ms.add(m.toUpperCase());
      for (const code of Object.keys(item[m].responses ?? {})) if (/^\d{3}$/.test(code)) statuses.add(Number(code));
    }
    paths.set(np, ms);
    const seg = p.split("/").filter(Boolean)[0];
    if (seg) resources.add(seg.toLowerCase().replace(/[-_]/g, ""));
  }
  return { paths, statuses, resources, label };
}

export async function loadOpenApi(loc: string): Promise<OpenApi> {
  return parseOpenApi(JSON.parse(await readText(loc)), loc);
}

// ---------------- CLI tree ----------------
export interface CliNode {
  name: string;
  aliases: string[];
  description?: string;
  subcommands: CliNode[];
  options: { long?: string; short?: string; takesValue?: boolean }[];
}
export interface CliSource {
  root: CliNode;
  label: string;
}

export async function loadCliTree(opts: { tree?: string; repo?: string; bin?: string }): Promise<CliSource> {
  if (opts.tree) return { root: JSON.parse(await readFile(opts.tree, "utf8")), label: `CLI command tree (${opts.tree})` };
  const env = { ...process.env, RESEND_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", CI: "1", NO_COLOR: "1" };
  if (opts.bin) {
    const [cmd, ...pre] = opts.bin.split(/\s+/);
    const { stdout } = await execFileP(cmd, [...pre, "commands", "--json"], { env, maxBuffer: 64 << 20 });
    return { root: JSON.parse(stdout), label: `\`${opts.bin} commands --json\`` };
  }
  if (opts.repo) {
    if (!existsSync(path.join(opts.repo, "node_modules")))
      throw new Error(`${opts.repo}/node_modules missing - run \`npm install\` (or pnpm install) in the CLI repo first`);
    const { stdout } = await execFileP("npx", ["--yes", "tsx", "src/cli.ts", "commands", "--json"], {
      cwd: opts.repo,
      env,
      maxBuffer: 64 << 20,
    });
    return { root: JSON.parse(stdout), label: `resend-cli source (${opts.repo}) \`commands --json\`` };
  }
  throw new Error("no CLI source given (--cli-tree, --cli-repo or --cli-bin)");
}

export interface Resolved {
  node: CliNode;
  /** options inherited from ancestors including node itself */
  options: Set<string>;
  path: string[];
}

export function childOf(node: CliNode, tok: string): CliNode | undefined {
  return node.subcommands.find((s) => s.name === tok || s.aliases.includes(tok));
}
export function optionSet(node: CliNode): string[] {
  return node.options.flatMap((o) => [o.long, o.short].filter(Boolean) as string[]);
}

// ---------------- Docs ----------------
export class Docs {
  private cache = new Map<string, Promise<string>>();
  constructor(readonly base: string) {}
  private loc(rel: string) {
    return isUrl(this.base) ? `${this.base.replace(/\/$/, "")}/${rel}` : path.join(this.base, rel);
  }
  get(rel: string): Promise<string> {
    if (!this.cache.has(rel)) this.cache.set(rel, readText(this.loc(rel)));
    return this.cache.get(rel)!;
  }
  label(rel: string) {
    return this.loc(rel);
  }
  /** Normalised doc paths listed in llms.txt (no `.md`, no leading /docs/) */
  async index(): Promise<Set<string>> {
    const txt = await this.get("llms.txt");
    const set = new Set<string>();
    for (const m of txt.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) {
      const mm = /\/docs\/(.*?)(?:\.md)?$/.exec(m[1].split("#")[0]);
      if (mm) set.add(mm[1].replace(/\/$/, ""));
    }
    return set;
  }
}

export function parseDocsRateLimit(md: string): number | undefined {
  const m = /(\d[\d,]*)\s+requests?\s+per\s+second/i.exec(md);
  return m ? Number(m[1].replace(/,/g, "")) : undefined;
}

/** error code -> statuses, from api-reference/errors.md */
export function parseDocsErrors(md: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const parts = md.split(/^###\s+/m).slice(1);
  for (const p of parts) {
    const code = /^`([a-z_]+)`/.exec(p)?.[1];
    const st = /\*\*Status:\*\*\s*(\d{3})/.exec(p)?.[1];
    if (!code || !st) continue;
    (out.get(code) ?? out.set(code, new Set()).get(code)!).add(Number(st));
  }
  return out;
}

export interface Sources {
  openapi?: () => Promise<OpenApi>;
  cli?: () => Promise<CliSource>;
  docs?: Docs;
}
