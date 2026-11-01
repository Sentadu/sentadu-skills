# Sandbox

A `sdk_test_` key writes only to sandbox tables. Orders, eSIMs, top-ups and every state change
are synthetic, and the balance is not real money.

Two things are real: the catalogue and its prices. `GET /packages` reads the live catalogue in
both modes, so a sandbox order is priced through the same ladder a live one would be.

## Preconditions

A test key still needs an active subscription. There is no free tier, and the sandbox is not a
way around that. Without a live subscription every call is `subscription_inactive` (403), the
same as with a live key.

## What is fake

| Thing | Value |
| --- | --- |
| Starting balance | Rp 500.000 (`50000000` in `idr_minor`) |
| Order number | `TST-` prefix, never collides with a real `SUD-` |
| ICCID | `899900` plus twelve hex characters |
| LPA | `LPA:1$test.sentadu.com$<matching id>` |
| `pin` / `puk` | `0000` and `00000000` |
| Order status | Immediately `ACTIVE` |
| Usage | 5 GiB total, 512 MiB used |

The LPA points at `test.sentadu.com`, which serves no SM-DP+ server. A sandbox eSIM installs
nowhere. That is the point: it exercises the whole flow without a device.

## What is real

- The catalogue, and every price on it.
- The rate limiter, so a load test in the sandbox hits the same wall.
- Validation and the error set. A malformed request fails the same way here.
- The rate limiter, so a load test hits the same wall.

**What is NOT mirrored, and each one will bite an integration that relies on it:**

- **No webhooks.** A `sdk_test_` order queues no `order.*` events at all. Register nothing and
  expect nothing; use a LIVE key against a throwaway endpoint to test a receiver.
- **Idempotency is not applied.** The header is accepted and has no effect, so a retried
  `POST /orders` creates a second sandbox order.

Two things that USED to differ and no longer do: `quantity` above 1 is refused in the sandbox
exactly as in live (the check runs before the mode branch), and `?status` filters sandbox
`GET /orders` and `GET /esims` the same way it filters live ones.

## Differences from live

- `GET /wallet` returns the sandbox balance with `"sandbox": true`.
- `GET /wallet/transactions` is always empty, because sandbox money is never ledgered.
- A successful sandbox top-up reports `amount_idr_minor: 0` and status `APPLIED`.
- Order responses report `pricing_mode: "SANDBOX"`.

## Resetting the balance

There is no API for this. The reset is a button in the developer console, under the sandbox
section, and is limited to three resets per 24 hours. Spend it deliberately: a reset discards the
whole sandbox balance and restores Rp 500.000.

## Terminal states

The sandbox enforces the same lifecycle as production, so a test can prove your error handling:

- Cancelling an already cancelled order is `idempotency_conflict` (409).
- Suspend, unsuspend or revoke on a cancelled order is `esim_not_activatable` (409).
- A top-up on a cancelled or revoked eSIM is `esim_not_toplup_able` (409).
- A sandbox balance that runs out is `insufficient_wallet` (402), with a message pointing at
  the console reset.

## A workflow that proves an integration

1. `GET /me` and confirm `key_mode: "TEST"` and `status: "ACTIVE"`.
2. `GET /packages?limit=5` and take a `package_code`.
3. `POST /orders`. A retry is NOT idempotent here, so do not assert that it is; the header is
   accepted and ignored on the sandbox path.
4. `GET /esims/{id}?include=secrets` and assert `pin` is `0000`.
5. `POST /esims/{id}/topups` and assert `amount_idr_minor` is `0`.
6. `POST /esims/{id}/revoke`, then `POST /esims/{id}/unsuspend`: the sandbox answers **200
`READY`**, because its state machine only refuses `CANCELLED`. LIVE answers `409`
`esim_not_activatable`. Assert the sandbox behaviour you actually get, and do not use this
step as proof that the live refusal is handled.
