# Redacting a Sentadu payload

These are the fields that must not reach a log, a trace, or an error reporter, and the smallest
code that keeps them out. Every one of them appears in a real response, so a blanket "do not log
responses" is not a rule anyone follows for long: it survives until the first hard bug.

## The fields

| Field | Appears in | Why |
| --- | --- | --- |
| `Authorization` header | every request | It is the API key |
| `secret` | the create-key response | Plaintext, returned once |
| `pin`, `puk` | `GET /esims/{id}?include=secrets` | eSIM install credentials |
| `lpa`, `qr_code_url` | `GET /esims/{id}` | Installs the plan on a device |
| `whsec_` value | the create-endpoint response | Forges any delivery to your receiver |

`amount_idr_minor`, `order_id`, `status`, `package_code` and `iccid` are not secret. An `iccid` is
printed on the packaging of a physical SIM and identifies a plan, not a credential.

## Node

```js
const SECRET_KEYS = new Set(["secret", "pin", "puk", "lpa", "qr_code_url"]);

/** Deep copy with the secret fields replaced. Never mutates the input. */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) =>
      SECRET_KEYS.has(key) ? [key, "[redacted]"] : [key, redact(inner)],
    ),
  );
}

/** A key is safe to show as a prefix and nothing else. */
export function maskKey(key) {
  return typeof key === "string" && key.length > 16 ? `${key.slice(0, 16)}...[redacted]` : "[redacted]";
}
```

Two properties worth keeping if you rewrite it: it does not mutate, so the caller still has the
real value to use; and it hides the WHOLE `lpa`, which contains the activation code.

## Go

```go
var secretKeys = map[string]bool{
	"secret": true, "pin": true, "puk": true, "lpa": true, "qr_code_url": true,
}

func Redact(v any) any {
	switch typed := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, inner := range typed {
			if secretKeys[key] {
				out[key] = "[redacted]"
				continue
			}
			out[key] = Redact(inner)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i, inner := range typed {
			out[i] = Redact(inner)
		}
		return out
	default:
		return v
	}
}
```

## PHP

```php
const SECRET_KEYS = ['secret', 'pin', 'puk', 'lpa', 'qr_code_url'];

function redact(array $payload): array
{
    foreach ($payload as $key => $value) {
        if (in_array($key, SECRET_KEYS, true)) {
            $payload[$key] = '[redacted]';
        } elseif (is_array($value)) {
            $payload[$key] = redact($value);
        }
    }

    return $payload;
}
```

## The header, which is not in the body

Redaction of the payload does nothing for the key itself, because the key travels in a header.
Whatever captures request headers, including a framework's default access log, is the leak.

- **Express:** the default logger does not record headers, but `morgan` with a custom token
  might. Log `req.method` and `req.path`, never `req.headers`.
- **Next.js:** middleware that logs `request.headers` records the bearer token. Log the path.
- **Fetch wrappers:** an error path that dumps the whole request options object dumps the
  `Authorization` header with it.

If you need to identify a key in a log, log the 8-hex prefix. It is public by design, it names
the row, and it authorises nothing.

## What to do when one has already leaked

The value, not the channel, is what matters:

- **API key:** revoke it and mint a new one. Revocation is immediate; there is no grace window.
- **Webhook secret:** delete the endpoint and create a new one. The secret is shown once and
  there is no reveal, so a lost or leaked one has no recovery path but replacement.
- **`pin`/`puk`/`lpa`:** the eSIM is compromised in the sense that someone else can install and
  use the plan. Suspend or revoke the eSIM.

Rotating the value in place does not undo a leak of the old one, and "it was only in a private
repo" is not a boundary once the repository has been cloned.
