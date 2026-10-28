# SkillCheck

A fact-checker for AI agent skill files (`SKILL.md` and `references/*`). It pulls out the concrete claims a skill makes and checks each one against the product's own public sources. By default no AI and no API keys are involved, so results are the same every run.

Built as a demo for Resend's [`resend/resend-skills`](https://github.com/resend/resend-skills).

## What it checks

| Checker | Claims | Checked against |
|---|---|---|
| `rate-limits` | "N requests per second" | Resend docs |
| `status-codes` | error names and their HTTP status | Resend docs and OpenAPI |
| `endpoints` | `POST /emails`, curl calls, SDK calls | OpenAPI spec |
| `cli` | `resend ...` commands and flags | the CLI's own command list |
| `doc-links` | `resend.com/docs/...` links | `llms.txt` |

## Run it

```bash
npm install && npm run build        # Node >= 20
node dist/cli.js path/to/resend-skills/skills --cli-repo path/to/resend-cli
```

Exit code is `0` when clean and `1` when drift is found. It also writes `skillcheck-report.md` with file, line, claim, and expected value for every finding. A checker whose source can't be reached shows as `SKIPPED` instead of passing.

## AI mode

`--ai` (needs `OPENAI_API_KEY`; model from `SKILLCHECK_AI_MODEL`, default `gpt-4o-mini`) also asks a model to extract claims the regexes miss. The model only finds claims: each must quote the exact line it came from or it is dropped, and every finding still comes from the same docs/OpenAPI/CLI lookup. Findings from AI-only claims are tagged `[ai]`. Responses are cached in `.skillcheck-cache/`, so reruns are cheap and repeatable. Without the flag nothing changes.

## GitHub Action

[`.github/workflows/skillcheck.yml`](.github/workflows/skillcheck.yml) runs on PRs that touch `skills/**` and weekly, since docs can drift with no skills PR. It adds `--ai` only if the `OPENAI_API_KEY` secret exists.

## Findings on resend-skills

872 claims checked, 7 findings:

- **Rate limit.** `SKILL.md:280` and `references/sending/overview.md:14` say 2 req/s. The docs say 10. This matches [resend-skills#164](https://github.com/resend/resend-skills/issues/164). A 2-line fix is in [`patches/resend-skills-issue-164.patch`](patches/resend-skills-issue-164.patch).
- **Error codes.** The table in `references/sending/best-practices.md:130-136` uses four names that don't exist in the API docs: `authentication_error`, `authorization_error`, `unprocessable_entity`, `api_error`.
- **Careers endpoint.** `GET /careers/{id}` isn't in the public OpenAPI spec. The CLI really calls it, so this is likely a spec gap, not a skill error.

The CLI checker found nothing across 478 commands and flags.

## Limits

Extraction is pattern-based, so it checks names and numbers, not whether the prose is right. Endpoints missing from the public spec get flagged, and `skillcheck.config.json` can suppress known false positives.
