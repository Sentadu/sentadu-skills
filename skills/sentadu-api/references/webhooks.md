# Webhooks

Instead of polling `GET /orders/{id}`, register an endpoint and receive an event.

Configure the URL and read the signing secret in `/dashboard/webhooks`. A secret looks like
`whsec_<base64url>` and is shown once.

## Events

Four, and only four:

| Event | Fires when |
| --- | --- |
| `order.paid` | Money settled and the order is being fulfilled |
| `order.active` | The eSIM is provisioned and usable |
| `order.failed` | Fulfilment failed permanently |
| `order.cancelled` | The order was cancelled and refunded |

The eSIM is usable at `order.active`. Waiting for it is what makes polling unnecessary.

## Request

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

`data` is NOT the `GET /orders/{id}` shape. It is a small event-specific object, and the keys
differ per event:

| Event | `data` keys |
| --- | --- |
| `order.paid`, `order.active` | `order_id`, `order_number`, `status`, `package_code`, `amount_idr_minor`, `esims` |
| `order.failed` | `order_id`, `order_number`, `status`, `reason` |
| `order.cancelled` | `order_id`, `order_number`, `status`, `refund_idr_minor` |

Note `order_id`, not `id`. Read the order with `GET /orders/{order_id}` when you need the full
shape.

Respond with a 2xx. Anything else counts as a failure.

## Verifying the signature

The signed string is `<t>.<raw body>`, hashed with `HMAC-SHA256` using the endpoint's secret,
hex encoded. `t` is unix seconds and is part of the signed string, which is what makes a
replayed body detectable.

```js
import crypto from "node:crypto";

/**
 * Returns true only for a live, correctly signed delivery.
 * Never throws: a missing or malformed header is a refusal, not a crash.
 */
export function verify(rawBody, header, secret) {
  if (typeof header !== "string" || !header) return false;

  const parts = Object.fromEntries(
    header.split(",").map((part) => part.split("=")),
  );
  if (!parts.t || !parts.v1) return false;

  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${parts.t}.${rawBody}`)
    .digest("hex");

  // A length check first: timingSafeEqual THROWS on unequal lengths, so
  // comparing before checking would turn a truncated signature into a 500.
  const given = Buffer.from(parts.v1, "hex");
  if (given.length !== expected.length / 2) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), given);
}
```

Three things that break it, in order of how often they happen:

1. **Hashing a re-serialised body.** `JSON.parse` then `JSON.stringify` reorders keys and
   changes whitespace, so the bytes no longer match. Read the raw body: `await req.text()` in a
   Node handler, or the raw buffer in your framework, and hash that.
2. **Comparing with `===`.** Use a constant-time compare. A timing leak on a signature check is
   a real weakness, not a theoretical one.
3. **Skipping the timestamp check.** Without it, a captured request replays forever.
4. **Assuming the header is present.** A request with no `X-Sentadu-Signature` at all is the
   easiest thing to send, and `header.split` on `undefined` throws instead of refusing.

`scripts/verify-webhook.sh` does this recomputation from a captured body and header, which
turns "the signature never verifies" into a concrete answer in one command.

## Retries

A failed delivery is retried until five attempts have been made in total, then it is parked.

| After attempt | Waits before the next |
| --- | --- |
| 1 | 1 minute |
| 2 | 5 minutes |
| 3 | 30 minutes |
| 4 | 2 hours |
| 5 | nothing. Parked as `FAILED`. |

The longest wait, 12 hours, is in the ladder but a delivery that reaches it has already
exhausted its five attempts, so in practice the schedule above is what a receiver sees. The
endpoint is never disabled, so a later event still tries.

Retries mean **at-least-once delivery**. The same event can arrive twice, and out of order. Make
your handler idempotent on `id`, and do not assume `order.paid` always arrives before
`order.active`. If order matters, read the order with `GET /orders/{id}` when an event arrives
rather than trusting the arrival order.

## Endpoint requirements

- HTTPS only. Plain HTTP is refused.
- Publicly resolvable. Loopback, link-local and private addresses are refused, and the address
  is re-checked at delivery time so a DNS rebind cannot point it somewhere private.
- At most ten endpoints per account.
- Respond within ten seconds. Do the slow work asynchronously; a timeout counts as a failure.

## Testing a receiver

**The sandbox does not emit webhooks.** A `sdk_test_` order queues no `order.*` events, so
`/dashboard/webhooks` shows nothing for it and a receiver cannot be proven against a test key.

Test a receiver by pointing it at a throwaway endpoint and placing one small LIVE order.
`/dashboard/webhooks` lists deliveries and their responses, but it has no replay button: read
the stored body from there and re-send it yourself. The signature format and the retry ladder
are the production ones, so a handler that verifies a correctly signed body will verify a live
one.
