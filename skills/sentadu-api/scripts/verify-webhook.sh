#!/usr/bin/env sh
# Recompute a Sentadu webhook signature from a captured request.
#
# Usage:
#   ./verify-webhook.sh <secret> <signature-header> <body-file>
#   ./verify-webhook.sh whsec_abc123 't=1750000000,v1=6f1c...' ./body.json
#
# Prints OK or FAIL with the expected value, so a receiver that never verifies
# can be diagnosed without guessing. The most common cause is hashing a
# re-serialised body: this script hashes the file's bytes exactly as they are.

set -eu

SECRET="${1:-}"
HEADER="${2:-}"
BODY_FILE="${3:-}"

[ -n "$SECRET" ] || { echo "usage: $0 <secret> <signature-header> <body-file>" >&2; exit 2; }
[ -n "$HEADER" ] || { echo "usage: $0 <secret> <signature-header> <body-file>" >&2; exit 2; }
[ -f "$BODY_FILE" ] || { echo "FAIL: no such file: $BODY_FILE" >&2; exit 2; }

# Header looks like: t=1750000000,v1=6f1c...
T="$(printf '%s' "$HEADER" | tr ',' '\n' | sed -n 's/^t=//p')"
V1="$(printf '%s' "$HEADER" | tr ',' '\n' | sed -n 's/^v1=//p')"

[ -n "$T" ] || { echo "FAIL: no t= in the signature header" >&2; exit 2; }
[ -n "$V1" ] || { echo "FAIL: no v1= in the signature header" >&2; exit 2; }

# The signed string is "<t>.<rawBody>", not just the body.
#
# THE BODY IS CONCATENATED AS BYTES, NOT VIA `$(cat FILE)`. Command substitution
# strips EVERY trailing newline, and a JSON file that ends in one (which is what
# an editor writes) then hashes differently from what the server signed. This
# script exists to prove a receiver's verification is right, so a false FAIL here
# sends someone debugging code that was already correct. `{ printf; cat; }` keeps
# the bytes exactly, and the timestamp is prepended in the same subshell so the
# hash reads one continuous stream.
EXPECTED="$({ printf '%s.' "$T"; cat "$BODY_FILE"; } \
  | openssl dgst -sha256 -hmac "$SECRET" -r \
  | cut -d' ' -f1)"

NOW="$(date +%s)"
AGE=$((NOW - T))
if [ "$AGE" -gt 300 ]; then
  echo "WARN: timestamp is ${AGE}s old. A receiver should reject it (limit 300s)."
elif [ "$AGE" -lt -300 ]; then
  echo "WARN: timestamp is in the future by $((0 - AGE))s."
fi

if [ "$EXPECTED" = "$V1" ]; then
  echo "OK: signature matches."
else
  echo "FAIL: signature does not match." >&2
  echo "  expected: $EXPECTED" >&2
  echo "  received: $V1" >&2
  echo "  Most likely cause: the body was parsed and re-serialised before hashing." >&2
  exit 1
fi