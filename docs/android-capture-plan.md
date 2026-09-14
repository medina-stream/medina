# Native Android capture app prototype plan

Status: design only; no Android or server implementation is included here.

## 1. Purpose and success criteria

Build a private, native Android app that replaces the current EasyVoice +
GPSLogger capture workflow. It continuously records lifelog audio and location,
survives ordinary Android lifecycle events, keeps the only phone-side copy until
Medina has durably accepted it, and syncs opportunistically.

The prototype succeeds when it can run for several days on the intended phone
and demonstrate all of the following:

- Audio and location capture continue while the UI is closed, with an honest,
  persistent foreground-service notification.
- Completed audio segments and location batches survive process death, reboot,
  network loss, and an interrupted upload.
- Every queued item is either pending locally or has a verifiable Medina
  receipt. An ambiguous response causes a retry, never deletion.
- Re-uploading any item is harmless. Server and client converge without two
  lifelog entries for the same evidence.
- The UI makes capture state, last fix, queued bytes, last successful sync, and
  actionable failures visible.
- Existing EasyVoice/GPSLogger history continues to work; this is an additive
  ingest path, not a migration of stored evidence.

“Exactly once” below means effectively-once durable ingestion: the phone may
send the same immutable object more than once, but a stable idempotency identity
and server-side deduplication produce one logical capture. A distributed mobile
upload cannot guarantee that a request is transmitted literally once.

## 2. What Medina does today

This section records repository facts that constrain the app design.

### 2.1 Current ingest boundary

The example application exposes `POST /in?source=<label>` in
`example-lifelog/main.ts`.

- `source` defaults to `http` and must match
  `[a-z0-9][a-z0-9-]{0,63}`. `gps-gpslogger` is the documented example.
- An empty body is rejected with HTTP 400.
- A successful parsed GPS post returns
  `{ "ok": true, "points": <count> }`.
- Any other nonempty body goes through `httpIngest` and returns
  `{ "ok": true, "captureId": "<sha256-of-body>", "duplicate": <boolean> }`.
- The handler reads the complete request into memory. There is no request-size
  limit in the route itself, no chunk/range protocol, and no upload-status API.
- The current response is a durable-local acceptance acknowledgement, not an
  archive confirmation: `httpIngest` writes the blob and provenance locally,
  attempts bucket archival, but deliberately still succeeds if archival fails;
  the periodic archive sweep retries it.

Writes are fail-closed. A request is accepted from the configured Tailscale
owner (`INGEST_OWNER`) or from a valid delegated `medina` bearer token. Loopback
is trusted by the broader access check but `POST /in` uses the write check. An
unset `INGEST_OWNER` returns 503; the wrong or unidentified owner returns 403.
The README recommends Tailscale as the transport boundary and says delegated
tokens are opaque, revocable, and currently expire after one hour.

### 2.2 GPS format and flow

`lib/lifelog/Gps.ts` recognizes content, rather than trusting the source label:

- GPSLogger custom-URL form bodies with `lat`, longitude as `lon`, `long`, or
  `longitude`, time as `time`, `timestamp`, or `tst`, and optional speed
  (`s`/`spd`/`speed`/`vel`), altitude (`alt`/`altitude`), accuracy
  (`acc`/`accuracy`), and battery (`batt`/`battery`). Times may be ISO-8601,
  10-digit epoch seconds (fraction allowed), or 13-digit epoch milliseconds.
- Overland-style JSON, `{ "locations": [<GeoJSON features>] }`.
- OwnTracks-style single JSON objects (`_type: "location"` or `lat` + `lon`).

Valid points become canonical rows containing `source`, UTC ISO `ts`, `lat`,
`lon`, nullable `speed`, `alt`, `acc`, and `batt`, plus the verbatim source body
in `raw`. One atomically renamed NDJSON inbox file is written per request.
Hourly compaction merges these into UTC-day Parquet partitions at
`gps/points-v1/day=YYYY-MM-DD/points.parquet`, deduplicating on
`(source, ts, lat, lon)`. Compaction is crash-safe: inbox files are deleted only
after replacement partitions are staged and atomically installed. An
unparseable GPS-looking body falls through to generic blob capture rather than
being discarded.

### 2.3 Audio format and flow

The current audio source imports files from Google Drive or an S3-compatible
inbound prefix. `lib/capture/Audio.ts` streams each file to a temporary local
file while calculating SHA-256, atomically installs it at
`capture/<sha256>/<original-filename>`, records provenance, and uses a source
receipt to avoid downloading the same source revision again.

The observed recorder naming convention is
`sco-lifelog-0YYYYMMDDThhmmss.m4a`. The attribution code also recognizes common
`YYYY-MM-DD HH.MM.SS` variants and basic `YYYYMMDDThhmmss` embedded in a name.
Filename time is a zone-less local wall clock. For the observed Android
recorder, MP4/M4A container creation time means recording end, so Medina
subtracts encoded duration; filename and container-derived starts agreed
within two seconds for 31 of 32 measured recordings. The earlier estimate wins
when pausing makes encoded duration shorter than elapsed time. Source modified
time is only a low-confidence fallback.

