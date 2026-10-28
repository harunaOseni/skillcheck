import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizePath, parseCliLine } from "./extract.js";
import type { Claim } from "./types.js";

/**
 * Optional AI claim extraction. The model only *finds* claims (kind, value, line, quote).
 * Every claim is validated and grounded in the actual source line, then handed to the same
 * deterministic checkers as regex claims. The model never decides whether a claim is wrong.
 */

export const DEFAULT_MODEL = "gpt-4o-mini";
const PROMPT_VERSION = "v2";
const CHUNK_LINES = 150;
const API_URL = "https://api.openai.com/v1/chat/completions";

export interface AiOptions {
  apiKey: string;
  model: string;
  /** directory for cached responses; undefined disables the cache */
  cacheDir?: string;
  fetch?: typeof fetch;
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

export interface AiStats {
  model: string;
  files: number;
  cacheHits: number;
  /** raw claims returned by the model */
  proposed: number;
  /** claims dropped by validation (bad shape, quote not on the line, value not in the line) */
  rejected: number;
  /** claims that survived validation */
  accepted: number;
  /** token usage reported by the API for uncached calls */
  promptTokens: number;
  completionTokens: number;
}

export const SYSTEM_PROMPT = `You extract checkable factual claims about the Resend API, CLI and docs from agent-skill markdown.
You are given a markdown file with line numbers ("<n>: <text>"). Return JSON {"claims":[...]}.
Each claim has: kind, line (the number shown), quote (an EXACT verbatim substring of that line), plus kind fields:
- rate_limit: per_second = the requests-per-second number stated.
- status: statuses = HTTP status codes stated, error_codes = snake_case API error names stated alongside them on that line.
- endpoint: method (GET/POST/PUT/PATCH/DELETE) and path (as written, e.g. /emails/{id}) of a Resend API endpoint, including curl calls to api.resend.com.
- cli_command: command = the full \`resend ...\` invocation exactly as written on that line, with its flags.
- doc_link: url = a resend.com/docs URL.
Only claims about the Resend API itself count: ignore routes, handlers and HTTP responses of the reader's own app (e.g. Express/Next.js webhook receivers, \`res.status(400)\`), and SDK method calls.
Rules: only claims the text asserts or shows on that line; never infer, correct, or invent; never judge whether a claim is right; copy values exactly as written. Unused fields must be null (arrays: []). If nothing qualifies, return {"claims":[]}.`;

const KINDS = ["rate_limit", "status", "endpoint", "cli_command", "doc_link"] as const;

const RESPONSE_SCHEMA = {
  name: "claims",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["claims"],
    properties: {
      claims: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "line", "quote", "per_second", "statuses", "error_codes", "method", "path", "command", "url"],
          properties: {
            kind: { type: "string", enum: [...KINDS] },
            line: { type: "integer" },
            quote: { type: "string" },
            per_second: { type: ["number", "null"] },
            statuses: { type: "array", items: { type: "integer" } },
            error_codes: { type: "array", items: { type: "string" } },
            method: { type: ["string", "null"] },
            path: { type: ["string", "null"] },
            command: { type: ["string", "null"] },
            url: { type: ["string", "null"] },
          },
        },
      },
    },
  },
};

export interface RawClaim {
  kind: (typeof KINDS)[number];
  line: number;
  quote: string;
  per_second: number | null;
  statuses: number[];
  error_codes: string[];
  method: string | null;
  path: string | null;
  command: string | null;
  url: string | null;
}

const isStr = (x: unknown): x is string => typeof x === "string";
const strOrNull = (x: unknown) => (x === undefined || x === null ? null : isStr(x) ? x : undefined);

