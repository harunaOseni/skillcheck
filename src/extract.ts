import type { Claim } from "./types.js";

const SHELL_LANGS = new Set(["", "bash", "sh", "shell", "zsh", "console", "terminal", "text"]);

/** Split a markdown table row into cells (respecting `\|`). */
export function splitRow(line: string): string[] {
  const t = line.trim().replace(/\\\|/g, "\u0000");
  const inner = t.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((c) => c.replace(/\u0000/g, "|").trim());
}

const stripTicks = (s: string) => s.replace(/`/g, "").trim();

/** Normalise `:id`, `<id>`, `{id}`, `${id}` path params to `{}`. */
export function normalizePath(p: string): string {
  let out = p.split("?")[0].split("#")[0];
  out = out.replace(/\$\{[^}]*\}/g, "{}").replace(/\{[^}]*\}/g, "{}").replace(/<[^>]*>/g, "{}").replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "{}");
  out = out.replace(/[.,;:)\]'"`]+$/, "");
  // literal UUIDs in examples are path params too
  out = out.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, "/{}");
  if (out.length > 1) out = out.replace(/\/+$/, "");
  return out;
}

/** Tokenise a shell-ish line (quotes respected). */
export function shellTokens(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function cutShell(s: string): string {
  // stop at pipes/redirects/chaining outside of quotes (good enough for docs)
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "|" || c === ">" || c === ";" || (c === "&" && s[i + 1] === "&") || c === "#") return s.slice(0, i);
  }
  return s;
}

export function parseCliLine(raw: string): string[] | null {
  let s = raw.trim().replace(/^\$\s+/, "").replace(/\\$/, "").trim();
  s = s.replace(/^(?:npx|bunx|pnpx)\s+(?:-y\s+)?(?=resend\b)/, "");
  if (!/^resend(\s|$)/.test(s)) return null;
  const toks = shellTokens(cutShell(s));
  return toks.length > 1 ? toks : null;
}

