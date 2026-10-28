import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRawClaim, groundClaims, mergeClaims, aiExtract } from "../src/ai.js";
import { extractClaims } from "../src/extract.js";
import { run } from "../src/run.js";
import { Docs, loadOpenApi, loadCliTree, type Sources } from "../src/sources.js";
import { main } from "../src/main.js";

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (p: string) => path.join(FX, p);
const sources = (): Sources => ({ openapi: () => loadOpenApi(fx("openapi.json")), cli: () => loadCliTree({ tree: fx("cli-tree.json") }), docs: new Docs(fx("docs")) });

const MD = [
  "# Skill", // 1
  "", // 2
  "The default rate limit is 2 calls per second.", // 3 (regex misses "calls")
  "", // 4
  "```ts", // 5
  'await fetch("https://api.resend.com/gizmos");', // 6 (regex ignores non-shell fences)
  "```", // 7
  "", // 8
  "Send with `POST /emails`.", // 9 (regex finds it too)
].join("\n");

const blank = { per_second: null, statuses: [], error_codes: [], method: null, path: null, command: null, url: null };
const modelClaims = [
  { ...blank, kind: "rate_limit", line: 3, quote: "rate limit is 2 calls per second", per_second: 2 },
  { ...blank, kind: "endpoint", line: 6, quote: 'fetch("https://api.resend.com/gizmos")', method: "GET", path: "/gizmos" },
  { ...blank, kind: "endpoint", line: 9, quote: "`POST /emails`", method: "POST", path: "/emails" },
  // hallucinations:
  { ...blank, kind: "rate_limit", line: 3, quote: "limit is 99 calls per second", per_second: 99 },
  { ...blank, kind: "endpoint", line: 9, quote: "`POST /emails`", method: "POST", path: "/invented" },
  { ...blank, kind: "doc_link", line: 9, quote: "Send with", url: "https://resend.com/docs/made-up" },
  { ...blank, kind: "rate_limit", line: 400, quote: "x", per_second: 2 },
];

function mockFetch(claims: unknown[] = modelClaims, status = 200, body?: unknown) {
  const calls: { url: string; init: any }[] = [];
  const f = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const payload = body ?? { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ claims }) } }] };
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}

const opts = (f: typeof fetch, cacheDir?: string) => ({ apiKey: "test-key-123", model: "test-model", fetch: f, cacheDir, retryDelayMs: 1 });

describe("ai extraction", () => {
  it("parses model output against a schema", () => {
    expect(parseRawClaim(modelClaims[0])?.per_second).toBe(2);
    expect(parseRawClaim({ kind: "nonsense", line: 1, quote: "x" })).toBeUndefined();
    expect(parseRawClaim({ ...modelClaims[0], line: "3" })).toBeUndefined();
    expect(parseRawClaim({ ...modelClaims[0], statuses: ["401"] })).toBeUndefined();
    expect(parseRawClaim(null)).toBeUndefined();
  });

  it("drops hallucinated quotes, values not on the line, and bad line numbers", () => {
    const { claims, rejected } = groundClaims("a.md", MD, modelClaims);
    expect(claims.map((c) => `${c.kind}@${c.line}`)).toEqual(["rate_limit@3", "endpoint@6", "endpoint@9"]);
    expect(rejected).toBe(4);
    expect(claims.every((c) => c.ai)).toBe(true);
    expect(claims[0]).toMatchObject({ perSecond: 2, text: "The default rate limit is 2 calls per second." });
  });

  it("drops the reader's own app routes and responses (not Resend claims)", () => {
    const md = "app.post('/webhooks/resend', (req, res) => {\nreturn new Response('x', { status: 400 });\nPOST https://api.resend.com/webhooks\n";
    const q = (line: number, quote: string, o: object) => ({ ...blank, line, quote, ...o });
    const { claims } = groundClaims("a.md", md, [
      q(1, "app.post('/webhooks/resend'", { kind: "endpoint", method: "POST", path: "/webhooks/resend" }),
      q(2, "{ status: 400 }", { kind: "status", statuses: [400] }),
      q(3, "POST https://api.resend.com/webhooks", { kind: "endpoint", method: "POST", path: "/webhooks" }),
    ]);
    expect(claims.map((c) => `${c.kind}@${c.line}`)).toEqual(["endpoint@3"]);
  });

  it("merges with regex claims, deduping by file+line+kind+value", () => {
    const regex = extractClaims("a.md", MD);
    const ai = groundClaims("a.md", MD, modelClaims).claims;
    const m = mergeClaims(regex, ai);
    expect(m.aiOnly).toBe(2); // rate limit in prose + endpoint in ts fence; `POST /emails` deduped
    expect(m.claims.filter((c) => c.kind === "endpoint" && c.line === 9)).toHaveLength(1);
    expect(mergeClaims(m.claims, ai).aiOnly).toBe(0);
  });

  it("sends numbered lines with the key and model, and caches by content+model", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sc-ai-"));
    const cache = path.join(dir, "cache");
    const { f, calls } = mockFetch();
    const r1 = await aiExtract([{ file: "a.md", content: MD }], opts(f, cache));
    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers.authorization).toBe("Bearer test-key-123");
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.model).toBe("test-model");
    expect(sent.messages[1].content).toContain("3: The default rate limit is 2 calls per second.");
    expect(r1.stats).toMatchObject({ proposed: 7, accepted: 3, rejected: 4, cacheHits: 0 });
    const r2 = await aiExtract([{ file: "a.md", content: MD }], opts(f, cache));
    expect(calls).toHaveLength(1); // served from cache
    expect(r2.stats.cacheHits).toBe(1);
    expect(r2.claims).toEqual(r1.claims);
    await aiExtract([{ file: "a.md", content: MD }], { ...opts(f, cache), model: "other" });
    expect(calls).toHaveLength(2); // model is part of the key
    expect(readdirSync(cache)).toHaveLength(2);
    expect(JSON.stringify(readdirSync(cache))).not.toContain("test-key");
  });

  it("limits concurrency", async () => {
    let active = 0, peak = 0;
    const f = (async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"claims":[]}' } }] }));
    }) as typeof fetch;
    const files = Array.from({ length: 10 }, (_, i) => ({ file: `f${i}.md`, content: `text ${i}` }));
    await aiExtract(files, { ...opts(f), concurrency: 4 });
    expect(peak).toBe(4);
  });

  it("surfaces API errors without leaking the key", async () => {
    const { f } = mockFetch([], 401, { error: { message: "Incorrect API key provided: test-key-123" } });
    await expect(aiExtract([{ file: "a.md", content: MD }], opts(f))).rejects.toThrow(/HTTP 401.*\[redacted\]/);
    const bad = mockFetch([], 200, { choices: [{ message: { content: "not json" } }] });
    await expect(aiExtract([{ file: "a.md", content: MD }], opts(bad.f))).rejects.toThrow(/unparseable/);
  });
});