Downstream media probing uses `ffprobe`, detects an audio stream regardless of
container extension, normalizes to mono 16 kHz Opus at 24 kbit/s in one-hour
chunks, archives capture evidence under matching `capture/...` keys, and then
transcribes and attributes it into days and journals.

The generic HTTP route is not a sound large-audio contract yet. It buffers the
whole body and synthesizes a receipt-time filename. Its extension mapping only
preserves JSON, CSV, and text; an `audio/mp4` body is named `.bin`. `ffprobe`
can still identify the audio for normalization, but the `.bin` name prevents
the separate MP4 timing reader from finding it and loses the original filename
clock evidence. The Android app therefore needs the server extension in
section 7 rather than sending full recordings to legacy `/in`.

### 2.4 Durable boundary

Medina treats `capture/<captureId>/` as irreplaceable evidence. Local/HTTP
captures contain the original blob and provenance; the archive sweep mirrors
them to the bucket. Derived media, transcript, attribution, GPS, and journal
artifacts can be regenerated. This suggests two distinct receipt strengths:

1. **accepted**: atomically present in Medina's local capture/inbox store;
2. **archived**: also verified in the durable capture bucket.

For the prototype, phone deletion may default to `accepted`, matching current
`POST /in` semantics, but the UI should offer “delete after archived” for the
stronger guarantee. Production should default to `archived` if the Medina host
is not itself durably backed up.

## 3. Stack and project shape

Create a separate Gradle Android application module (proposed directory
`android-capture/`) once implementation begins. Keep its protocol schema and
server contract documented beside Medina; do not make the TypeScript project
responsible for building the APK.

- **Language:** Kotlin, with coroutines and `Flow`. Kotlin provides first-class
  Android tooling, structured cancellation, and less lifecycle-prone async code
  than callbacks.
- **Build:** Gradle wrapper, Android Gradle Plugin, Kotlin plugin, Kotlin DSL,
  a version catalog, Java/Kotlin toolchain 17, reproducible lockfiles, and CI
  tasks for lint, unit tests, instrumentation tests, and release assembly. Pin
  exact versions selected during the implementation spike rather than putting
  floating versions in this plan.
- **SDK:** target and compile against the current stable Android SDK at build
  time. Proposed `minSdk = 26` (Android 8.0): it covers foreground-service and
  background execution behavior that the app is explicitly designed around,
  permits modern Java APIs through desugaring, and avoids a large legacy test
  matrix. Confirm the intended phone is API 26+ before scaffolding. Raising the
  minimum to 29 would simplify some behavior but is not necessary.
- **UI:** Jetpack Compose + Material 3, Navigation Compose, lifecycle-aware
  state collection, and a small single-activity UI. There is no reason for XML
  screens in a new internal prototype.
- **Persistence:** Room over SQLite for the queue/state machine; Android
  internal app storage for immutable blobs; Preferences DataStore for small
  user settings only. Room transactions, constraints, and migrations are more
  important here than minimizing dependencies.
- **Deferred work:** WorkManager with CoroutineWorker. It supplies persisted,
  constraint-aware work, retry, and OS scheduling; it does not own live audio
  or location capture.
- **Location:** Google Play services Fused Location Provider where the target
  device has Play services, behind a narrow `LocationEngine` interface. Add an
  Android `LocationManager` implementation only if non-GMS devices are a real
  requirement; do not carry two engines speculatively.
- **Audio:** platform `MediaRecorder` initially, writing AAC-LC in MPEG-4/M4A.
  It has fewer moving parts than a custom `AudioRecord` + codec/muxer pipeline
  and matches Medina's proven MP4/M4A timing path. Hide it behind an
  `AudioRecorder` interface so an `AudioRecord` implementation can be added if
  level metering, gap control, or device-specific reliability requires it.
- **HTTP:** OkHttp with streaming request bodies, interceptors for auth and
  request IDs, strict timeouts, and TLS. Kotlin serialization encodes protocol
  JSON. Do not load an entire recording into memory.
- **Dependency injection:** manual constructor injection with a small
  application container for the prototype. Hilt can be added if object graph
  size warrants it; reliability does not require an annotation processor.
- **Testing:** JUnit, kotlinx-coroutines-test, Room in-memory tests, MockWebServer,
  WorkManager testing, and device/instrumentation tests. Use Android Test
  Orchestrator for destructive lifecycle cases where useful.

## 4. Architecture

### 4.1 Ownership and component boundaries

Use one user-started `CaptureService` promoted immediately to a foreground
service with both `microphone` and `location` service types. It owns the live
recorder and location subscription, exposes immutable status to the UI, and
keeps capture lifetimes coordinated. The persistent notification shows audio
state, last-fix age, and queued count, and has explicit Stop, Pause audio, and
Sync actions.

