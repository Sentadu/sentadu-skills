# Endpoints

All paths below are relative to `https://api.sentadu.com/v1`. Every response is wrapped in
`{ "data": ... }`; a paginated list also carries `"meta"`.

| # | Method | Path | Purpose |
| --- | --- | --- | --- |
| 1 | GET | `/me` | The key's account: tier, status, limit, mode |
| 2 | GET | `/packages` | Browse the catalogue |
| 3 | GET | `/packages/{package_code}` | One package |
| 4 | POST | `/orders` | Buy |
| 5 | GET | `/orders` | List orders |
| 6 | GET | `/orders/{id}` | One order |
| 7 | POST | `/orders/{id}/cancel` | Cancel before fulfilment |
| 8 | GET | `/esims` | List eSIMs |
| 9 | GET | `/esims/{id}` | One eSIM, optionally with secrets |
| 10 | GET | `/esims/{id}/usage` | Data consumed |
| 11 | POST | `/esims/{id}/topups` | Buy more data on an eSIM |
| 12 | POST | `/esims/{id}/suspend` | Pause it |
| 13 | POST | `/esims/{id}/unsuspend` | Resume it |
| 14 | POST | `/esims/{id}/revoke` | Terminal: cannot be undone |
| 15 | GET | `/wallet` | Balance |
| 16 | GET | `/wallet/transactions` | Ledger entries |

## Account

### `GET /me`

The cheapest liveness check, and the call that tells you what the key is allowed to do.

```json
{
  "data": {
    "tier": "RESELLER",
    "status": "ACTIVE",
    "expires_at": null,
    "rate_limit_rpm": 60,
    "key_mode": "LIVE",
    "sandbox_available": true,
    "pricing_mode": "STORE"
  }
}
```

- `tier`: `RESELLER` or `ENTERPRISE`
- `status`: `ACTIVE` or `GRACE`. `EXPIRED` never reaches this endpoint: that key gets
  `subscription_inactive` (403) instead, because `/me` itself requires API access.
- `expires_at`: ISO timestamp, or `null` for a Reseller key, which never expires
- `key_mode`: `LIVE` or `TEST`
- `pricing_mode`: `STORE` (retail) or `WHOLESALE` (provider cost)
- `sandbox_available`: true when the account holds any tier at all, including one in grace

## Packages

### `GET /packages`

| Query | Values | Notes |
| --- | --- | --- |
| `country` | ISO-2, e.g. `JP` | Filters to packages usable there |
| `coverage` | `SINGLE`, `MULTI`, `REGIONAL` | Comma-separated |
| `type` | `FIXED`, `DAILY` | `DAILY` is the unlimited family |
| `sort` | `price_asc`, `price_desc`, `volume_desc` | Default is by name |
| `page` | 1-based | Clamped |
| `limit` | 1 to 100 | Default 24 |

A package carries `package_code`, `slug`, `name`, `coverage`, `plan_type`, `duration_days`,
`volume_bytes`, `speed`, `fup_policy`, `support_top_up`, `country_count`, `countries` and
`price`. Note `duration_days` and `volume_bytes`, which are the real field names:

```json
"price": { "usd_minor": 780, "idr_minor": 12800000, "currency": "USD" }
```

`idr_minor` is whole rupiah multiplied by 100. Display `idr_minor / 100`.

### `GET /packages/{package_code}`

One object, same shape. A code that does not exist is `not_found` (404).

## Orders

### `POST /orders`

```json
{ "package_code": "JP-5GB-30D", "quantity": 1 }
```

Send `Idempotency-Key` as a header (or `idempotency_key` in the body).

A key that already produced a SETTLED order returns that order, and the body is NOT compared,
so reusing a key for a different purchase silently returns the first one. Treat a key as bound
to one logical request and never reuse it.

`idempotency_conflict` (409) happens in two cases only: the key is attached to an order that
has not settled yet, or the header key and the body key disagree.

`quantity` above 1 is refused with `invalid_request`, in BOTH modes: the check runs before the
sandbox branch, so the sandbox reproduces the refusal rather than hiding it.