const RATE_RE = /(\d[\d,]*)\s*(?:req(?:uest)?s?)\s*(?:\/|per\s+|a\s+|each\s+)\s*(?:s\b|sec\b|second)/gi;
const ENDPOINT_RE = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9_\-/{}:<>.${}]*)/g;
const DOC_LINK_RE = /https?:\/\/resend\.com\/docs\/[^\s)>\]"'`,]+/g;
const SDK_RE = /\bresend\.([A-Za-z]+)\.([A-Za-z_]+)\(/g;

/** Resolve a heading like "domains create" / "`resend domains create`" to words. */
function headingWords(h: string): string[] {
  return stripTicks(h).replace(/^resend\s+/, "").split(/\s+/).filter(Boolean);
}

export function extractClaims(file: string, content: string): Claim[] {
  const claims: Claim[] = [];
  const lines = content.split(/\r?\n/);
  let fence: { marker: string; lang: string } | null = null;
  let heading: string[] = [];
  let tableHeader: string[] | null = null;
  let pendingCurl: { line: number; text: string } | null = null;

  const push = (c: Claim) => claims.push(c);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    const text = raw.trim();

    const fm = /^(\s*)(```+|~~~+)\s*([A-Za-z0-9_+-]*)/.exec(raw);
    if (fm) {
      if (!fence) fence = { marker: fm[2][0], lang: fm[3].toLowerCase() };
      else if (fm[2][0] === fence.marker) {
        fence = null;
        pendingCurl = null;
      }
      continue;
    }

    if (fence) {
      if (!SHELL_LANGS.has(fence.lang) && !["http", "curl"].includes(fence.lang)) {
        // other languages: SDK calls + curl-in-strings are out of scope; still scan sdk + doc links
        scanSdk(raw, lineNo, text, file, push);
        scanDocLinks(raw, lineNo, text, file, push);
        continue;
      }
      // join backslash continuations
      if (pendingCurl) {
        pendingCurl.text += " " + text.replace(/\\$/, "");
        if (!/\\\s*$/.test(raw)) {
          emitCurl(pendingCurl.text, pendingCurl.line, file, push);
          pendingCurl = null;
        }
        continue;
      }
      const stripped = text.replace(/^\$\s+/, "");
      if (/^curl\b/.test(stripped)) {
        if (/\\\s*$/.test(raw)) {
          pendingCurl = { line: lineNo, text: stripped.replace(/\\$/, "") };
        } else emitCurl(stripped, lineNo, file, push);
        continue;
      }
      const cli = parseCliLine(text);
      if (cli) push({ kind: "cli_command", file, line: lineNo, text, tokens: cli });
      const ep = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)/.exec(text);
      if (ep) push({ kind: "endpoint", file, line: lineNo, text, method: ep[1], path: normalizePath(ep[2]) });
      scanDocLinks(raw, lineNo, text, file, push);
      continue;
    }

    // ---- prose / tables ----
    const hm = /^#{1,6}\s+(.*)$/.exec(raw);
    if (hm) heading = headingWords(hm[1]);

    const isRow = text.startsWith("|");
    if (isRow) {
      const next = lines[i + 1] ?? "";
      if (/^\s*\|?\s*:?-{2,}/.test(next) && !tableHeader) tableHeader = splitRow(text).map((c) => stripTicks(c).toLowerCase());
    } else if (text === "") {
      // blank line keeps no table state
      tableHeader = null;
    } else tableHeader = null;

    // rate limits
    for (const m of text.matchAll(RATE_RE)) {
      if (!/rate|limit|throttl/i.test(text)) continue;
      push({ kind: "rate_limit", file, line: lineNo, text, perSecond: Number(m[1].replace(/,/g, "")) });
    }

    // status codes
    if (isRow && !/^\s*\|?\s*:?-{2,}/.test(text)) {
      const cells = splitRow(text);
      const first = stripTicks(cells[0] ?? "");
      if (/^[1-5]\d\d(\s*(,|\/|-)\s*[1-5]\d\d)*$/.test(first)) {
        const statuses = [...first.matchAll(/[1-5]\d\d/g)].map((m) => Number(m[0]));
        const codes = [...cells.slice(1).join(" | ").matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]);
        push({ kind: "status", file, line: lineNo, text, statuses, errorCodes: codes });
      }
    } else if (!isRow) {
      const li = /^\s*(?:[-*]\s+)([45]\d\d)\s*[-–:]\s/.exec(raw);
      const inline = [...text.matchAll(/\b([45]\d\d)\b[^`\n]{0,40}`([a-z]+(?:_[a-z]+)+)`/g)];
      if (li) {
        const codes = [...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]);
        push({ kind: "status", file, line: lineNo, text, statuses: [Number(li[1])], errorCodes: codes });
      } else if (inline.length) {
        for (const m of inline) push({ kind: "status", file, line: lineNo, text, statuses: [Number(m[1])], errorCodes: [m[2]] });
      }
    }

    // endpoints in prose / tables / inline code
    if (!isRow || true) {
      for (const m of text.matchAll(ENDPOINT_RE)) {
        const p = normalizePath(m[2]);
        if (p === "/" || p.length < 2) continue;
        push({ kind: "endpoint", file, line: lineNo, text, method: m[1], path: p });
      }
      for (const m of text.matchAll(/`([^`]*\bresend\s[^`]*)`/g)) {
        const cli = parseCliLine(m[1]);
        if (cli) push({ kind: "cli_command", file, line: lineNo, text, tokens: cli });
      }
    }

    // CLI flag tables under "## domains create" style headings
    if (isRow && tableHeader && /^(flag|option)s?$/.test(tableHeader[0] ?? "") && !/^\s*\|?\s*:?-{2,}/.test(text)) {
      const cell0 = splitRow(text)[0] ?? "";
      const flags = [...cell0.matchAll(/--[a-z0-9][a-z0-9-]*/gi)].map((m) => m[0]);
      if (flags.length && heading.length) push({ kind: "cli_flag", file, line: lineNo, text, command: heading, flags });
    }

    // CLI command-group tables: | `emails` | send, get, list |
    if (isRow && tableHeader && /command/.test(tableHeader[0] ?? "") && !/^\s*\|?\s*:?-{2,}/.test(text)) {
      const cells = splitRow(text);
      const cmd = /^`([a-z][a-z -]*)`/.exec(cells[0] ?? "");
      if (cmd && cells[1]) {
        let desc = cells[1].split(/\s+[—–]\s+/)[0].replace(/\([^)]*\)/g, "").trim();
        const items = desc.split(",").map((s) => s.trim());
        if (items.length >= 2 && items.every((s) => /^[a-z][a-z-]*$/.test(s)))
          push({ kind: "cli_group", file, line: lineNo, text, command: cmd[1].trim().split(/\s+/), subcommands: items });
      }
    }

    scanSdk(raw, lineNo, text, file, push);
    scanDocLinks(raw, lineNo, text, file, push);
  }
  return claims;
}

function emitCurl(cmd: string, line: number, file: string, push: (c: Claim) => void) {
  const url = /https?:\/\/api\.resend\.com(\/[^\s'"\\]*)/.exec(cmd);
  if (!url) return;
  const x = /(?:-X|--request)\s+([A-Z]+)/.exec(cmd);
  const method = x ? x[1] : /(?:^|\s)(?:-d|--data(?:-raw|-binary)?|-F|--form)\b/.test(cmd) ? "POST" : "GET";
  push({ kind: "endpoint", file, line, text: cmd.slice(0, 160), method, path: normalizePath(url[1]) });
}

function scanSdk(raw: string, line: number, text: string, file: string, push: (c: Claim) => void) {
  for (const m of raw.matchAll(SDK_RE)) push({ kind: "sdk", file, line, text, resource: m[1], method: m[2] });
}
function scanDocLinks(raw: string, line: number, text: string, file: string, push: (c: Claim) => void) {
  for (const m of raw.matchAll(DOC_LINK_RE)) push({ kind: "doc_link", file, line, text, url: m[0].replace(/[.)]+$/, "") });
}