The service is not the queue. A process death may destroy all in-memory state;
completed files and Room rows remain authoritative. Components are:

- `AudioCapture`: rolls bounded segments, finalizes each file, validates it,
  hashes it, then enqueues it transactionally.
- `LocationCapture`: accepts fixes, applies quality/rate policy, and writes
  them directly to Room in small transactions. It never waits for the network.
- `SpoolRepository`: the sole owner of queue state transitions and retention.
- `SyncScheduler`: enqueues unique WorkManager jobs on new data, connectivity
  changes as observed through WorkManager constraints, and user request.
- `SyncWorker`: claims eligible immutable items, talks to the ingest API,
  verifies receipts, and performs acknowledged cleanup.
- `Recovery`: runs at application/service start and scans only the app's known
  spool directories to reconcile temporary/final files with Room.
- `BootReceiver` and `PackageReplacedReceiver`: restore the user's desired
  capture state within current Android foreground-service restrictions.

Do not run upload networking in the capture service. Capture should remain
healthy if sync is wedged, and WorkManager should remain free to stop/retry a
worker without stopping the microphone.

### 4.2 Capture state model

Persist user intent separately from observed runtime state:

- desired: `STOPPED`, `RUNNING`, or `AUDIO_PAUSED`;
- observed per sensor: `STARTING`, `ACTIVE`, `DEGRADED`, `STOPPED`, `ERROR`;
- reason and timestamp for every degradation.

All starts that require microphone/location while-in-use capability originate
from a visible activity or an explicit notification action. On Android 12+
background foreground-service starts are restricted; on Android 14+ creating a
microphone/location foreground service from the background can fail immediately
without the required while-in-use state. Therefore a boot receiver must not
promise silent microphone restart on modern Android. After reboot it restores
queue/sync scheduling and posts a “Tap to resume capture” notification; tapping
opens/uses a user-visible action and starts the service. Location-only automatic
restart may be enabled only after device-version testing and background-location
permission, but a single predictable tap-to-resume flow is preferred for MVP.

### 4.3 Local spool and atomicity

Use credential-encrypted internal storage, with no broad/shared-storage
permission:

```text
files/spool/audio/YYYY/MM/DD/<capture-uuid>.recording
files/spool/audio/YYYY/MM/DD/<capture-uuid>.m4a
files/spool/photo/...                         # reserved, not MVP
cache/upload/...                              # recreatable only
Room database                                 # metadata, fixes, batches, receipts
```

Never expose `.recording` files to sync. Segment finalization is:

1. Start a Room `audio_segment` row in `RECORDING` and write to `.recording`.
2. Stop/release the recorder, fsync/close, inspect nonzero length and container
   duration, compute SHA-256 by streaming, and atomically rename to `.m4a`.
3. In one Room transaction, store final size/hash/end metadata and change the
   row to `READY`. If the process dies between rename and transaction, recovery
   imports the orphan by UUID; if it dies before rename, recovery validates and
   finalizes or quarantines the partial.

SQLite stores location fixes until a batch is sealed. Sealing creates an
immutable canonical JSON payload in internal storage (or a stable canonical
byte representation reproducible from frozen rows), calculates its SHA-256,
and inserts the upload item in one transaction. Prefer a payload file so retries
send byte-identical content and have a content identity. Delete source fix rows
only after the sealed payload exists and is referenced.

Queue states are `RECORDING`, `READY`, `UPLOADING`, `AWAITING_CONFIRMATION`,
`ACKNOWLEDGED`, `DELETE_PENDING`, `DONE`, `QUARANTINED`, and permanent
`BLOCKED`. Transitions use Room transactions and compare-and-set guards. On
startup, stale `UPLOADING` rows return to `READY` or query their server session;
no state relies on a running coroutine.

Retention is acknowledgment-driven, not age-driven. Normal policy deletes the
local payload only after a signed/authenticated server response or subsequent
status query confirms the expected object ID, byte count, and SHA-256 at the
configured durability level. Then unlink the file, fsync its parent where the
platform permits, and mark `DONE`. A failed unlink remains `DELETE_PENDING`.
Keep small receipt rows for at least 90 days (configurable) to explain and
deduplicate past work. Never automatically delete unacknowledged evidence just
because it is old.

## 5. Data model and capture policy

### 5.1 Common metadata

Every logical item has:

- random UUIDv4 `clientItemId`, generated once and persisted before capture;
- stable installation UUID (`deviceId`; random, not hardware identifier);
- schema version and app version;
- `kind` (`audio`, `locations`, later `photo`);
- `startedAtUtc` and `endedAtUtc` as epoch milliseconds plus ISO rendering;
- elapsed-realtime nanoseconds captured alongside wall time at start/end;
- IANA time-zone ID and numeric UTC offset at capture time;
- boot ID/session nonce so monotonic values are never compared across boots;
- size, SHA-256 of exact uploaded bytes, media type, and original filename;
- capture settings and relevant permission/battery/storage state;
- server receipt ID, confirmed hash/size, acceptance time, durability, and last
  error once known.

