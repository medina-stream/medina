# Capture policy

The recorder app is provisioned from a single **capability URL**. The URL
itself is the credential: whoever holds it can fetch the policy, and the
policy tells the app everything — audio format and cadence, GPS behavior,
and the upload destination *including its secrets*. The app stores only the
bootstrap URL plus its encrypted last-known-good policy.

## Server

Implementation: `lib/capture/CapturePolicy.ts`, routes in
`example-lifelog/main.ts`. State lives under the data dir in
`capture-policy/` (`policy.json` mode `0600` inside a `0700` directory).
Only SHA-256 hashes of tokens are persisted; raw tokens are shown once, at
issuance.

| Route | Access |
|---|---|
| `GET /api/capture-policy/:token` | Public — the token *is* the credential. Unknown/revoked → 404 |
| `POST /api/capture-policy/tokens` | Full-access gate. Body: `{ "label" }` → `{ id, token, url }` (201) |
| `GET /api/capture-policy/tokens` | Full-access gate. Lists tokens without hashes |
| `POST /api/capture-policy/tokens/:id/revoke` | Full-access gate → 204 (unknown id → 404) |
| `PUT /api/capture-policy` | Full-access gate. Replaces the policy after schema validation (400 on invalid) |

Policy sections: `audio` (enabled, codec, channels, sample rate, bitrate,
segment length — segments always align to wall-clock boundaries that are
multiples of the segment length since the epoch, so 15-minute segments start
at :00, :15, :30, :45; a capture that begins mid-segment records a truncated
first segment, then full aligned segments), `gps` (enabled, interval, min movement, max accepted
accuracy), `upload` (endpoint, bucket, region, prefix, access key, secret
key, unmetered-only). Unknown JSON fields are tolerated; the app rejects
unsupported versions and out-of-range values. Reads hit disk on every
fetch — a policy edit is effective immediately, no restart.

## Issuing a device URL

```bash
# authenticated as a full-access user
curl -X POST https://<host>/api/capture-policy/tokens \
  -H 'content-type: application/json' -d '{"label":"Pixel 10a"}'
# → { "id": ..., "token": "cpol_…", "url": "https://<host>/api/capture-policy/cpol_…" }
```

Hand the `url` to the device owner through a private channel. It is shown
once; it cannot be recovered later (only revoked and re-issued).

## Rotating upload credentials

1. Mint the new bucket credentials.
2. On medina-dev, in your own terminal (never paste secrets into chat):

   ```bash
   DATA_DIR=/mnt/archil/medina bun scripts/capture-policy-set-upload.ts \
     --bucket sco-lifelog-in --prefix capture/
   ```

   The secret is prompted with echo disabled and never printed. The new
   policy validates before it is written and takes effect immediately.
3. Devices pick it up on their next refresh (every 6h, or immediately on
   app start). As a backstop, the app refreshes the policy once and retries
   the failed upload after an HTTP 403, so a rotation mid-flight heals
   itself.

## Revocation

`POST /api/capture-policy/tokens/:id/revoke` (204). The app treats a 404 on
refresh as "this URL is dead": it keeps capturing against its cached
policy but marks the policy revoked in the status UI and stops trusting
the URL until a new one is entered.

## App behavior (android-capture)

- The policy URL field replaces the manual bucket-credentials UI; both the
  URL and the cached policy are encrypted with the Android Keystore.
- Last-known-good policy stays active through transient fetch failures.
- Until a valid policy with credentials has been fetched, previously
  hand-entered bucket settings remain as a migration fallback.
- Policy changes restart audio/GPS capture with the new parameters.
- Status screen shows policy / audio / location / upload rows, including
  stale, revoked, and error states.