Returns the order with its `esims[]`:

```json
{
  "data": {
    "id": "…",
    "order_number": "SUD-…",
    "status": "ACTIVE",
    "amount_idr_minor": 12800000,
    "created_at": "…",
    "esims": [ { "id": "…", "iccid": "…", "status": "READY" } ]
  }
}
```

### `GET /orders`

| Query | Values |
| --- | --- |
| `status` | `PENDING_PAYMENT`, `PAID`, `FULFILLMENT`, `ACTIVE`, `EXPIRED`, `CANCELLED`, `FAILED` |
| `page` | 1-based |
| `limit` | 1 to 100, default 20 |

### `GET /orders/{id}`

One order, same shape. Another account's order is `not_found`, never `403`.

### `POST /orders/{id}/cancel`

Cancels before fulfilment and refunds the wallet. Cancelling an already cancelled order is
`idempotency_conflict` (409). An order that has already fulfilled cannot be cancelled.

## eSIMs

### `GET /esims`

| Query | Values |
| --- | --- |
| `status` | `READY`, `ACTIVE`, `SUSPENDED`, `EXPIRED`, `USED_UP`, `CANCELLED` |
| `page`, `limit` | As above, default 20 |

### `GET /esims/{id}`

Add `?include=secrets` to receive `pin` and `puk`. Request it only when you are about to show
them to the customer; do not log a response that contains them.

```json
{
  "data": {
    "id": "…",
    "iccid": "…",
    "status": "ACTIVE",
    "lpa": "LPA:1$…",
    "qr_code_url": "https://…",
    "smdp_status": "…",
    "esim_status": "…",
    "apn": "…"
  }
}
```

### `GET /esims/{id}/usage`

```json
{
  "data": {
    "esim_id": "…",
    "iccid": "…",
    "total_bytes": 5368709120,
    "used_bytes": 1073741824,
    "remaining_bytes": 4294967296,
    "percent_used": 20,
    "measured_at": "…"
  }
}
```

Not real time. The provider measures on an interval, so poll at most a few times an hour.

### `POST /esims/{id}/topups`

```json
{ "package_code": "JP-1GB-7D" }
```

Only while the eSIM still has validity. An expired or revoked eSIM is
`esim_not_toplup_able` (409).

### `POST /esims/{id}/suspend`, `/unsuspend`, `/revoke`

Each returns `{ "esim_id": "…", "requested": "suspend" | "unsuspend" | "revoke",
"current_status": "<the eSIM's status right now>" }`.

`current_status` is what the provider last reported, NOT the result of your request: the
provider's status webhook is the single writer, so the new status arrives there a moment later.

`revoke` is terminal in LIVE mode: a revoked eSIM cannot be resumed or topped up. Resuming is
`esim_not_activatable` (409); topping up is `esim_not_toplup_able` (409). Two different codes,
so a top-up branch keyed on the first never fires.

**The sandbox does not enforce this.** `revoke` then `unsuspend` on a sandbox eSIM answers 200
with status `READY`, because the sandbox state machine only refuses `CANCELLED`. Do not use the
sandbox to prove that your code handles the live refusal.

## Wallet

### `GET /wallet`

```json
{ "data": { "balance_idr_minor": 97169500, "currency": "IDR", "sandbox": false } }
```

`balance_idr_minor` is whole rupiah multiplied by 100. A test key returns the sandbox balance
with `"sandbox": true`.

### `GET /wallet/transactions`

| Query | Values |
| --- | --- |
| `limit` | 1 to 100, default 50 |

Each entry has a `type` of `TOPUP`, `REFUND`, `REVERSAL`, `ADJUSTMENT`, `PURCHASE` or
`REFERRAL`, plus `amount_idr_minor`
and `created_at`. Always empty for a test key, because sandbox money is not ledgered.

## What no endpoint does

- No endpoint sets a balance. Top up from the console.
- No endpoint returns a price you should send back. Prices are read, never written.
- No endpoint deletes an account or a key. Use `/account/developers`.
- No endpoint converts currency. Everything is already IDR.