Treat device wall time as evidence, not unquestioned truth. Store both wall and
monotonic clocks. Estimate discontinuities by periodically sampling
`wallMillis - elapsedRealtimeMillis`; record a clock-change event when it jumps.
Also retain server receipt time and optional response `serverTime`. Never
rewrite original times on the phone. Medina attribution can later choose among
container time, filename, phone metadata, server time, and explicit correction.

### 5.2 Audio

Default to continuous 15-minute segments, mono AAC-LC, 16 kHz if the device's
encoder supports it, at 24–32 kbit/s, in MPEG-4 (`audio/mp4`, `.m4a`). Query and
record the actual encoder configuration. Fifteen minutes caps loss from a bad
container/finalization and makes retry practical without creating thousands of
tiny files. Start the next recorder immediately after finalizing the prior one;
measure and record any inter-segment gap. If gapless rollover proves unreliable,
evaluate `AudioRecord` + `MediaCodec` rather than hiding gaps.

Use a compatibility-preserving filename such as
`medina-0YYYYMMDDThhmmss-<uuid-prefix>.m4a`, where the timestamp is local start
wall time. The UUID is the true client identity; the timestamp remains useful
evidence for the existing Medina filename rules. Upload the original filename
explicitly so the server does not synthesize it.

Persist recorder stop reason (`scheduled_rollover`, `user`, `process_recovery`,
`storage_pressure`, `permission_revoked`, `audio_focus/device_error`) and actual
duration. Do not pause a segment with `MediaRecorder.pause()` in MVP: stop and
seal it, then begin a new segment, so encoded duration and wall duration remain
easy to interpret.

### 5.3 Location

Store each accepted fix with UTC wall timestamp, elapsed realtime, latitude,
longitude, horizontal accuracy, altitude and its accuracy when available,
speed and its accuracy, bearing, provider/mock flag, battery percentage,
charging state, and capture-policy version. Preserve nullable values; do not
invent zeroes.

Seal a batch at 100 fixes, 15 minutes, or roughly 256 KiB, whichever comes
first. Encode it in the already-supported Overland shape for immediate legacy
compatibility, putting the canonical fields Medina reads in each feature's
`properties`. Extra metadata may be retained in properties but the proposed v1
server should validate and preserve the exact raw payload. Use source
`gps-medina-android`.

Initial adaptive policy:

- moving: request approximately every 30 seconds / 50 metres, balanced power;
- stationary: back off to 2–5 minutes and accept batched fixes;
- screen/UI “high detail” mode: 5–10 seconds for a bounded, visible session;
- discard impossible coordinates and fixes above a configurable accuracy
  threshold (initially 100 m), while recording rejection counters;
- use passive/opportunistic fixes where available and avoid forcing continuous
  high-accuracy GNSS.

Tune against observed stay/movement quality. Medina currently deduplicates by
`(source, ts, lat, lon)`, so retries are safe, but distinct same-time fixes are
not collapsed unless coordinates match.

### 5.4 Future photos

Reserve `kind=photo` and the shared metadata/spool machinery, but request no
camera or media-library permission in MVP. Later capture should be explicitly
user initiated with CameraX, write an immutable JPEG/HEIC plus EXIF and the same
receipt flow, and use Android's Photo Picker for importing existing images.
Photos must not be silently continuous or bundled into the audio permission UX.

## 6. Reliability design

### 6.1 Foreground capture

- Start from a visible setup/status activity after permissions are granted and
  call `startForeground()` immediately with declared `microphone|location`
  types and the corresponding foreground-service permissions required by the
  target SDK.
- Keep one ongoing low-priority notification that truthfully says which sensors
  are active. A dismissed/disabled notification is a setup error, not a hidden
  mode. Request `POST_NOTIFICATIONS` where applicable.
- Return an appropriate sticky mode but never depend on it. Rebuild state from
  Room and files. If Android recreates the service with a null intent, resume
  only when persisted desire and current permission/user-initiation rules allow.
- Catch recorder and location failures separately. A GPS failure must not stop
  audio, and an audio failure must not discard GPS. Retry bounded transient
  failures and surface persistent ones in the notification/UI.
- Register callbacks for permission/app-op changes where possible and recheck
  before every sensor start. Seal the current segment before stopping.

### 6.2 WorkManager sync

Maintain unique work names so new items coalesce rather than launch parallel
sync storms. Default automatic sync requires network connectivity. User options
add `UNMETERED`, `CHARGING`, and minimum-battery/storage preferences; “sync now”
may relax cost constraints after an explicit warning but still requires a
network. A useful default is: GPS on any validated network, audio on unmetered
or charging, with a maximum wait (for example 24 hours) after which the UI asks
rather than silently overriding the user's data-cost preference.

