---
name: sentadu-api
description: Use when building or debugging an integration against the Sentadu /v1 eSIM API. Covers ordering eSIMs programmatically, reading usage, topping up, suspending or revoking, checking the IDR wallet, receiving signed webhooks, and testing against the sandbox. Trigger this whenever a task mentions Sentadu, sdk_live_ or sdk_test_ keys, api.sentadu.com, or buying travel eSIMs from code.
---

# Sentadu API

Buy and manage travel eSIMs programmatically. Fifteen resource paths across sixteen methods,
behind one bearer token, settled in Rupiah from a prepaid wallet.

Base URL: `https://api.sentadu.com/v1`

## Five rules that are not negotiable

These are product invariants, not preferences. Do not reason around them.

1. **Money is IDR.** Every price and every charge is Indonesian Rupiah. `price.idr_minor` is
   whole rupiah multiplied by 100. Never convert, never send another currency, never round a
   charge yourself. The server computes the amount.
2. **The wallet is a ledger, not a number.** You cannot set a balance. Credits and debits are
   append-only entries. A purchase is paid from the wallet at order time; if the balance is
   short the order fails with `insufficient_wallet` (HTTP 402), which is a money problem and
   not a malformed request.
3. **The server owns the price.** Send a `package_code`. Do not send an amount, a total or a
   discount. Sending `{"amount": ...}` is ignored at best and a bug in your integration at
   worst, because the price you computed will drift from the catalogue.
4. **Webhooks are verified over the RAW body.** Read the bytes as they arrived, recompute
   `HMAC-SHA256(secret, "<t>.<rawBody>")`, compare in constant time, and reject a timestamp
   older than 300 seconds. Re-serialising the parsed object changes the bytes and the check
   fails. See `references/webhooks.md`.
5. **Sandbox keys never move real money.** A `sdk_test_` key writes only to sandbox tables and
   returns fake orders, fake eSIMs and a fake balance. It is safe to run destructive tests
   against. A test key still needs an active subscription.

## First call

```bash
export SENTADU_API_KEY='sdk_live_xxxxxxxx.your-secret-here'
export SENTADU_BASE='https://api.sentadu.com/v1'
curl -s "$SENTADU_BASE/me" -H "Authorization: Bearer $SENTADU_API_KEY"
```

A healthy answer is `200` with `{ "data": { "tier": ..., "status": ... } }`. Run
`scripts/smoke.sh` to do this plus a package listing in one go, and to fail loudly if the
envelope is not what the client expects.

## The envelope

Every successful response is `{ "data": <payload> }`, plus `"meta"` on a paginated list:

```json
{
  "data": [ ... ],
  "meta": { "page": 1, "perPage": 24, "total": 312, "totalPages": 13 }
}
```

Every failure is `{ "error": { "code", "message", "details"? } }` with a stable `code`. Branch
on `code`, never on `message`. The full set is in `references/errors.md`.

## The shape of a task

Read the reference for the area you are working in, and only that one.

| Task | Read |
| --- | --- |
| Pick a package and place an order | `references/endpoints.md` (Packages, Orders) |
| Read usage, suspend, resume, revoke, top up | `references/endpoints.md` (eSIMs) |
| Show or reconcile a balance | `references/endpoints.md` (Wallet) |
| Handle a failure or build a retry branch | `references/errors.md` |
| Receive events instead of polling | `references/webhooks.md` |
| Test without spending money | `references/sandbox.md` |

## Ordering an eSIM

The minimum viable flow. Every step is one call.

1. `GET /packages?country=JP&limit=50` and pick a `package_code`. Prices carry
   `usd_minor`, `idr_minor` and `currency`.
2. `POST /orders` with `{ "package_code": "...", "quantity": 1 }` and an
   `Idempotency-Key` header. The key is what makes a retry safe: a key that already produced
   an order returns THAT ORDER, whatever the new body says. It does not compare bodies, so a
   key is a promise about the request, not a cache key you can reuse for a different one.
