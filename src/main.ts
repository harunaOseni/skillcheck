import { parseArgs } from "node:util";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { run } from "./run.js";
import { Docs, loadOpenApi, loadCliTree, type Sources } from "./sources.js";
import { terminalReport, markdownReport, jsonReport } from "./report.js";
import { CHECKERS } from "./checkers/index.js";

export const DEFAULT_OPENAPI = "https://raw.githubusercontent.com/resend/resend-openapi/main/resend.json";
export const DEFAULT_DOCS = "https://resend.com/docs";

const HELP = `skillcheck - lint agent skill files for factual drift

Usage: skillcheck [paths...] [options]

  paths                 files/dirs of markdown to lint (default: .)

Sources of truth:
  --openapi <path|url>  OpenAPI JSON (default: ${DEFAULT_OPENAPI})
  --docs <url|dir>      docs base with llms.txt + .md pages (default: ${DEFAULT_DOCS})
  --cli-repo <dir>      resend-cli checkout (deps installed); runs \`commands --json\` from source
  --cli-bin <cmd>       installed CLI to run, e.g. "resend" (runs \`<cmd> commands --json\`)
  --cli-tree <file>     pre-dumped \`resend commands --json\` output

Output:
  --json                print JSON instead of the terminal report
  --report <file>       write markdown report (default: skillcheck-report.md; "none" to disable)
  --fail-on <level>     error (default) | warn | never
  --strict              exit 2 if any checker had to be skipped (missing source)
  --only <a,b>          run only these checkers (${Object.keys(CHECKERS).join(", ")})
  --skip <a,b>          skip these checkers
  --config <file>       JSON {"ignore":[{checker,file,claim,reason}]} (default: ./skillcheck.config.json if present)
  --no-color
  -h, --help

Exit codes: 0 clean, 1 drift found, 2 usage/source error.
`;

export async function main(argv: string[], io = { out: (s: string) => console.log(s), err: (s: string) => console.error(s) }): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        openapi: { type: "string" }, docs: { type: "string" }, "cli-repo": { type: "string" }, "cli-bin": { type: "string" }, "cli-tree": { type: "string" },
        json: { type: "boolean" }, report: { type: "string" }, "fail-on": { type: "string" }, strict: { type: "boolean" },
        only: { type: "string" }, config: { type: "string" }, skip: { type: "string" }, "no-color": { type: "boolean" }, help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    io.err((e as Error).message + "\n" + HELP);
    return 2;
  }
  const v = parsed.values;
  if (v.help) {
    io.out(HELP);
    return 0;
  }
  const failOn = v["fail-on"] ?? "error";
  if (!["error", "warn", "never"].includes(failOn)) {
    io.err(`--fail-on must be error|warn|never`);
    return 2;
  }
  const sources: Sources = {
    openapi: (() => {
      let p: ReturnType<typeof loadOpenApi> | undefined;
      return () => (p ??= loadOpenApi(v.openapi ?? DEFAULT_OPENAPI));
    })(),
    docs: new Docs(v.docs ?? DEFAULT_DOCS),
  };
  if (v["cli-tree"] || v["cli-repo"] || v["cli-bin"]) {
    let p: ReturnType<typeof loadCliTree> | undefined;
    sources.cli = () => (p ??= loadCliTree({ tree: v["cli-tree"], repo: v["cli-repo"], bin: v["cli-bin"] }));
  }
  const list = (s?: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
  let result;
  try {
    const cfgPath = v.config ?? (existsSync("skillcheck.config.json") ? "skillcheck.config.json" : undefined);
    const cfg = cfgPath ? JSON.parse(await readFile(cfgPath, "utf8")) : {};
    result = await run({ ignore: cfg.ignore, targets: parsed.positionals.length ? parsed.positionals : ["."], sources, only: list(v.only), skip: list(v.skip) });
  } catch (e) {
    io.err(`skillcheck: ${(e as Error).message}`);
    return 2;
  }
  const reportPath = v.report ?? "skillcheck-report.md";
  if (reportPath !== "none") await writeFile(reportPath, markdownReport(result));
  io.out(v.json ? jsonReport(result) : terminalReport(result, !v["no-color"] && !!process.stdout.isTTY));
  if (!v.json && reportPath !== "none") io.out(`\nMarkdown report written to ${reportPath}`);
  const errors = result.findings.some((f) => f.severity === "error");
  const warns = result.findings.some((f) => f.severity === "warn");
  if (v.strict && result.results.some((r) => r.skipped)) return 2;
  if (failOn === "never") return 0;
  return errors || (failOn === "warn" && warns) ? 1 : 0;
}
