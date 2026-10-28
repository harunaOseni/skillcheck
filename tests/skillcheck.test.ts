import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, readFileSync as rf } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractClaims, normalizePath, parseCliLine } from "../src/extract.js";
import { run } from "../src/run.js";
import { Docs, parseOpenApi, parseDocsErrors, parseDocsRateLimit, loadOpenApi, loadCliTree, type Sources } from "../src/sources.js";
import { main } from "../src/main.js";

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (p: string) => path.join(FX, p);

const sources = (): Sources => ({
  openapi: () => loadOpenApi(fx("openapi.json")),
  cli: () => loadCliTree({ tree: fx("cli-tree.json") }),
  docs: new Docs(fx("docs")),
});

const claimsOf = (name: string) => extractClaims(name, readFileSync(fx(`skills/${name}`), "utf8"));

describe("extractor", () => {
  it("extracts rate limits with file:line", () => {
    const rl = claimsOf("drifted.md").filter((c) => c.kind === "rate_limit");
    expect(rl.map((c) => [c.line, (c as any).perSecond])).toEqual([[3, 2], [7, 2]]);
  });
  it("extracts status+error-code table rows and bullet statuses", () => {
    const st = claimsOf("drifted.md").filter((c) => c.kind === "status") as any[];
    expect(st.find((c) => c.errorCodes.includes("authentication_error"))?.statuses).toEqual([401]);
    expect(st.some((c) => c.statuses[0] === 418)).toBe(true);
  });
  it("normalises endpoint params and finds curl calls", () => {
    expect(normalizePath("/emails/:id/cancel")).toBe("/emails/{}/cancel");
    expect(normalizePath("/segments/<segment_id>/contacts")).toBe("/segments/{}/contacts");
    expect(normalizePath("/logs/37e4414c-5e25-4dbc-a071-43552a4bd53b")).toBe("/logs/{}");
    const eps = claimsOf("drifted.md").filter((c) => c.kind === "endpoint") as any[];
    expect(eps.map((e) => `${e.method} ${e.path}`)).toEqual(
      expect.arrayContaining(["POST /emails", "GET /emails/{}/cancel", "DELETE /widgets/{}", "POST /emails/batch", "GET /gizmos"]),
    );
  });
  it("parses CLI lines, quotes and pipes", () => {
    expect(parseCliLine('$ resend emails send --subject "Hi there" --text x | jq .')).toEqual(["resend", "emails", "send", "--subject", "Hi there", "--text", "x"]);
    expect(parseCliLine("curl x")).toBeNull();
  });
  it("ignores claims inside non-shell fences except sdk/doc links", () => {
    const c = extractClaims("x.md", "```ts\nresend emails send --nope\nresend.emails.send({})\n```\n");
    expect(c.filter((x) => x.kind === "cli_command")).toHaveLength(0);
    expect(c.filter((x) => x.kind === "sdk")).toHaveLength(1);
  });
});

describe("source parsers", () => {
  it("parses docs rate limit and errors", () => {
    expect(parseDocsRateLimit("is **10 requests per second per team**")).toBe(10);
    const e = parseDocsErrors(readFileSync(fx("docs/api-reference/errors.md"), "utf8"));
    expect([...e.get("rate_limit_exceeded")!]).toEqual([429]);
  });
  it("parses openapi", () => {
    const api = parseOpenApi(JSON.parse(readFileSync(fx("openapi.json"), "utf8")), "t");
    expect([...api.paths.get("/emails/{}")!]).toEqual(["GET"]);
  });
});

