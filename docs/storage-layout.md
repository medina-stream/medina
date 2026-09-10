# Persistent storage layout

This is a map of Medina's **artifact keys**, not an exhaustive file listing.
A key is a normalized relative path; `DATA_DIR` (default: `data/artifacts`) is
prepended for local storage. For example, the local path for
`journal/journal-v12/2026-09-09/<hash>.json` is
`data/artifacts/journal/journal-v12/2026-09-09/<hash>.json`.

The bucket has two roles:

- `capture/…` is the durable archive of irreplaceable capture evidence. Its
  keys mirror local capture keys exactly, so restoring those files is a plain
  object sync.
- An optional inbound prefix (`BUCKET_PREFIX`, e.g. `recordings/`) is a source
  of recordings to ingest. Those externally supplied keys are not rewritten
  until their content becomes a capture.

`<captureId>` is normally the 64-hex SHA-256 of bytes that entered through a
local/HTTP/bucket capture path. Remote Drive captures instead use the stable
Drive file id plus revision because Medina deliberately never reads their bytes.
`<hash>` and `<basisHash>` are content/input hashes. Examples are illustrative,
not observed data.

## At a glance

| Namespace | Example key | Where | Expected scale |
| --- | --- | --- | --- |
| Original capture and evidence | `capture/a3…f9/20260909T081500.m4a` | bucket; local too for local/HTTP inputs | One namespace per capture; remote Drive originals never enter local storage. |
| Capture metadata | `capture/a3…f9/provenance.json` | local + bucket | Small provenance/probe/timing records; remote Drive capture directories contain metadata only. |
| Archive reconciliation receipt | `archive/archive-v1/a3…f9.json` | local only | One small file per capture. It caches bucket state. |
| Normalized audio | `media/media-v1/a3…f9/chunk-0.ogg` | bucket | Approximately `ceil(audio duration / 1 hour)` Opus chunks plus one local manifest. |
| Transcript | `transcript/assemblyai-u35p-v1/a3…f9.json` | local only | Normalized result, raw vendor result, and a small URL-job receipt. |
| Per-capture attribution | `attribution/attribution-v2/a3…f9/b7…2c.json` | local only | One or more per capture as correction/rule basis changes. |
| Daily outputs | `notes/notes-llm-v4/2026-09-09/c1…8e.json` | local only | One or more revisions per affected day. Journal output follows the same pattern. |
| GPS points | `gps/points-v1/day=2026-09-09/points.parquet` | local only | One overwrite-in-place Parquet partition per UTC day. Rows scale with recorded fixes. |
| Global snapshots | `index/days-v1/d4…aa.json` | local only | A new full-corpus snapshot when its input set changes; can grow with corpus × rebuilds. |

## Capture: the durable boundary

The capture directory is the important, durable unit:

```text
capture/<captureId>/
  <sanitized-original-filename>    # immutable original blob
  provenance.json                  # source identity and every re-sighting
  ffprobe.json                     # lossless probe output, if media was probed
  media-timing.json                # interpreted container timing, if calculated
```

Example:

```text
capture/a3e1…f9/20260909T081500.m4a
capture/a3e1…f9/provenance.json
capture/a3e1…f9/ffprobe.json
```

For local and HTTP captures, that directory contains the original and is
mirrored to the bucket under the exact same keys. For remote Drive allowlist
captures, Transloadit writes the original directly to the corresponding R2 key;
the local directory contains only provenance (and any later metadata):

```text
s3://<bucket>/capture/a3e1…f9/20260909T081500.m4a
s3://<bucket>/capture/a3e1…f9/provenance.json
```

That is intentionally the only general archive contract. Derived artifacts
such as transcripts, journals, indexes, and local media chunks are not copied
by the archive sweep because they can be recreated from capture evidence.

A local receipt records what was confirmed in the bucket:

```text
archive/archive-v1/a3e1…f9.json
```

It is disposable: removing it makes the next archive pass re-check the bucket
rather than blindly re-uploading everything.

## Inbound bucket versus archive bucket

The same bucket can also provide source recordings, under a configured prefix:

```text
recordings/phone/2026-09-09.m4a       # external/inbound example
recordings/bodycam/20260909T081500.m4a
```

