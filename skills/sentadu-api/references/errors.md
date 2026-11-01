# Errors

Every failure is one object with a stable `code`. Branch on `code`. The `message` is for a
human reading a log and may be reworded at any time.

```json
{
  "error": {
    "code": "invalid_request",
    "message": "validation failed",
    "details": [ { "path": "package_code", "message": "Required" } ]
  }
}
```

`details` is present only when per-field information exists, which in practice means
`invalid_request`.

## The closed set

| Code | HTTP | When | What to do |
| --- | --- | --- | --- |
| `invalid_api_key` | 401 | Missing, malformed or revoked bearer | Fix the credential. Do not retry. |
| `subscription_inactive` | 403 | No live subscription, or expired past grace | Renew in the console. Do not retry. |
| `rate_limited` | 429 | Over the per-minute limit | Sleep `Retry-After` seconds, then retry. |
| `invalid_request` | 400 | Body or query failed validation | Read `details`, fix the request. Do not retry. |
| `not_found` | 404 | Does not exist, or is another account's | Do not retry. |
| `insufficient_wallet` | 402 | Balance does not cover the purchase | Top up. Retrying cannot help. |
| `package_unavailable` | 409 | Exists but is not purchasable | Re-list packages. Do not retry the same code. |
| `esim_not_toplup_able` | 409 | Expired or unsupported for top-up | Terminal for that eSIM. |
| `esim_not_activatable` | 409 | The eSIM's state refuses the action | Terminal. Check `status` first. |
| `idempotency_conflict` | 409 | Key attached to an UNSETTLED order, or header/body keys disagree | Wait, or use a fresh key. A settled key returns its order instead. |
| `internal_error` | 500 | Server-side fault | Retry with backoff, a couple of times. |

**A wrong HTTP verb does not reach this set.** Next.js answers a method the route does not
export with its own plain-text `405` before any handler runs, so there is no `{error:{code}}`
envelope for that case. Treat a non-JSON body with status 405 (or a 404 for a path that does not
exist) as "wrong URL or verb", not as an API error.

`404` is used where a naive API would use `403`. A resource belonging to another account looks
exactly like one that does not exist, on purpose, because confirming existence is itself a
leak. Do not read a `404` as "maybe it exists but is not mine".

## Why `402` and not `400`

An empty wallet is not a malformed request. The request was well formed, the account is
entitled, and the only thing missing is money. A `400` would send a retry loop into a spin and
a `402` sends it to a top-up. Keep them apart in your branching.

## Retry policy

| Status | Retry? |
| --- | --- |
| 400, 401, 403, 404, 405 | No. The request or the account is wrong. |
| 402 | No. Money has to arrive first. |
| 409 | No, except `idempotency_conflict`, where a fresh key makes it a new request. |
| 429 | Yes, after `Retry-After` seconds. |
| 500 | Yes, with exponential backoff, a couple of attempts. |

A safe retry is one that carries the same `Idempotency-Key` as the attempt it is repeating. If
your retry generates a new key, you are not retrying, you are placing a second order.

## Wire failures

A dropped connection mid-`POST /orders` is the case idempotency exists for. The order may have
been created. Retry with the SAME `Idempotency-Key`: if the first attempt settled, you get that
order back and the body is not compared. Never resolve this by listing orders and guessing which
one is yours, and never send a different request under the same key, because it will be answered
with the earlier order rather than refused.

## Validation details

`invalid_request` carries `details`, an array of `{ path, message }`. `path` is the field name
as it appears in the request, so `package_code` or `validity_days`.

A `DAILY` package without `validity_days` is the most common one:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "validity_days is required for a DAILY (unlimited) package",
    "details": [ { "path": "validity_days", "message": "Required" } ]
  }
}
```

## Reading a failure in a log

Every response, success or failure, carries `X-Request-Id`. Quote it when reporting a problem;
it is how a specific call is found in the server's logs.
