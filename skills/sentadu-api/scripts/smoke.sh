#!/usr/bin/env sh
# Prove an API key works and that the response envelope is what a client expects.
#
# Usage:
#   export SENTADU_API_KEY='sdk_live_xxxxx.your-secret'
#   ./smoke.sh            # live
#   ./smoke.sh --sandbox   # use a sdk_test_ key from SENTADU_SANDBOX_KEY
#
# Exits non-zero with a specific message on the first problem, so a failure tells
# you which half of the integration is wrong: the account, the key, or the shape.

set -eu

BASE="${SENTADU_BASE:-https://api.sentadu.com/v1}"
KEY="${SENTADU_API_KEY:-}"

if [ "${1:-}" = "--sandbox" ]; then
  KEY="${SENTADU_SANDBOX_KEY:-}"
  [ -n "$KEY" ] || { echo "FAIL: SENTADU_SANDBOX_KEY is not set" >&2; exit 2; }
fi

[ -n "$KEY" ] || {
  echo "FAIL: SENTADU_API_KEY is not set" >&2
  echo "  export SENTADU_API_KEY='sdk_live_xxxxx.your-secret'" >&2
  exit 2
}

# The secret is base64url and may contain - and _, which an unquoted shell word
# will not always survive. Quoting here and everywhere below is deliberate.
request() {
  curl -sS --max-time 20 \
    -H "Authorization: Bearer $KEY" \
    -H "Accept: application/json" \
    "$BASE$1"
}

echo "base:  $BASE"
echo "key:   ${KEY%%[.]*}.[redacted]"

echo
echo "== GET /me =="
ME="$(request /me)" || { echo "FAIL: request failed" >&2; exit 1; }

case "$ME" in
  *'"code"'*'invalid_api_key'*) echo "FAIL: key rejected. Check for a newline or a lost character." >&2; exit 1 ;;
  *'"code"'*'subscription_inactive'*) echo "FAIL: key is valid but the account has no live subscription." >&2; exit 1 ;;
  *'"data"'*) : ;;
  *) echo "FAIL: response is not the {data} envelope: $ME" >&2; exit 1 ;;
esac

echo "$ME" | grep -o '"tier":"[A-Z]*"' | head -1
echo "$ME" | grep -o '"status":"[A-Z]*"' | head -1
echo "$ME" | grep -o '"key_mode":"[A-Z]*"' | head -1

echo
echo "== GET /packages?limit=3 =="
PKG="$(request '/packages?limit=3')" || { echo "FAIL: request failed" >&2; exit 1; }

case "$PKG" in
  *'"data"'*) : ;;
  *) echo "FAIL: package list is not the {data} envelope: $PKG" >&2; exit 1 ;;
esac

COUNT="$(echo "$PKG" | grep -o '"package_code"' | wc -l | tr -d ' ')"
[ "$COUNT" -gt 0 ] || { echo "FAIL: package list came back empty" >&2; exit 1; }
echo "packages in this page: $COUNT"

echo
echo "OK: the key works and the envelope is intact."