describe("checkers (fixtures)", () => {
  it("rate limits: flags 2 req/s vs docs 10", async () => {
    const r = await run({ targets: [fx("skills/drifted.md")], sources: sources(), only: ["rate-limits"], cwd: FX });
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0].message).toContain("docs say the default is 10");
    expect(r.findings[0].line).toBe(3);
  });
  it("status codes: unknown error code, wrong status, undocumented status", async () => {
    const r = await run({ targets: [fx("skills/drifted.md")], sources: sources(), only: ["status-codes"], cwd: FX });
    const msgs = r.findings.map((f) => f.message).join("\n");
    expect(msgs).toContain("`authentication_error` does not exist");
    expect(msgs).toContain("listed with HTTP 403 but docs say 409");
    expect(msgs).toContain("HTTP 418 is not documented");
    expect(r.findings.some((f) => f.message.includes("`invalid_idempotent_request`") && f.line === 12)).toBe(false); // 409 row is correct
  });
  it("endpoints: unknown path, wrong method, sdk resource", async () => {
    const r = await run({ targets: [fx("skills/drifted.md")], sources: sources(), only: ["endpoints"], cwd: FX });
    const msgs = r.findings.map((f) => f.message);
    expect(msgs.some((m) => m.startsWith("GET /emails/{}/cancel - method not defined"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("DELETE /widgets/{}"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("GET /gizmos"))).toBe(true);
    expect(msgs.some((m) => m.includes("resend.widgets"))).toBe(true);
    expect(msgs.some((m) => m.includes("resend.batch"))).toBe(false); // alias for /emails/batch
    expect(msgs.some((m) => m.startsWith("POST /emails/batch"))).toBe(false);
  });
  it("cli: typo flags, unknown subcommand, bad table flag, bad group member", async () => {
    const r = await run({ targets: [fx("skills/drifted.md")], sources: sources(), only: ["cli"], cwd: FX });
    const msgs = r.findings.map((f) => f.message).join("\n");
    expect(msgs).toContain("no flag `--regoin`");
    expect(msgs).toContain("unknown subcommand");
    expect(msgs).toContain("no flag `--nope`");
    expect(msgs).toContain("no flag `--sparkles`");
    expect(msgs).toContain("no subcommand `teleport`");
    expect(msgs).not.toContain("`--json`"); // global flag
  });
  it("doc links: dead link flagged, indexed link OK", async () => {
    const r = await run({ targets: [fx("skills/drifted.md")], sources: sources(), only: ["doc-links"], cwd: FX });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].claim).toContain("does/not-exist");
  });
  it("clean skill has zero findings", async () => {
    const r = await run({ targets: [fx("skills/clean.md")], sources: sources(), cwd: FX });
    expect(r.findings).toEqual([]);
  });
  it("ignore rules suppress findings", async () => {
    const r = await run({ targets: [fx("skills/drifted.md")], sources: sources(), only: ["rate-limits"], cwd: FX, ignore: [{ checker: "rate-limits", claim: "2 req/s" }] });
    expect(r.findings).toHaveLength(1);
    expect(r.ignored).toHaveLength(1);
  });
  it("missing source => skipped, not failed", async () => {
    const r = await run({ targets: [fx("skills/drifted.md")], sources: { docs: new Docs(fx("docs")) }, only: ["cli", "endpoints"], cwd: FX });
    expect(r.results.every((x) => x.skipped)).toBe(true);
  });
});

describe("CLI entry (main)", () => {
  const args = (...t: string[]) => ["--openapi", fx("openapi.json"), "--docs", fx("docs"), "--cli-tree", fx("cli-tree.json"), ...t];
  const io = () => {
    const out: string[] = [];
    return { out, io: { out: (s: string) => out.push(s), err: (s: string) => out.push(s) } };
  };
  it("exits 1 on drift and writes a markdown report", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sc-"));
    const rep = path.join(dir, "r.md");
    const { out, io: i } = io();
    const code = await main([fx("skills/drifted.md"), ...args("--report", rep)], i);
    expect(code).toBe(1);
    const md = rf(rep, "utf8");
    expect(md).toContain("| error |");
    expect(md).toContain("drifted.md:3");
    expect(out.join("\n")).toContain("error(s)");
  });
  it("exits 0 on clean input", async () => {
    const { io: i } = io();
    expect(await main([fx("skills/clean.md"), ...args("--report", "none")], i)).toBe(0);
  });
  it("--json emits parseable JSON; --fail-on never forces exit 0", async () => {
    const { out, io: i } = io();
    const code = await main([fx("skills/drifted.md"), ...args("--report", "none", "--json", "--fail-on", "never")], i);
    expect(code).toBe(0);
    const j = JSON.parse(out.join("\n"));
    expect(j.findings.length).toBeGreaterThan(5);
    expect(j.findings[0]).toHaveProperty("file");
  });
  it("--strict exits 2 when a source is missing", async () => {
    const { io: i } = io();
    const code = await main([fx("skills/clean.md"), "--openapi", fx("openapi.json"), "--docs", fx("docs"), "--report", "none", "--strict"], i);
    expect(code).toBe(2);
  });
  it("bad flag => exit 2", async () => {
    const { io: i } = io();
    expect(await main(["--bogus"], i)).toBe(2);
  });
});