/** Schema-validate one model claim. Returns undefined for anything malformed. */
export function parseRawClaim(x: unknown): RawClaim | undefined {
  if (!x || typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>;
  if (!KINDS.includes(o.kind as any)) return undefined;
  if (!Number.isInteger(o.line) || !isStr(o.quote)) return undefined;
  const ps = o.per_second === undefined || o.per_second === null ? null : typeof o.per_second === "number" && Number.isFinite(o.per_second) ? o.per_second : undefined;
  const arr = <T>(v: unknown, ok: (e: unknown) => e is T): T[] | undefined => (v === undefined || v === null ? [] : Array.isArray(v) && v.every(ok) ? v : undefined);
  const statuses = arr(o.statuses, (e): e is number => Number.isInteger(e));
  const codes = arr(o.error_codes, isStr);
  const method = strOrNull(o.method), p = strOrNull(o.path), command = strOrNull(o.command), url = strOrNull(o.url);
  if (ps === undefined || !statuses || !codes || method === undefined || p === undefined || command === undefined || url === undefined) return undefined;
  return { kind: o.kind as RawClaim["kind"], line: o.line as number, quote: o.quote as string, per_second: ps, statuses, error_codes: codes, method, path: p, command, url };
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Turn raw model claims into Claims, dropping any whose quote is not on the cited line or whose
 * values do not literally appear in that line. This is what keeps hallucinations out of the checkers.
 */
export function groundClaims(file: string, content: string, raw: unknown[]): { claims: Claim[]; rejected: number } {
  const lines = content.split(/\r?\n/);
  const out: Claim[] = [];
  let rejected = 0;
  const seen = new Set<string>();
  for (const r of raw) {
    const c = ground(file, lines, parseRawClaim(r));
    const key = c && `${c.line}|${c.kind}|${claimSignature(c)}`;
    if (!c || seen.has(key!)) {
      if (!c) rejected++;
      continue;
    }
    seen.add(key!);
    out.push(c);
  }
  return { claims: out, rejected };
}

function ground(file: string, lines: string[], r: RawClaim | undefined): Claim | undefined {
  if (!r || r.line < 1 || r.line > lines.length) return undefined;
  const raw = lines[r.line - 1];
  const hay = squash(raw);
  const quote = squash(r.quote);
  if (quote.length < 3 || !hay.includes(quote)) return undefined;
  const text = raw.trim();
  const base = { file, line: r.line, text, ai: true as const };
  switch (r.kind) {
    case "rate_limit": {
      if (r.per_second === null || r.per_second <= 0) return undefined;
      const n = String(r.per_second);
      if (!new RegExp(`(?<![\\d.])${n.replace(".", "\\.")}(?![\\d.])`).test(raw.replace(/(\d),(\d)/g, "$1$2"))) return undefined;
      return { ...base, kind: "rate_limit", perSecond: r.per_second };
    }
    case "status": {
      if (!r.statuses.length || r.statuses.some((s) => s < 100 || s > 599 || !new RegExp(`(?<!\\d)${s}(?!\\d)`).test(raw))) return undefined;
      if (/\bstatus\s*[:(]\s*\d{3}|\.status\(\d{3}\)|statusCode/.test(raw)) return undefined; // the reader's own app responding, not a Resend claim
      if (r.error_codes.some((e) => !/^[a-z]+(?:_[a-z]+)+$/.test(e) || !raw.includes(e))) return undefined;
      return { ...base, kind: "status", statuses: r.statuses, errorCodes: r.error_codes };
    }
    case "endpoint": {
      const method = r.method?.toUpperCase();
      if (!method || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) || !r.path || !r.path.startsWith("/") || !raw.includes(r.path)) return undefined;
      // must be a Resend API call (api.resend.com) or a literal "METHOD /path", not the reader's own routes like app.post('/x')
      if (!/api\.resend\.com/.test(raw) && !new RegExp(`\\b${method}\\s+${r.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(raw)) return undefined;
      const p = normalizePath(r.path);
      if (p === "/" || p.length < 2) return undefined;
      return { ...base, kind: "endpoint", method, path: p };
    }
    case "cli_command": {
      const tokens = r.command ? parseCliLine(r.command) : null;
      if (!tokens || tokens.some((t) => !raw.includes(t))) return undefined;
      return { ...base, kind: "cli_command", tokens };
    }
    case "doc_link": {
      const url = r.url?.replace(/[.)]+$/, "");
      if (!url || !/^https?:\/\/resend\.com\/docs\/\S+$/.test(url) || !raw.includes(url)) return undefined;
      return { ...base, kind: "doc_link", url };
    }
  }
}

/** Value identity of a claim, used to dedupe regex vs AI claims on the same file+line+kind. */
export function claimSignature(c: Claim): string {
  switch (c.kind) {
    case "rate_limit": return String(c.perSecond);
    case "status": return [...c.statuses].sort().join(",");
    case "endpoint": return `${c.method} ${c.path}`;
    case "cli_command": return c.tokens.join(" ");
    case "doc_link": return c.url;
    case "cli_flag": return `${c.command.join(" ")} ${c.flags.join(" ")}`;
    case "cli_group": return `${c.command.join(" ")} ${c.subcommands.join(" ")}`;
    case "sdk": return `${c.resource}.${c.method}`;
  }
}

/** Merge regex and AI claims, deduping by file+line+kind+value. Regex claims win. */
export function mergeClaims(regex: Claim[], ai: Claim[]): { claims: Claim[]; aiOnly: number } {
  const key = (c: Claim) => `${c.file}:${c.line}:${c.kind}:${claimSignature(c)}`;
  const seen = new Set(regex.map(key));
  const added: Claim[] = [];
  for (const c of ai) {
    if (seen.has(key(c))) continue;
    seen.add(key(c));
    added.push(c);
  }
  return { claims: [...regex, ...added], aiOnly: added.length };
}

function chunkLines(content: string): { start: number; text: string }[] {
  const lines = content.split(/\r?\n/);
  const chunks: { start: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i += CHUNK_LINES) {
    const slice = lines.slice(i, i + CHUNK_LINES);
    if (slice.every((l) => !l.trim())) continue;
    chunks.push({ start: i + 1, text: slice.map((l, j) => `${i + j + 1}: ${l}`).join("\n") });
  }
  return chunks;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function redact(msg: string, key: string): string {
  let m = key ? msg.split(key).join("[redacted]") : msg;
  m = m.replace(/\b(?:sk|key)[-_][A-Za-z0-9_*-]{4,}/g, "[redacted]");
  return m.slice(0, 300);
}

async function callModel(chunk: string, o: AiOptions, stats?: AiStats): Promise<unknown[]> {
  const f = o.fetch ?? fetch;
  const retries = o.retries ?? 3;
  let lastErr = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep((o.retryDelayMs ?? 1000) * 2 ** (attempt - 1));
    let res: Response;
    try {
      res = await f(API_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
        body: JSON.stringify({
          model: o.model,
          temperature: 0,
          seed: 7,
          max_tokens: 4096,
          response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: chunk },
          ],
        }),
      });
    } catch (e) {
      lastErr = `request failed: ${redact((e as Error).message, o.apiKey)}`;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = `OpenAI HTTP ${res.status}`;
      continue;
    }
    const body: any = await res.json().catch(() => undefined);
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${redact(String(body?.error?.message ?? "request rejected"), o.apiKey)} (model: ${o.model})`);
    const choice = body?.choices?.[0];
    if (stats) {
      stats.promptTokens += Number(body?.usage?.prompt_tokens) || 0;
      stats.completionTokens += Number(body?.usage?.completion_tokens) || 0;
    }
    if (choice?.finish_reason === "length") throw new Error("OpenAI response was truncated; skill chunk produced too many claims");
    try {
      const parsed = JSON.parse(choice?.message?.content ?? "");
      if (!Array.isArray(parsed?.claims)) throw new Error("no claims array");
      return parsed.claims;
    } catch {
      throw new Error("OpenAI returned unparseable JSON");
    }
  }
  throw new Error(`OpenAI unavailable after ${retries + 1} attempts (${lastErr})`);
}

export const cacheKey = (content: string, model: string) =>
  createHash("sha256").update(`${PROMPT_VERSION}\0${model}\0`).update(content).digest("hex");

async function rawClaimsFor(content: string, o: AiOptions, stats: AiStats): Promise<unknown[]> {
  const file = o.cacheDir && path.join(o.cacheDir, `${cacheKey(content, o.model)}.json`);
  if (file) {
    try {
      const cached = JSON.parse(await readFile(file, "utf8"));
      if (Array.isArray(cached)) {
        stats.cacheHits++;
        return cached;
      }
    } catch {
      /* miss */
    }
  }
  const raw: unknown[] = [];
  for (const ch of chunkLines(content)) raw.push(...(await callModel(ch.text, o, stats)));
  if (file) {
    await mkdir(o.cacheDir!, { recursive: true });
    await writeFile(file, JSON.stringify(raw, null, 1));
  }
  return raw;
}

/** Extract grounded claims from each file with bounded concurrency. Output order follows input order. */
export async function aiExtract(files: { file: string; content: string }[], o: AiOptions): Promise<{ claims: Claim[]; stats: AiStats }> {
  const stats: AiStats = { model: o.model, files: files.length, cacheHits: 0, proposed: 0, rejected: 0, accepted: 0, promptTokens: 0, completionTokens: 0 };
  const per: Claim[][] = files.map(() => []);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < files.length; i = next++) {
      const raw = await rawClaimsFor(files[i].content, o, stats);
      const g = groundClaims(files[i].file, files[i].content, raw);
      stats.proposed += raw.length;
      stats.rejected += g.rejected;
      stats.accepted += g.claims.length;
      per[i] = g.claims;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 4, files.length)) }, worker));
  return { claims: per.flat(), stats };
}
