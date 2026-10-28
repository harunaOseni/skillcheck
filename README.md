# SkillCheck

## What SkillCheck does

AI assistants follow "skill" files: short guides that tell them how to use a product. If a guide says something wrong, the assistant repeats the mistake. SkillCheck fact-checks the specific claims in those files against the product's own docs, API spec and command-line tool. Built as a demo for Resend's [`resend/resend-skills`](https://github.com/resend/resend-skills).

## How it works

1. **Find the claims.** Pattern matching pulls out numbers, error names, API endpoints, commands and links. No AI, so results are the same every run.
2. **Look each one up** in the official source.
3. **Report** the file and line, and what the source says instead.

| Check | What it looks at | Checked against |
|---|---|---|
| Rate limits | "N requests per second" | Resend docs |
| Error codes | error names and HTTP statuses | Resend docs and API spec |
| Endpoints | `POST /emails`, curl and SDK calls | OpenAPI spec |
| CLI | `resend ...` commands and flags | the CLI's own command list |
| Doc links | `resend.com/docs/...` links | the docs index (`llms.txt`) |

```bash
npm install && npm run build
node dist/cli.js path/to/resend-skills/skills --cli-repo path/to/resend-cli
```

A GitHub Action ([`skillcheck.yml`](.github/workflows/skillcheck.yml)) runs it on pull requests that touch skills, and weekly.

## What it found

It checked 872 claims in resend-skills and found 7 problems:

- **Wrong rate limit.** `SKILL.md:280` and `references/sending/overview.md:14` say 2 requests per second. The docs say 10. This matches [resend-skills#164](https://github.com/resend/resend-skills/issues/164), and a 2-line fix is in [`patches/resend-skills-issue-164.patch`](patches/resend-skills-issue-164.patch).
- **Error names that don't exist.** `references/sending/best-practices.md:130-136` lists four names missing from the API docs: `authentication_error`, `authorization_error`, `unprocessable_entity` and `api_error`.
- **Careers endpoint.** `GET /careers/{id}` isn't in the public API spec. The CLI really uses it, so this is probably a gap in the spec, not a mistake in the skill.

Every CLI command and docs link matched.