Use WorkManager exponential backoff beginning around 30 seconds, plus
server-provided `Retry-After` and randomized jitter in protocol scheduling.
Cap retries at a few hours while leaving the item queued forever. Do not map
auth failure, unsupported schema, checksum mismatch, quota/storage-full, and
ordinary 5xx/network loss to the same state:

- timeouts, disconnects, 408, 425, 429, and 5xx: retry;
- 401: refresh/re-enroll once, then block and notify;
- 403: permanent configuration block until user action;
- 409: query status; accept only if identity/hash/size match, otherwise block;
- 413: reduce part size or require protocol/server change, never drop;
- checksum/schema 4xx: quarantine/block with diagnostics;
- server storage failure: retry without deleting local bytes.

Doze may defer WorkManager and network; that is acceptable because capture is
local-first. Do not use exact alarms or wake locks to defeat Doze for routine
sync. The live foreground service may use only narrowly scoped wake locks if
device testing proves the recorder/location pipeline otherwise sleeps, and
must release them defensively.

### 6.3 Battery-optimization UX

The setup checklist explains why continuous lifelog capture is unusually
sensitive to vendor battery managers. First run requests only necessary runtime
permissions, starts capture through a visible action, and measures health.
Offer a separate “Improve reliability” screen that:

- shows whether the app is battery-optimized and links to the appropriate
  system settings using documented intents;
- explains the consequence before asking for an exemption and tolerates denial;
- provides vendor-neutral troubleshooting (pin/lock app if the OS offers it,
  allow background activity, allow autostart) without pretending undocumented
  settings are portable;
- runs a 30-minute self-test and reports segment continuity, fix gaps, and sync;
- never loops permission/settings prompts.

Distribution policy matters: requesting broad battery-optimization exemption
or background location can trigger Play policy review. For a private/sideloaded
prototype, document the tradeoff; for Play distribution, complete the required
prominent disclosure and policy justification.

### 6.4 Reboot, upgrade, force-stop, and process death

- `BOOT_COMPLETED`/`LOCKED_BOOT_COMPLETED`: schedule recovery/sync if storage is
  accessible and show the tap-to-resume notification. Do not store sensitive
  payloads in device-protected storage merely to record before first unlock.
- `MY_PACKAGE_REPLACED`: restore schedules and reconcile spool state, with the
  same foreground-start constraints.
- Force-stop is not recoverable by design until the user launches the app; say
  so in diagnostics.
- On recorder process death, a partial MPEG-4 may lack its final index. Recovery
  validates it with `MediaExtractor`; if readable, seal and mark truncated. If
  not, quarantine it and retain bytes for manual recovery rather than delete.
- On upload process death, the immutable file and upload session remain. A new
  worker asks the server which parts it has and resumes; if status is unknown,
  it safely starts the idempotent session again.

### 6.5 Storage pressure and integrity

Track free bytes before starting and before each segment rollover. Initial
watermarks should be configurable and validated on-device:

- warning below max(2 GiB, 10% free);
- shorten segments and prioritize sync below 1 GiB;
- below 512 MiB, seal the current recording safely, stop audio, continue
  low-volume GPS if safe, and raise a high-visibility notification.

Never evict unacknowledged captures automatically. Cleanup order is cache,
acknowledged payloads awaiting unlink, expired receipt metadata, then stop
capture. Provide an explicit export/recovery action before any user-confirmed
deletion of unacknowledged data.

Calculate SHA-256 after finalization and before READY. Before each upload,
verify size; rehash if file metadata changed or after recovery. The server
hashes bytes while streaming to a temporary file, verifies declared length and
digest, atomically installs by content hash, then records the idempotency
mapping. A mismatch never earns a receipt.

## 7. Sync protocol and Medina server extension

### 7.1 Compatibility strategy

MVP can send location batches directly to existing
`POST /in?source=gps-medina-android` and treat HTTP 2xx plus the returned point
count as accepted. Because that response has neither item ID nor body hash, the
phone should retain the batch until it verifies the expected count and should
record the exact response. Retries remain logically safe because Parquet
compaction deduplicates points.

Audio must wait for the v1 endpoint below. Prefer using the same v1 protocol for
both kinds as soon as it exists; it provides a real status/receipt handshake
and preserves metadata. Keep `/in` unchanged for GPSLogger and other legacy
clients.

### 7.2 Proposed REST shape

All routes live beside existing `/in`, use HTTPS over the tailnet/proxy, accept
the same write authorization initially, and return JSON. Names are provisional
but deliberately small:

```text
POST /capture/v1/uploads
GET  /capture/v1/uploads/{clientItemId}
PUT  /capture/v1/uploads/{clientItemId}/parts/{partNumber}
POST /capture/v1/uploads/{clientItemId}/complete
GET  /capture/v1/receipts/{clientItemId}
```

Create-session request:

