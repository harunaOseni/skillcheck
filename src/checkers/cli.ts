import type { Claim, Finding, CheckerResult } from "../types.js";
import { type Sources, type CliNode, childOf, optionSet } from "../sources.js";

const BUILTIN = new Set(["--help", "-h", "--version", "-V", "-v"]);
const PLACEHOLDER = /^(<.*>|\[.*\]|\.\.\.|\$.*|\{.*\}|.*\.\.\.|[A-Z_]+|.*[/.@:].*|\d.*|[0-9a-f-]{8,})$/;

interface Walk {
  node: CliNode;
  path: string[];
  inherited: Set<string>;
  badToken?: string;
  rest: string[];
}

/** Descend through subcommands as far as tokens match. */
function walk(root: CliNode, tokens: string[]): Walk {
  let node = root;
  const inherited = new Set(optionSet(root));
  const pathArr: string[] = [];
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("-")) {
      // flag between subcommands: skip (value tokens are handled loosely)
      continue;
    }
    const next = childOf(node, t);
    if (next) {
      node = next;
      pathArr.push(next.name);
      optionSet(next).forEach((o) => inherited.add(o));
      continue;
    }
    if (node.subcommands.length && /^[a-z][a-z0-9-]*$/.test(t) && !PLACEHOLDER.test(t)) {
      // is previous token a flag that takes a value? then this is its value
      const prev = tokens[i - 1];
      const prevTakes = prev?.startsWith("-") && !prev.includes("=");
      if (!prevTakes) return { node, path: pathArr, inherited, badToken: t, rest: tokens.slice(i) };
    }
  }
  return { node, path: pathArr, inherited, rest: [] };
}

/** Flag is valid on node, or (default-subcommand heuristic) on one of its direct children. */
function flagOk(w: Walk, flag: string): boolean {
  if (BUILTIN.has(flag) || w.inherited.has(flag)) return true;
  return w.node.subcommands.some((s) => optionSet(s).includes(flag));
}

export async function checkCli(claims: Claim[], src: Sources): Promise<CheckerResult> {
  const checker = "cli";
  if (!src.cli) return { checker, findings: [], checked: 0, skipped: "no CLI source (--cli-tree / --cli-repo / --cli-bin)" };
  let cli;
  try {
    cli = await src.cli();
  } catch (e) {
    return { checker, findings: [], checked: 0, skipped: `cannot load CLI tree: ${(e as Error).message.split("\n")[0]}` };
  }
  const findings: Finding[] = [];
  let checked = 0;
  const add = (c: Claim, message: string, expected: string, severity: Finding["severity"] = "error") =>
    findings.push({ checker, severity, file: c.file, line: c.line, claim: c.text, message, expected, source: cli.label });

  for (const c of claims) {
    if (c.kind === "cli_command") {
      checked++;
      const toks = c.tokens.slice(1);
      const w = walk(cli.root, toks);
      if (w.badToken) {
        const where = ["resend", ...w.path].join(" ");
        add(c, `\`${where} ${w.badToken}\` - unknown subcommand`, `${where} subcommands: ${w.node.subcommands.map((s) => s.name).join(", ")}`);
        continue;
      }
      for (const t of toks) {
        if (!t.startsWith("-") || t === "-" || t === "--") continue;
        const flag = t.split("=")[0];
        if (!/^--?[A-Za-z][\w-]*$/.test(flag)) continue;
        if (flagOk(w, flag)) continue;
        add(c, `\`${["resend", ...w.path].join(" ")}\` has no flag \`${flag}\``, `flags: ${[...w.inherited].filter((x) => x.startsWith("--")).sort().join(" ")}`);
      }
    } else if (c.kind === "cli_flag") {
      const w = walk(cli.root, c.command);
      if (w.badToken || w.path.length !== c.command.length) continue; // heading is not a command path
      checked++;
      for (const f of c.flags) {
        if (flagOk(w, f)) continue;
        add(c, `\`resend ${w.path.join(" ")}\` has no flag \`${f}\``, `flags: ${[...w.inherited].filter((x) => x.startsWith("--")).sort().join(" ")}`);
      }
    } else if (c.kind === "cli_group") {
      const w = walk(cli.root, c.command);
      if (w.badToken || w.path.length !== c.command.length) {
        checked++;
        add(c, `command group \`resend ${c.command.join(" ")}\` does not exist`, "a command in the CLI tree");
        continue;
      }
      checked++;
      for (const s of c.subcommands) {
        if (!childOf(w.node, s)) add(c, `\`resend ${c.command.join(" ")}\` has no subcommand \`${s}\``, `subcommands: ${w.node.subcommands.map((x) => x.name).join(", ")}`);
      }
    }
  }
  return { checker, findings, checked };
}
