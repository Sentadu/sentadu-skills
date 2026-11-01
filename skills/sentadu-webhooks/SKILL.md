---
name: sentadu-webhooks
description: Use when receiving Sentadu order events instead of polling, when a Sentadu webhook signature never verifies, when a delivery needs retrying or deduplicating, or when registering an endpoint. Covers the four order events, the X-Sentadu-Signature scheme over the raw body, the five-attempt retry ladder, the at-least-once contract, and why the sandbox sends no events at all. Use alongside the sentadu-api skill, which has the endpoint table.
license: MIT
compatibility: Node.js 18 or later for the verification snippets. Any HTTP server works. No Sentadu SDK is required.
metadata:
  author: sentadu
  homepage: https://sentadu.com/id/docs
---

# Sentadu webhooks

A Sentadu order changes state in the background: paid, then provisioned, or failed, or
cancelled. Webhooks push those transitions to a URL you run, so a client does not have to poll
`GET /orders/{id}` until it turns `ACTIVE`.

Everything below is what the API actually emits. Prices, tiers and the endpoint table live in
the `sentadu-api` skill; this one is about the delivery itself.

## The four events, and only four

| Event | Fires when |
| --- | --- |
| `order.paid` | Money settled and fulfilment has begun |
| `order.active` | The eSIM is provisioned and usable |
| `order.failed` | Fulfilment failed permanently |
| `order.cancelled` | The order was cancelled and refunded |

There is no `esim.*` event. Do not subscribe to one and wait.

**`order.active` is not guaranteed to arrive.** An order can emit `order.paid` and never emit
`order.active`, depending on how fulfilment completes. Treat `order.paid` plus a
`GET /orders/{id}` read as the reliable path, and treat `order.active` as an accelerator.

## What a delivery looks like

```
POST /your/endpoint
Content-Type: application/json
X-Sentadu-Signature: t=1750000000,v1=6f1c...
X-Sentadu-Event: order.active
X-Sentadu-Delivery: <delivery id>
```

```json
{
  "id": "<delivery id>",
  "event": "order.active",
  "created_at": "2026-01-01T00:00:00.000Z",
  "data": { }
}
```

`data` is **not** the `GET /orders/{id}` object. It is a small event-specific payload:

| Event | `data` keys |
| --- | --- |
| `order.paid`, `order.active` | `order_id`, `order_number`, `status`, `package_code`, `amount_idr_minor`, `esims` |
| `order.failed` | `order_id`, `order_number`, `status`, `reason` |
| `order.cancelled` | `order_id`, `order_number`, `status`, `refund_idr_minor` |

Note `order_id`, not `id`: `id` at the top level is the **delivery** id, and it is what you
deduplicate on. Respond `2xx`. Anything else, including a `3xx`, counts as a failure.

## Verifying the signature

The signed string is `<t>.<raw body>`, HMAC-SHA256 with the endpoint's `whsec_` secret, hex
encoded. `t` is unix seconds and is inside the signed string, which is what makes a replayed
body detectable. Reject anything older than 300 seconds either way.

`references/verification.md` has the full receiver in Node, plus the same check in Go and PHP.
The four ways it goes wrong:

1. **Hashing a re-serialised body.** `JSON.parse` then `JSON.stringify` reorders keys and
   changes whitespace. Hash the bytes exactly as they arrived: `await req.text()` in a Node
   handler, `file_get_contents("php://input")` in PHP, `io.ReadAll(r.Body)` in Go.
2. **Comparing with `===`.** Use a constant-time compare. A timing leak on a signature check is
   a real weakness.
3. **Skipping the timestamp check.** Without it a captured request replays forever.
4. **Assuming the header is present.** A request with no `X-Sentadu-Signature` is the easiest
   thing to send, and `header.split(",")` on `undefined` throws instead of refusing.

A `404`-shaped mistake is also common: the secret is shown once when the endpoint is created. If
it was lost, delete the endpoint and create a new one. There is no reveal.

## Retries, and what "at-least-once" costs you

A failed delivery is retried until five attempts in total have been made, then parked as
`FAILED`.

| After attempt | Waits before the next |
| --- | --- |
| 1 | 1 minute |
| 2 | 5 minutes |
| 3 | 30 minutes |
| 4 | 2 hours |
| 5 | nothing. Parked as `FAILED`. |

The endpoint is never disabled, so a later event still tries. That means the same event can
arrive twice, and events can arrive out of order. Two rules follow:

- **Deduplicate on the delivery `id`.** Persist it before doing work, and skip a repeat.
- **Never assume `order.paid` arrived before `order.active`.** If order matters, read the order
  with `GET /orders/{id}` when the event lands and act on the state you read, not on the state
  the event implies.

## Registering an endpoint

- HTTPS only. Plain HTTP is refused.
- Publicly resolvable. Loopback, link-local and private ranges are refused, and the address is
  re-resolved at delivery time so a DNS rebind cannot point it somewhere private. A URL that
  resolves to `127.0.0.1`, `10.x`, `169.254.x`, `::1` or `fc00::/7` will not save.
- At most ten endpoints per account.
- Respond within ten seconds. Do the slow work asynchronously; a timeout counts as a failure.

## Testing a receiver

**The sandbox sends no events.** A `sdk_test_` order queues no `order.*` deliveries at all, so
`/dashboard/webhooks` shows nothing for it and a receiver cannot be proven against a test key.
That is a deliberate gap, not a bug to work around.

To prove a receiver, point it at a throwaway endpoint and place one small LIVE order.

`scripts/verify-webhook.sh` in the `sentadu-api` skill recomputes a signature from a captured
body and header. Run it before you debug your own code: it separates "our hash is wrong" from
"the secret is wrong" in one command.

```sh
./scripts/verify-webhook.sh whsec_abc 't=1750000000,v1=6f1c...' ./body.json
```

## Where the rest is

| Question | Read |
| --- | --- |
| Which endpoints exist, and what they return | the `sentadu-api` skill |
| Why an order failed | `GET /orders/{id}`, then the `sentadu-api` error table |
| What an order costs | `amount_idr_minor` is **whole rupiah times 100**. Never convert it. |