```json
{
  "clientItemId": "uuid",
  "deviceId": "installation-uuid",
  "kind": "audio",
  "source": "audio-medina-android",
  "schemaVersion": 1,
  "filename": "medina-020260914T083000-a1b2c3d4.m4a",
  "contentType": "audio/mp4",
  "size": 4320123,
  "sha256": "64-lowercase-hex",
  "startedAt": "2026-09-14T08:30:00.123Z",
  "endedAt": "2026-09-14T08:45:00.456Z",
  "timeZone": "America/Los_Angeles",
  "utcOffsetSeconds": -25200,
  "metadata": {}
}
```

Also send `Idempotency-Key: <deviceId>:<clientItemId>` and a protocol version
header. The server persists the tuple `(deviceId, clientItemId)` with the
declared hash, size, and immutable metadata. Repeating an identical request
returns the existing session/receipt. Reusing the key with different content or
immutable metadata returns 409 and never overwrites evidence.

The create response gives `uploadId`, accepted part size (proposed 4 MiB),
already-present parts, and state. Part uploads include byte offset, length, and
part SHA-256 headers. The server writes each part to session-scoped temporary
storage and atomically records its digest; resending the same part is safe.
`GET uploads/...` is the resume authority.

`complete` verifies all parts, total length, and whole-file SHA-256 before any
acknowledgement. For audio, it atomically installs the original filename at
`capture/<sha256>/<sanitized-filename>` and writes provenance including client
metadata. This extends `ProvenanceRecord` or adds a versioned sidecar; it must
not squeeze structured timestamps into `modifiedTime`. For locations, it
validates the versioned payload, atomically writes the GPS inbox, and retains
the client-item mapping. Complete is itself idempotent.

Receipt response:

```json
{
  "clientItemId": "uuid",
  "state": "accepted",
  "captureId": "sha256-for-audio-or-payload",
  "sha256": "64-lowercase-hex",
  "size": 4320123,
  "acceptedAt": "server-UTC-instant",
  "durability": "local",
  "archivedAt": null,
  "receiptVersion": 1
}
```

Once the archive sweep verifies all `capture/<id>/` files in the bucket, the
same receipt becomes `state=archived`, `durability=bucket`, with `archivedAt`.
For GPS, define the equivalent durable boundary explicitly: current parsed GPS
inbox/Parquet is local-only and is not in the capture bucket, so “archived” is
not presently available unless the raw batch is additionally retained as
capture evidence or the GPS namespace is backed up. Do not falsely return
bucket durability for GPS.

The client deletes only after a receipt matches `clientItemId`, SHA-256, size,
and its configured durability. A missing/malformed response is ambiguous and
leaves the item queued. Receipt/status lookup resolves a lost final response.

### 7.3 Authentication

For the prototype, use Tailscale reachability and one of:

- owner identity when the Android Tailscale client/proxy produces the identity
  that Medina's existing write check expects; or
- a delegated bearer credential stored in Android Keystore-backed encrypted
  storage.

The current one-hour delegated token flow is awkward for unattended capture.
Do not hard-code a long-lived token in the APK or preferences. The server work
should add a revocable device enrollment credential scoped only to
`capture:write` and receipt reads, with device name, created/last-used time,
rotation, and revoke UI. Until that exists, the prototype may require periodic
interactive reauthorization and must clearly show auth-blocked queue state.
Never log bearer tokens, precise coordinates, filenames, or response bodies in
release logs.

### 7.4 Server implementation invariants

- Stream request parts to bounded temporary files; never `arrayBuffer()` a full
  audio object.
- Put session records and idempotency mappings in transactional durable state,
  not process memory.
- Use compare-and-set completion so two workers cannot create conflicting
  provenance. Existing content-addressed capture IDs deduplicate identical
  audio bytes across client IDs while provenance records each sighting once.
- Atomically rename only after hash verification. Startup/scheduled cleanup may
  remove abandoned session temporaries after a generous TTL, never completed
  captures.
- Return a receipt only after both bytes and the client-item mapping are durable.
- Bound manifest size, metadata depth, part count, filename length, and accepted
  media types. Sanitize filenames using the existing capture helper.
- Add integration tests for duplicate create/part/complete, conflicting key,
  disconnect before/after commit, corrupt part, out-of-order parts, server
  restart, concurrent complete, and archive-status transition.

## 8. Battery, network, and storage budget

These are planning estimates, not promises; measure on the target phone with
Battery Historian/system power stats and at least one 24-hour field run.

### Audio

At 24 kbit/s, encoded audio is about 10.8 MB/hour or 259 MB/day; at 32 kbit/s,
about 14.4 MB/hour or 346 MB/day, plus small container/database overhead. Seven
unsynced days therefore require roughly 1.8–2.4 GB. Reserve at least twice the
planned offline window for rollover, filesystem, and failure margin.

AAC hardware encoding and a single mono 16 kHz stream should be substantially
cheaper than raw PCM or on-device transcoding. Do not transcode to Opus on the
phone in MVP: Medina already performs canonical Opus normalization, and a
second codec path adds heat, battery use, and failure modes. Record only when
the user explicitly enables capture; offer scheduled quiet hours later.

