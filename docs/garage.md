# Local Garage storage

Medina stores data in an S3-compatible bucket. For local development we recommend Garage because it is lightweight, self-hostable, and close to the storage model Medina uses in production-like deployments.

## Install

Use the Garage package for your platform. Common options:

- macOS: install with Homebrew if Garage is available in your taps, or download a release binary.
- Linux: download the release binary or install from your distribution/package manager if available.
- Nix/containers/system packages are also fine; Medina only needs the S3 API endpoint.

Confirm Garage is installed:

```bash
garage --version
```

## Minimal local setup

Garage requires a config file and a running daemon. A typical local dev config exposes the S3 API on `127.0.0.1:3900` and stores data under a local directory.

After Garage is running, create a bucket and key. Exact CLI details vary by Garage version, but the workflow is:

```bash
# Create a bucket for Medina
garage bucket create medina-dev

# Create an access key
garage key create medina-dev

# Allow the key to read/write the bucket
garage bucket allow \
  --read \
  --write \
  --owner \
  medina-dev \
  --key medina-dev
```

Print or inspect the key to get the access key id and secret key:

```bash
garage key info medina-dev
```

If your installed Garage version uses slightly different subcommands, use the equivalent bucket-create, key-create, and bucket-allow operations from `garage --help`.

## Medina `.env`

Put the Garage values in `.env`:

```env
HOST=127.0.0.1
PORT=3002
MEDINA_ROOT=http://127.0.0.1:3002
MEDINA_TOKEN=replace-with-a-long-random-secret

S3_BUCKET=medina-dev
S3_ENDPOINT=http://127.0.0.1:3900
S3_REGION=garage
S3_ACCESS_KEY_ID=<garage-access-key-id>
S3_SECRET_ACCESS_KEY=<garage-secret-key>
S3_FORCE_PATH_STYLE=true
```

Then start Medina:

```bash
bun install
bun run dev
```

## Useful checks

Check that the bucket is reachable through Medina's configured credentials:

```bash
./scripts/s3 ls s3://medina-dev/
curl http://127.0.0.1:3002/status.json
```

If startup reports an access denied or bucket health error, check:

- Garage daemon is running.
- `S3_ENDPOINT` uses the S3 API port, usually `3900`, not the admin/RPC port.
- `S3_FORCE_PATH_STYLE=true` is set.
- The key has read/write access to the bucket.
- `S3_BUCKET` exactly matches the Garage bucket name.
