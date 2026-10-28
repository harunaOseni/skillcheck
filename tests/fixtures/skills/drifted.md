# Drifted skill

Reducing API calls is important (by default, rate limit is 2 requests per second).

| Code | Action |
|------|--------|
| 429 | Rate limited — retry (default rate limit: 2 req/s) |

| Code | Name | Description |
|------|------|-------------|
| 401 | `authentication_error` | Invalid API key |
| 409 | `invalid_idempotent_request` | Key reused |
| 403 | `invalid_idempotent_request` | Wrong status on purpose |

- 418 - I'm a teapot

Endpoints: `POST /emails`, `GET /emails/{id}/cancel`, `DELETE /widgets/:id`.

```bash
curl -X POST 'https://api.resend.com/emails/batch' -H 'Authorization: Bearer re_x' -d '{}'
curl https://api.resend.com/gizmos
resend domains create --name example.com --regoin us-east-1
resend domains frobnicate
resend emails send --from a@b.c --to d@e.f --subject s --text t --json
```

Use `resend usage` or `resend login --nope`.

## domains create

| Flag | Type | Description |
|------|------|-------------|
| `--name <domain>` | string | ok |
| `--sparkles` | boolean | does not exist |

| Command Group | What it does |
|--------------|-------------|
| `domains` | create, verify, teleport |

SDK: `resend.emails.send({})`, `resend.batch.send([])`, `resend.widgets.list()`.

See [gone](https://resend.com/docs/does/not-exist) and [ok](https://resend.com/docs/api-reference/errors).