### Location

One compact fix is only hundreds of bytes: even a fix every 30 seconds is
roughly a few megabytes/day including JSON overhead. Radio/GNSS wakeups, not
storage, dominate. Balanced-power fused fixes, displacement thresholds,
batching, passive fixes, and stationary backoff are the main mitigations.
Upload location batches alongside existing network activity rather than waking
the cellular radio for each fix.

### Sync

Resumable 4 MiB parts cap retransmission after interruption. Limit to one audio
upload at a time and one overall worker per installation. Stream from disk with
a small buffer. Default audio sync to unmetered and/or charging based on user
preference; small GPS batches may use any validated network. Display estimated
queued transfer and never silently consume metered data contrary to policy.

## 9. Permissions, security, and privacy

Request permissions progressively, immediately before the associated user
action, with an in-app explanation:

- `RECORD_AUDIO`: continuous ambient audio, core feature.
- `ACCESS_FINE_LOCATION` (and coarse as Android groups require): lifelog fixes.
- `ACCESS_BACKGROUND_LOCATION`: only in a separate step after foreground
  location works, because capture continues when the UI is not visible.
- `FOREGROUND_SERVICE` plus target-SDK-specific
  `FOREGROUND_SERVICE_MICROPHONE` and `FOREGROUND_SERVICE_LOCATION` declarations.
- `POST_NOTIFICATIONS` on Android 13+: capture visibility and recovery actions.
- `RECEIVE_BOOT_COMPLETED`: restore scheduling and prompt to resume.
- `INTERNET` and network-state access: sync.

Do not request contacts, phone state, hardware identifiers, all-files access,
media-library access, exact alarms, or camera in MVP. Respect approximate-only
location by operating at reduced fidelity and showing it in status. Revoking a
permission seals/stops that sensor without deleting prior data.

Payloads remain in internal app storage and are excluded from Android Auto
Backup/cloud backup; Medina is the intended backup target. Protect enrollment
secrets using Android Keystore. Use TLS with normal platform trust validation;
do not ship a trust-all client. A private CA can be explicitly configured for
an internal build, while certificate pinning is deferred unless an operational
rotation process exists.

The lock-screen notification must reveal capture is active but should avoid
precise location, filenames, transcript content, and other sensitive details.
Provide one-tap stop. The app needs a local data screen listing pending and
acknowledged items, an export path for unacknowledged evidence, and deliberate,
confirmed deletion. Release telemetry is off by default and contains no audio,
coordinates, or secrets.

## 10. Phased build plan

### Phase 0 — contract and device spike

- Confirm target devices/API levels, distribution method, Tailscale route, and
  whether phone deletion requires local acceptance or bucket archival.
- Record short M4A samples with `MediaRecorder` across target devices; verify
  `ffprobe`, container creation convention, filename attribution, actual codec,
  restart gap, and behavior across screen-off/Doze.
- Measure baseline EasyVoice and GPSLogger rates/storage for comparison.
- Finalize v1 schemas, canonical hashing bytes, limits, and error codes with
  golden fixtures shared between Kotlin and TypeScript tests.
- Decide the device credential lifecycle. This blocks unattended production
  sync, but not local capture development.

Exit: an approved protocol document, reproducible media fixtures, and measured
device constraints.

### Phase 1 — local-only capture MVP

- Scaffold the Kotlin/Compose app and Room schema/migrations.
- Implement onboarding, progressive permissions, visible user-started
  foreground service, persistent notification, audio rollover, adaptive
  location collection, and atomic spool.
- Implement status/queue UI, recovery scan, storage watermarks, boot/upgrade
  notification, checksums, and manual export.
- Test process kill, service recreation, screen-off overnight, reboot,
  permission revoke, full disk, corrupted partial file, clock/time-zone change,
  and seven-day simulated queue growth.

Exit: capture can run for 24 hours without network and every byte/fix is
accounted for after forced lifecycle failures.

### Phase 2 — legacy-compatible GPS sync

- Add OkHttp and WorkManager sync with constraints/backoff.
- Serialize immutable Overland batches and post them to existing `/in`.
- Store and validate responses; retry ambiguous results; exercise server GPS
  compaction deduplication with repeated batches.
- Add auth-expiry and metered-network UX.

Exit: location flows into existing `gps/points-v1` and lifelog movement without
loss or duplicate logical points.

### Phase 3 — resumable capture API and audio sync

- Implement server session, part, complete, receipt, and archive-status routes
  with streaming hashes and transactional idempotency.
- Preserve original filename and structured timing metadata in versioned
  provenance without breaking existing readers.
- Implement Android resumable uploads, confirmation reconciliation, and
  acknowledgment-driven deletion.
- Run fault-injection tests at every upload boundary and verify audio proceeds
  through probe, normalize, transcribe, attribution, day index, and journal.

Exit: repeated/interrupted uploads yield one content-addressed capture, correct
start attribution, a verifiable receipt, and safe phone cleanup.