3. The order comes back `PAID`, `FULFILLMENT` or `ACTIVE`. Poll `GET /orders/{id}` until it is
   `ACTIVE`. Do not rely on `order.active` alone: a fast-fulfilling order may emit it, but an
   order fulfilled later emits only `order.paid` and never `order.active`.
4. `GET /esims/{id}?include=secrets` once the eSIM is `READY`, and hand `lpa` or
   `qr_code_url` to the customer. `include=secrets` adds `pin` and `puk`; request it only when
   you are about to show them, and never log the response.

A `DAILY` (unlimited) package additionally requires `validity_days`. Omitting it is
`invalid_request`, not a silent default.

## Reading state without wasting calls

- `GET /orders?status=ACTIVE` and `GET /esims?status=ACTIVE` filter server-side. Filtering a
  full list in your client is a slower way to get the same answer.
- `meta.total` is the count you want for a dashboard. Do not sum a page.
- Usage is `GET /esims/{id}/usage`, returning `used_bytes`, `remaining_bytes` and
  `percent_used` as of `measured_at`. It is not real time; the provider measures on an
  interval, so do not poll it more than a few times an hour.

## Rate limits

Limits are per account, not per key, and are enforced in one-minute windows.

| Tier | Requests per minute |
| --- | --- |
| Reseller | 60 |
| Enterprise | 300 |
| Enterprise with add-ons | up to 4600 |

Read the live values from the response headers rather than assuming: `X-RateLimit-Limit`,
`X-RateLimit-Remaining` (present only when a shared counter is available), `X-RateLimit-Reset`
(unix seconds). A `429` carries `Retry-After` in seconds. Back off by that value; do not retry
immediately, and do not retry a `429` more than a few times before surfacing it.

`X-Sentadu-Subscription: grace` on a success means the subscription lapsed and is in its
seven-day grace window. Treat it as a warning to renew, not as an error.

## Pagination

`page` is 1-based and clamped. `limit` is bounded per endpoint (1 to 100 for packages and
transactions, default 20 for orders and eSIMs). Loop until `meta.page >= meta.totalPages`, and
stop if `data` is empty even when `totalPages` says otherwise, which is what a concurrent
write looks like.

## Common mistakes

| Symptom | Cause |
| --- | --- |
| `401 invalid_api_key` | Key mangled by a shell or a `.env` line break. The secret is base64url, so it can contain `-` and `_`; quote it. |
| `403 subscription_inactive` | The account has no live subscription, or it expired past the grace window. |
| `402 insufficient_wallet` | Not enough balance. Top up the wallet; retrying does not help. |
| `409 idempotency_conflict` | The key is already attached to an order that has NOT settled, or the header and body keys disagree. A key on a settled order returns that order instead. |
| `409 package_unavailable` | The package exists but is not currently purchasable. Re-list rather than retrying. |
| Webhook signature never verifies | The body was parsed and re-serialised before hashing. Hash the raw bytes. |

## Scripts

- `scripts/smoke.sh` checks that a key works and that the envelope is intact. Run it first
  when an integration misbehaves, so you know whether the problem is your code or the account.
- `scripts/verify-webhook.sh` recomputes a signature from a captured body and header, which is
  the fastest way to prove a receiving endpoint's verification is correct.

`smoke.sh` reads `SENTADU_API_KEY`, `SENTADU_SANDBOX_KEY` (with `--sandbox`) and `SENTADU_BASE`,
and defaults the base to `https://api.sentadu.com/v1` when it is unset.

`verify-webhook.sh` reads no environment at all: it takes `<secret> <signature-header>
<body-file>` as three positional arguments. Neither script writes a key to disk.

## Known limits

- `quantity` above 1 is refused rather than partially priced. Place one order per eSIM.
- A revoked eSIM cannot be resumed or topped up. That is terminal.
- Top-ups are only possible while the eSIM has remaining validity.
- There is no endpoint to delete an account or a key from the API. Use the developer console.
