# SkillCheck

Lint agent skill files (`SKILL.md` + `references/*`) for **factual drift** against sources of truth. Built as a demo for Resend's
[`resend/resend-skills`](https://github.com/resend/resend-skills): it extracts concrete, checkable claims from the markdown and
verifies each one deterministically (no LLM, no API keys, public data only).

| Checker | Claims it extracts | Source of truth |
|---|---|---|
| `rate-limits` | "N req/s", "N requests per second" (on lines that mention rate/limit) | live docs `api-reference/rate-limit.md` (cross-ref `ai-onboarding.md`) |
| `status-codes` | `| 429 | ...|` table rows, `- 429 - ...` bullets, `409 \`invalid_idempotent_request\`` | live docs `api-reference/errors.md` (error code -> status), OpenAPI response codes |
| `endpoints` | `POST /emails`, `GET /segments/:id/contacts`, `curl ... api.resend.com/...`, `resend.<resource>.<fn>(` | OpenAPI `resend.json` (path + method; `:id`/`<id>`/`{id}`/UUID normalised) |
| `cli` | `resend ...` commands in code blocks / inline code, flag tables under `## domains create` headings, "Command Group" tables | `resend commands --json` (the CLI's own commander tree) |
| `doc-links` | `https://resend.com/docs/...` links | `llms.txt` (falls back to fetching `<page>.md`) |

## Install / run

```bash
git clone <this repo> && cd skillcheck && npm install && npm run build   # Node >= 20
# lint a skills checkout against live docs + live OpenAPI + the CLI built from source:
git clone https://github.com/resend/resend-cli && (cd resend-cli && npm install --ignore-scripts)
node dist/cli.js path/to/resend-skills/skills --cli-repo path/to/resend-cli
```

Defaults: OpenAPI from `raw.githubusercontent.com/resend/resend-openapi/main/resend.json`, docs from `https://resend.com/docs`.
Everything is overridable and can run offline from local files:

```
skillcheck [paths...] [--openapi <path|url>] [--docs <url|dir>]
           [--cli-repo <dir> | --cli-bin resend | --cli-tree <file>]
           [--json] [--report skillcheck-report.md|none] [--fail-on error|warn|never]
           [--strict] [--only a,b] [--skip a,b] [--config skillcheck.config.json]
```

* **Exit codes:** `0` clean, `1` drift found, `2` usage/source error (or `--strict` with a skipped checker).
* **Outputs:** terminal report, markdown report (`skillcheck-report.md`, with `file:line`, claim, problem, expected, source, severity), `--json`.
* A checker whose source is unavailable is reported as `SKIPPED` (never silently passes). Use `--strict` in CI to make that fatal.
* `skillcheck.config.json` can suppress known false positives: `{"ignore":[{"checker":"endpoints","claim":"GET /careers","reason":"..."}]}`.
* `--cli-repo` runs `npx tsx src/cli.ts commands --json` inside the CLI checkout with telemetry disabled; no network calls to Resend's API.

### GitHub Action

[`.github/workflows/skillcheck.yml`](.github/workflows/skillcheck.yml) runs on PRs touching `skills/**` and weekly (docs drift happens
with no skills PR), checks out `resend-cli`, runs skillcheck with `--strict`, and publishes the report to the job summary and as an artifact.
Replace `OWNER` in the install step once the repo is published.

## Tests

`npm test` - Vitest, 20 tests, fixtures in `tests/fixtures` (a drifted and a clean skill file, mini OpenAPI, mini CLI tree, mini docs).
They cover the extractor, each checker (true positives and no-false-positive cases), report/JSON/exit codes, ignore rules and skipped sources.

## Findings on resend-skills today

Run on 2026-10-27 against fresh clones: `resend-skills@b2ae7b1`, `resend-openapi@69ea636`, `resend-cli@c7837f0` (v2.26.1), live docs.
Command (from the resend-skills checkout): `skillcheck skills --cli-repo ../resend-cli`. Raw output, exit code 1:

```
skillcheck: 64 files, 872 claims extracted
  rate-limits   2 checked, 2 finding(s)
  status-codes  50 checked, 4 finding(s)
  endpoints     325 checked, 1 finding(s)
  cli           478 checked, 0 finding(s)
  doc-links     14 checked, 0 finding(s)

error skills/resend-cli/references/careers.md:33  [endpoints]
      GET /careers/{} - path not found in OpenAPI spec
      claim:    | `--field <path=value>` | string | No | Answer to a job-specific question; repeatable. Paths are shown on the job posting page at resend.com/caree...
      expected: a path defined in resend.json
      source:   https://raw.githubusercontent.com/resend/resend-openapi/main/resend.json
error skills/resend/references/sending/best-practices.md:130  [status-codes]
      Error code `authentication_error` does not exist in the API error docs
      claim:    | 401 | `authentication_error` | Invalid API key | Check RESEND_API_KEY, don't retry |
      expected: a code from api-reference/errors.md (did you mean `application_error`?)
      source:   https://resend.com/docs/api-reference/errors.md
error skills/resend/references/sending/best-practices.md:131  [status-codes]
      Error code `authorization_error` does not exist in the API error docs
      claim:    | 403 | `authorization_error` | Domain not verified | Verify domain at resend.com/domains |
      expected: a code from api-reference/errors.md (did you mean `application_error`?)
      source:   https://resend.com/docs/api-reference/errors.md
error skills/resend/references/sending/best-practices.md:134  [status-codes]
      Error code `unprocessable_entity` does not exist in the API error docs
      claim:    | 422 | `unprocessable_entity` | Invalid email format/content | Fix content, don't retry |
      expected: a code from api-reference/errors.md
      source:   https://resend.com/docs/api-reference/errors.md
error skills/resend/references/sending/best-practices.md:136  [status-codes]
      Error code `api_error` does not exist in the API error docs
      claim:    | 500 | `api_error` | Server error | Retry with exponential backoff |
      expected: a code from api-reference/errors.md
      source:   https://resend.com/docs/api-reference/errors.md
error skills/resend/references/sending/overview.md:14  [rate-limits]
      Skill says 2 req/s; docs say the default is 10 req/s
      claim:    - Reducing API calls is important (by default, rate limit is 2 requests per second)
      expected: 10 requests per second (default, per team); ai-onboarding.md says 10
      source:   https://resend.com/docs/api-reference/rate-limit.md
error skills/resend/SKILL.md:280  [rate-limits]
      Skill says 2 req/s; docs say the default is 10 req/s
      claim:    | 429 | Rate limited — retry with exponential backoff (default rate limit: 2 req/s) |
      expected: 10 requests per second (default, per team); ai-onboarding.md says 10
      source:   https://resend.com/docs/api-reference/rate-limit.md

7 error(s), 0 warning(s)
```

Interpretation:

1. **Rate limit (real; matches [resend-skills#164](https://github.com/resend/resend-skills/issues/164)).** `skills/resend/SKILL.md:280` and
   `skills/resend/references/sending/overview.md:14` say 2 req/s; `api-reference/rate-limit.md` says "10 requests per second per team" and `ai-onboarding.md` also says 10.
2. **Error-code table in `references/sending/best-practices.md:130-136` (real, new as far as I know).** `authentication_error`, `authorization_error`,
   `unprocessable_entity`, `api_error` are not error names in the API errors docs (docs use e.g. `missing_api_key`/`restricted_api_key` for 401, `validation_error` for most 403/422 cases, `application_error` for 500).
   The rows that match docs (`validation_error`, `invalid_idempotency_key`, `invalid_idempotent_request`, `concurrent_idempotent_requests`, `rate_limit_exceeded`) pass.
3. **`GET /careers/<id>` in `resend-cli/references/careers.md:33` - false positive / spec gap.** The CLI really calls `/careers/${jobId}`
   (`resend-cli/src/commands/careers/apply.ts`), but the public OpenAPI spec doesn't define it. The skill is probably right; the spec is incomplete.

Nothing was found by the `cli` checker: 478 CLI claims (commands, flags in tables, command-group lists) all match the CLI's real command tree.
To show the checker is not vacuous, mutating one flag (`--region` -> `--regoin`) and one subcommand (`verify` -> `verfy`) in a copy of the CLI skill yields:

```
error resend-cli/references/domains.md:28  [cli]  `resend domains create` has no flag `--regoin`
error resend-cli/SKILL.md:196  [cli]  `resend domains verfy` - unknown subcommand
```

A ready-to-review (not submitted) fix for #164 is in [`patches/resend-skills-issue-164.patch`](patches/resend-skills-issue-164.patch)
(2 lines; `git am` it onto resend-skills). After applying it the rate-limit checker reports 0 findings.

## Limitations and false-positive notes (honest list)

* Heuristic extraction from markdown, not a semantic understanding. It checks *names and numbers*, not whether prose is correct.
* **Endpoints:** only paths in the public OpenAPI spec are known; real-but-unspecced endpoints (e.g. `/careers/{id}`) are flagged. Use the ignore config.
  Bare `METHOD /path` mentions in prose are assumed to be Resend API paths. `resend.batch.*` is aliased to `/emails/batch`; other SDK-method checks only validate the *resource* name, not the method.
* **CLI:** the command-tree JSON does not say which subcommand is the default, so a flag documented on a parent (`automations runs --status`) is accepted if any direct child has it
  (that case is genuinely valid because `list` is the default subcommand, but this also means a flag valid only on a non-default child would pass).
  Unknown-subcommand detection only fires for lowercase word tokens and skips anything that looks like a placeholder/ID. Only documented flags are checked; *undocumented* CLI flags are not reported.
* **Status codes:** only flags error *names* that don't exist, names paired with the wrong status, and undocumented 4xx/5xx statuses. It does not judge descriptions ("Rate limited" vs docs wording).
  Some docs error names legitimately map to several statuses (`validation_error`), and are handled as a set. Status checks need an adjacent status code on the same row/line to avoid flagging ordinary snake_case field names.
* **Rate limits:** only per-second default limits on lines mentioning rate/limit; it does not check plan-specific limits or quotas (daily/monthly).
* Docs are fetched live, so results can change as docs change (that is the point, but pin `--docs` to a dir for reproducible runs).
* Not covered: request/response field names and types against OpenAPI schemas, SDK method signatures, code samples compiled/run, non-English text.