### Phase 4 — hardening and daily use

- Multi-day soak tests across Wi-Fi/cellular transitions, Doze, low battery,
  low storage, OS upgrade/app upgrade, server downtime, token rotation, and
  bucket outage.
- Tune audio rate/segment length and GPS policy from measured battery and
  lifelog quality. Add a health report and gap detection.
- Complete privacy disclosure, retention settings, credential enrollment and
  revocation, backup/restore story, signed release builds, and staged rollout.
- Add observability that reports counts/ages/errors without payload content.

Exit: agreed battery/storage budgets and no unexplained capture gaps or unsafe
deletions during a week-long target-device soak.

### Later, explicitly outside MVP

- CameraX photo capture and Photo Picker imports through the same spool/receipt
  protocol.
- Multiple capture profiles, schedules, geofenced rates, and richer audio
  controls.
- Non-GMS location engine if required.
- On-device encryption beyond app sandbox/filesystem encryption, with a tested
  key recovery story.
- End-to-end content encryption would require Medina pipeline changes because
  the server currently probes/transcodes plaintext audio.
- Live streaming, on-device transcription, cloud push messaging, remote control,
  and multi-user sharing.

## 11. Validation matrix and acceptance evidence

Automate or document a repeatable test for each case:

| Failure/event | Expected result |
| --- | --- |
| UI swiped away | Foreground capture continues; status remains truthful. |
| Process killed mid-segment | Partial is recovered or quarantined; prior segments remain READY. |
| Process killed mid-part | Server reports completed parts; retry resumes without corruption. |
| Response lost after complete | Receipt lookup confirms; no second logical capture. |
| Server down for days | Queue grows within forecast; no local deletion. |
| Bucket archive down | `accepted` can remain local; `archived` policy retains phone copy. |
| Reboot | Queue recovers; notification asks user to tap and resume capture. |
| Force-stop | Diagnostics explain capture cannot resume until app launch. |
| Permission revoked | Affected sensor seals/stops; other sensor and queued data survive. |
| Clock/time-zone changed | Both clock domains and zone events preserve interpretable evidence. |
| Low/full storage | Warning, prioritized sync, then safe capture stop; no silent eviction. |
| Duplicate item/key | Identical request returns same receipt; conflicting content returns 409. |
| Hash/length mismatch | Server rejects without receipt; client quarantines or retries appropriately. |
| Metered network | Policy is honored and queued-byte estimate remains visible. |

Release evidence should include a queue ledger before/after each test, server
receipt rows, content hashes on both sides, Medina capture/provenance paths,
GPS point counts after compaction, and observed audio attribution in the day
index.

## 12. Open questions not answered by the repository

- The intended Android device/API level, whether it has Google Play services,
  and whether distribution is private/sideloaded or through Google Play.
- Actual EasyVoice codec, bitrate, segment duration, filenames beyond the
  observed archive convention, and measured battery/storage use.
- Actual GPSLogger sampling, batching, and custom-URL template in use. The
  parser documents accepted fields, but no configuration/export fixture is in
  the repository.
- Whether “server confirms receipt” means Medina local durable storage or the
  capture bucket. Current `/in` acknowledges before bucket archival.
- A maximum HTTP request/body size imposed outside the app (exe.dev proxy,
  reverse proxy, or deployment configuration); the route itself sets none.
- A durable unattended Android authentication/enrollment mechanism. Existing
  delegated access is broad (`medina`) and one hour, while owner identity
  depends on deployment/Tailscale behavior.
- Backup/durability expectations for parsed GPS. Unlike `capture/`, the current
  `gps/` namespace is local-only.
- Target offline retention window and acceptable mobile-data/battery budgets.

These questions should be resolved in Phase 0; none justify weakening the core
rule that unconfirmed local evidence is retained.

## 13. Implementation references

Use current official Android documentation during implementation, especially:

- [Foreground-service launch restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
  for user-visible start, boot, and while-in-use microphone/location rules.
- [Declaring foreground services and type-specific permissions](https://developer.android.com/develop/background-work/services/fgs/declare).
- [Background location access](https://developer.android.com/develop/sensors-and-location/location/background)
  and [the staged background-location request flow](https://developer.android.com/develop/sensors-and-location/location/permissions/background).
- [WorkManager persistent work](https://developer.android.com/develop/background-work/background-tasks/persistent)
  for constraints, retries, and testing.

Repository sources used for this plan are `README.md`, `docs/storage-layout.md`,
`example-lifelog/main.ts`, `example-lifelog/StartTimeHints.ts`,
`lib/capture/HttpIngest.ts`, `lib/capture/Audio.ts`, `lib/capture/Archive.ts`,
`lib/capture/Media.ts`, `lib/lifelog/Gps.ts`, `lib/lifelog/MediaProbe.ts`,
`lib/lifelog/StartTime.ts`, `lib/lifelog/Attribution.ts`, and their relevant
tests.
