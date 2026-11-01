# Verifying a Sentadu signature

The receiver below is the one Sentadu ships in its own docs, with the reasoning kept. It is
correct for any HTTP framework: the only framework-specific part is how you obtain the raw body.

## Node

```js
import crypto from "node:crypto";

/**
 * Returns true only for a live, correctly signed delivery.
 * Never throws: a missing or malformed header is a refusal, not a crash.
 */
export function verify(rawBody, header, secret) {
  if (typeof header !== "string" || !header) return false;

  const parts = Object.fromEntries(header.split(",").map((part) => part.split("=")));
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

Getting `rawBody` from common Node frameworks:

| Framework | Raw body |
| --- | --- |
| Next.js App Router | `const rawBody = await req.text();` before any `req.json()` |
| Express | `app.use(express.raw({ type: "application/json" }))`, then `req.body.toString()` |
| Fastify | `fastify.addContentTypeParser("application/json", { parseAs: "string" }, (_r, body, done) => done(null, body))` |
| Node `http` | collect `data` chunks into a `Buffer` and `concat` |

The mistake to avoid is registering a JSON parser first: once the body is an object, the bytes
are gone and no amount of care downstream recovers them.

## Go

```go
func verify(rawBody []byte, header, secret string) bool {
	var t, v1 string
	for _, part := range strings.Split(header, ",") {
		kv := strings.SplitN(part, "=", 2)
		if len(kv) != 2 {
			continue
		}
		switch kv[0] {
		case "t":
			t = kv[1]
		case "v1":
			v1 = kv[1]
		}
	}
	if t == "" || v1 == "" {
		return false
	}

	ts, err := strconv.ParseInt(t, 10, 64)
	if err != nil || math.Abs(float64(time.Now().Unix()-ts)) > 300 {
		return false
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(t + "."))
	mac.Write(rawBody)
	expected := hex.EncodeToString(mac.Sum(nil))

	return hmac.Equal([]byte(expected), []byte(v1))
}
```

`hmac.Equal` is constant time. `strings.EqualFold` is not.

## PHP

```php
function verify(string $rawBody, ?string $header, string $secret): bool {
    if (!$header) {
        return false;
    }

    $parts = [];
    foreach (explode(',', $header) as $part) {
        $kv = explode('=', $part, 2);
        if (count($kv) === 2) {
            $parts[$kv[0]] = $kv[1];
        }
    }
    if (!isset($parts['t'], $parts['v1'])) {
        return false;
    }

    if (abs(time() - (int) $parts['t']) > 300) {
        return false;
    }

    $expected = hash_hmac('sha256', $parts['t'] . '.' . $rawBody, $secret);
    return hash_equals($expected, $parts['v1']);
}
```

`hash_equals` is the constant-time compare. `hash_hmac` over the concatenated string is
equivalent to writing the timestamp then the body into the HMAC, which is what the Go version
does in two `Write` calls.

## Proving it without a live delivery

`scripts/verify-webhook.sh` in the `sentadu-api` skill does the same computation from a captured
request:

```sh
./scripts/verify-webhook.sh whsec_abc 't=1750000000,v1=6f1c...' ./body.json
```

The script concatenates the bytes with `printf` and `cat` rather than `$(cat file)`, because
command substitution strips every trailing newline and a JSON file that ends in one would then
hash differently from what the server signed.