describe("--ai in run/main", () => {
  const withFile = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sc-ai-"));
    const file = path.join(dir, "skill.md");
    writeFileSync(file, MD);
    return { dir, file };
  };

  it("AI-only claims flow into the deterministic checkers and are flagged [ai]", async () => {
    const { file, dir } = withFile();
    const { f } = mockFetch();
    const base = await run({ targets: [file], sources: sources(), cwd: dir });
    const r = await run({ targets: [file], sources: sources(), cwd: dir, ai: opts(f) });
    expect(r.ai).toMatchObject({ regexClaims: base.claims.length, aiOnly: 2, model: "test-model" });
    expect(r.claims).toHaveLength(base.claims.length + 2);
    expect(base.findings.some((x) => x.message.includes("/gizmos"))).toBe(false);
    const aiFindings = r.findings.filter((x) => x.ai);
    expect(aiFindings.map((x) => `${x.checker}@${x.line}`).sort()).toEqual(["endpoints@6", "rate-limits@3"]);
    expect(aiFindings[0].expected).toBeTruthy(); // from the docs/OpenAPI lookup, not the model
    expect(r.findings.filter((x) => !x.ai)).toHaveLength(base.findings.length);
  });

  it("without --ai nothing calls the network", async () => {
    const { file, dir } = withFile();
    const r = await run({ targets: [file], sources: sources(), cwd: dir });
    expect(r.ai).toBeUndefined();
    expect(r.findings.some((x) => x.ai)).toBe(false);
  });

  it("--ai without OPENAI_API_KEY exits 2 with a clear error and makes no request", async () => {
    const { file } = withFile();
    const { f, calls } = mockFetch();
    const err: string[] = [];
    const code = await main([file, "--ai", "--report", "none"], { out: () => {}, err: (s) => err.push(s), env: {}, fetch: f });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("--ai needs OPENAI_API_KEY");
    expect(calls).toHaveLength(0);
  });

  it("--ai end to end via main uses SKILLCHECK_AI_MODEL and reports [ai] findings", async () => {
    const { file, dir } = withFile();
    const { f, calls } = mockFetch();
    const out: string[] = [];
    const code = await main(
      [file, "--ai", "--ai-cache", path.join(dir, "c"), "--report", "none", "--openapi", fx("openapi.json"), "--docs", fx("docs"), "--cli-tree", fx("cli-tree.json")],
      { out: (s) => out.push(s), err: (s) => out.push(s), env: { OPENAI_API_KEY: "test-key-123", SKILLCHECK_AI_MODEL: "my-model" }, fetch: f },
    );
    expect(code).toBe(1);
    expect(JSON.parse(calls[0].init.body).model).toBe("my-model");
    const text = out.join("\n");
    expect(text).toContain("found only by AI");
    expect(text).toMatch(/\[endpoints\] \[ai\]/);
    expect(text).not.toContain("test-key");
  });
});
