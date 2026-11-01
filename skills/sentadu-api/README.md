# sentadu-api

An agent skill for the [Sentadu](https://sentadu.com) eSIM API.

Install it and your coding agent already knows the endpoints, the auth scheme, the error set
and the Rupiah rules before it writes the first line of your integration. Without it, an agent
reconstructs the API from a docs page it half read, and the mistakes it makes are the
expensive kind: a currency conversion that should not happen, a retry that places a second
order, a webhook signature verified against a re-serialised body.

## Install

Copy this folder into wherever your agent looks for skills:

| Agent | Path |
| --- | --- |
| Claude Code | `.claude/skills/sentadu-api/` |
| Codex | `.agents/skills/sentadu-api/` |

```sh
cp -r sentadu-api .claude/skills/
```

Nothing to register and no key to activate. A skill is files.

## What is in it

```
sentadu-api/
├── SKILL.md                 the workflow, and five rules that are not negotiable
├── references/
│   ├── endpoints.md         all 16 methods, params and return shapes
│   ├── errors.md            the error codes, what each one means for retries
│   ├── webhooks.md          the 4 events, signature verification, retry schedule
│   └── sandbox.md           what is fake, what is real, how to reset
└── scripts/
    ├── smoke.sh             check a key works and the envelope is intact
    └── verify-webhook.sh    recompute a signature from a captured request
```

`SKILL.md` is deliberately short and mostly points at the references. An agent reads the whole
of it when the skill triggers, and only opens the reference for the part of the API it is
actually working on.

## The scripts

`smoke.sh` reads `SENTADU_API_KEY`, `SENTADU_SANDBOX_KEY` and `SENTADU_BASE` from the
environment. `verify-webhook.sh` reads none: it takes a secret, a signature header and a body
file as three positional arguments. Neither writes a key to disk.

```sh
export SENTADU_API_KEY='sdk_live_xxxxx.your-secret'

./scripts/smoke.sh                  # live key
./scripts/smoke.sh --sandbox        # uses SENTADU_SANDBOX_KEY

./scripts/verify-webhook.sh whsec_abc 't=1750000000,v1=6f1c...' ./body.json
```

`smoke.sh` fails with a specific reason, so it tells you whether the problem is the key, the
account, or the response shape. `verify-webhook.sh` hashes the file's bytes exactly as they
are, which is the whole point: the usual cause of a signature that never verifies is a body
that was parsed and re-serialised on the way to the hash.

## Get a key

Create one in the developer console at [sentadu.com/dashboard](https://sentadu.com/dashboard).
A key needs an active subscription: Reseller is a one-off Rp 150.000 and never expires,
Enterprise is Rp 888.000 a year at provider cost. A `sdk_test_` key exercises the same flow
against the sandbox without spending anything.

## Keeping it current

The facts here are copied from the API's own source, and the tests that ship with the site fail
if a rate limit, an error code or an endpoint in this skill disagrees with the running API.
Prices are NOT covered by those tests. Re-read the console before quoting one. If you fork this, keep
`references/endpoints.md` in step with `GET /me` and the console, and prefer reading a live
value over trusting a number written here.

## Licence

MIT. See `LICENSE.md`.