Those keys are source identities and may have arbitrary depth. After Medina
downloads one, it hashes the bytes and writes it into `capture/<captureId>/`.
The bucket source ignores `capture/`, `archive/`, `media/`, and `normalize/`
to avoid rediscovering Medina's own output. The configured `BUCKET_LIMIT`
limits how many candidate objects are ingested per pass; it is not a retention
policy.

Transloadit stores the durable one-hour Opus outputs directly in R2:

```text
media/media-v1/a3e1…f9/chunk-0.ogg
media/media-v1/a3e1…f9/chunk-1.ogg
```

Only `media/media-v1/a3e1…f9.json`, the manifest of those remote keys and
offsets, is required locally. Legacy `canonical.ogg` objects are still accepted
as migration inputs, but new workflows do not download them or create local
chunks. AssemblyAI receives short-lived signed URLs for these R2 objects.

## Local working-set and derivation namespaces

```text
# Source state and in-flight coordination
ingest/<source>/<source-file-id-and-revision>.json
inventory/drive/latest.json
allow/drive.json
normalize/transloadit/<captureId>.json     # durable Assembly job receipt
ingest/drive-allow-transloadit/<source-revision>.json  # Drive import/chunk Assemblies
sources/git/<hash-of-notes-repo-url>/       # managed checkout

# Media and transcription
media/media-v1/<captureId>.json             # local manifest of remote chunk keys
media/media-v1/<captureId>/chunk-0.ogg      # R2 only in remote-first flow
transcript/assemblyai-u35p-v1/<captureId>.jobs.json
transcript/assemblyai-u35p-v1/<captureId>.json
transcript/assemblyai-u35p-v1/<captureId>.assemblyai.json

# Correctable interpretation and materialized views
correction/<captureId>.json
attribution/attribution-v2/<captureId>/<basisHash>.json
index/days-v1/<inputHash>.json
search/transcript-search-v1/<inputHash>.sqlite
search/transcript-search-v1/<inputHash>.json
search/transcript-search-v1/latest.json

# Per-day materializations
note/notes-day-v1/2026-09-09.json
notes/notes-llm-v4/2026-09-09/<inputHash>.json
journal/journal-v12/2026-09-09/<inputHash>.json

# GPS
gps/inbox/<timestamp>-<random>.ndjson
gps/points-v1/day=2026-09-09/points.parquet
gps/stays-v1/day=2026-09-09/stays.parquet
gps/movement-v1/2026-09-09/<basisHash>.json
gps/geocode-v1/41.8781_-87.6298.json
gps/geocode-fwd-v1/<normalized-query-hash>.json
```

There are also small singleton/control files, notably `places.json`,
`runs/latest.json`, and `views/days-v3.json`.

## Growth and retention

- **Capture evidence is append-oriented and retained.** A content hash makes a
  blob immutable; its `provenance.json` can grow as the same bytes are
  re-sighted by sources. The implementation exposes no bucket delete path.
- **GPS point and stay partitions are day-addressed.** Point partitions are
  overwritten when that UTC day is compacted, rather than creating a new file
  for each fix batch.
- **Hash-keyed derived files accumulate.** Attribution, day index, search,
  movement, LLM notes, and journal outputs retain prior hash generations.
  This makes writes atomic and caches explainable, but there is no general GC
  yet. Their long-term count is roughly affected days/captures × input changes.
- **Transient namespaces should stay small in healthy operation.**
  `gps/inbox/`, `normalize/transloadit/`, `tmp/`, and hidden `*.tmp-*` files
  represent work in progress. A crash can leave leftovers; there is no general
  startup cleanup sweep.
- **The workflow mailbox is separate.** `CLUSTER_DB` defaults to
  `data/cluster.db`, outside `DATA_DIR`; production can instead use Postgres.

## Operational implications

1. Back up/version the bucket's `capture/` namespace first. It is the source
   of truth for irreplaceable bytes and provenance.
2. Treat the local `DATA_DIR` as a cache plus working state. Copying it is
   useful for fast recovery, but derived namespaces can be regenerated.
3. Watch two growth modes separately: large original capture bytes in
   `capture/`, and unbounded hash generations in the local derived namespaces.
4. A future retention/GC policy should explicitly preserve `capture/` while
   pruning superseded hash generations and stale temporary work.
