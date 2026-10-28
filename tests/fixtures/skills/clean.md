# Clean skill

Default rate limit is 10 requests per second.

| Code | Name |
|------|------|
| 409 | `invalid_idempotent_request` |
| 429 | `rate_limit_exceeded` |

`POST /emails` and `GET /emails/{email_id}`.

```bash
curl -X POST 'https://api.resend.com/emails' -H 'x' -d '{}'
resend domains create --name example.com --region us-east-1 --json
resend emails send --from a@b.c --to d@e.f --subject s --text t
resend domains ls
```
