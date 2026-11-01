---
name: sentadu-security
description: Use when handling a Sentadu API key, a whsec_ webhook secret, or any response containing eSIM installation credentials. Covers how keys are shaped and stored, what happens on revoke, why a 404 is not a 403, which fields must never reach a log, and the small set of things a Sentadu integration must never do to make itself work. Read this before writing credential handling, logging, or error reporting around the Sentadu API.
license: MIT
compatibility: No runtime requirement. Applies to any client language.
metadata:
  author: sentadu
  homepage: https://sentadu.com/id/docs
---

# Sentadu security

This is not a general security checklist. It is the set of facts about Sentadu's own scheme that
decide whether an integration is safe, and the handling that follows from them. Every claim here
matches what the service does.

## A key is two halves, and only one is secret

```
sdk_live_1a2b3c4d.tG9uZ3NlY3JldGhlcmU...
└─┬──┘ └┬─┘ └┬┘ └──────────┬────────────┘
  │     │    │              └─ the secret: 32 random bytes, base64url
  │     │    └─ 8 hex chars: the PUBLIC prefix, used to find the row
  │     └─ the mode: live or test
  └─ the scheme
```

- The prefix is **not** secret. It is stored in clear so a lookup can find the row, and it is
  safe to show in a dashboard.
- The secret is returned **once**, at creation. Nothing stores it. The server keeps
  `sha256(whole key)` and compares with a constant-time compare, so a database leak does not hand
  anyone a usable key.
- There is no expiry. A key is valid until it is revoked.
- Revoking is **immediate** and permanent. The row is kept with a revoked timestamp so a leak stays
  auditable, but the key stops authenticating at once. There is no grace period and no undo; mint
  a new key.

**Consequence for your code:** treat the whole string as the credential, because the server
does. Splitting the prefix off to "keep it safe" protects nothing and breaks the key.

If it is in git, in a screenshot, in a CI log, or in a `.env` you committed: revoke it. Rotating
the value in place does not help, because the leaked key is still live.

## What must never be logged

| Field | Why |
| --- | --- |
| `Authorization` header | It is the key. This includes access logs that capture all headers. |
| `pin`, `puk` | eSIM install credentials. They are returned only by `GET /esims/{id}?include=secrets`. |
| `lpa` / `qr_code_url` | Installs the eSIM on a device. Anyone with it can use the data plan. |
| The `whsec_` secret | It signs every delivery to your endpoint. Leaking it lets an attacker forge events. |
| The full response of `include=secrets` | It contains two of the rows above. Log the eSIM id, never the body. |

Request `include=secrets` only in the request whose response goes straight to the customer's
screen, and log that call at the level that records the method and path and nothing else.

Sentadu itself never logs payment secrets or eSIM installation credentials. The same bar applies
to your integration, because the credential is equally usable from either end.

`references/logging.md` has a redactor for Node, Go and PHP, and the list of what to do when one
of these has already reached a log.

## A 404 is not an error you can interpret

Sentadu answers `404 not_found` for a resource that belongs to another account, **exactly as it
does for one that does not exist**. That is deliberate: confirming existence would itself be a
leak.

Two consequences:

- Never read a `404` as "maybe it exists but is not mine". It is a flat no.
- Never build a UI that distinguishes the two cases. If you do, you have re-created the
  enumeration oracle the API refuses to be.

## Money rules a client cannot work around

- Every charge is Indonesian Rupiah. `price.idr_minor` is **whole rupiah times 100**. Never
  convert it, never round it, never send a currency.
- Never send an amount, a total, or a discount. Send a `package_code`; the server prices it.
- The wallet is an append-only ledger. There is no set-balance call, and `insufficient_wallet`
  (HTTP 402) is a money problem, not a malformed request.
- A non-2xx is never a reason to retry a charge with a new idempotency key. A retry carries the
  **same** key as the attempt it repeats; a new key is a second order.

## Things that must never be done to "make it work"

Each of these turns a working integration into a vulnerable one, and none of them is ever the
fix for the problem it appears to solve:

- **Disabling TLS verification** to get past a certificate error. Fix the trust store instead.
- **Turning off signature verification** because a delivery "looks wrong". A signature that never
  verifies is a bug in your raw-body handling, not evidence that the check is unnecessary.
- **Storing the plaintext key** after creation instead of the value your secret manager holds.
  If your process needs the key, it belongs in an environment variable or a secret store, not in
  a database row your application can query back.
- **Logging the full request or response** to debug a 4xx. Redact `Authorization` and the
  `include=secrets` body first, or the debugging session becomes the leak.
- **Accepting a webhook without the timestamp check** because your endpoint is "hard to reach".

## Where the rest is

| Question | Read |
| --- | --- |
| The endpoint table and error codes | the `sentadu-api` skill |
| Event payloads, retries, deduplication | the `sentadu-webhooks` skill |
| Verifying a signature in Node, Go or PHP | `sentadu-webhooks/references/verification.md` |
