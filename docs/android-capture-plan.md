# Native Android bucket capture plan

## 1. Purpose and safety boundary

Build a private, generic Android capture tool that records audio and location
into a local spool and uploads immutable objects directly to an S3-compatible
bucket. It is independent of every downstream consumer.

The bucket credential must be restricted to writing objects in the configured
bucket/prefix. The app never lists, reads, overwrites by discovery, or deletes
remote objects. A successful S3 `PUT` response (HTTP 2xx) is the transfer
confirmation. Once that response is received and recorded transactionally, the
local payload may be deleted. There is no server receipt or confirmation
handshake.

Each object gets a stable, random key before capture is finalized. SQLite keeps
the key and a small `PENDING`/`UPLOADED` manifest. A crash before the successful
response is committed leaves the item pending and causes the same key to be
PUT again. Repeated PUTs are idempotent because the key and bytes are stable.
A crash after the manifest is marked uploaded but before unlink is recovered by
deleting the known local copy. The app never infers upload state by reading or
listing the bucket.

Success means capture and the local spool survive process death, reboot,
network loss, Doze, and interrupted uploads; uploaded files are eventually
removed locally; and pending bytes are never removed automatically.

## 2. Configuration and project shape

Use a standalone Kotlin Android application in `android-capture/` with a Gradle
wrapper, Java 17 toolchain, `minSdk 26`, current compile/target SDK, one Compose
activity, Room over SQLite, WorkManager, OkHttp, and Google Play services Fused
Location Provider. Use manual dependency injection.

Settings collect:

- S3-compatible HTTPS endpoint URL;
- bucket name and region;
- access-key ID and secret-access key;
- optional object-key prefix;
- whether automatic uploads prefer unmetered networks (default on).

Store secrets with an Android Keystore-backed encrypted preference mechanism,
never in logs or the manifest. Validate settings by signing and attempting a
zero-byte `PUT` to `<prefix>probe/<random-uuid>` with `Content-MD5`. The probe is
intentionally left in the write-only bucket because the credential cannot
delete it. Explain that behavior in the UI. Validation must not issue HEAD,
GET, LIST, or DELETE.

## 3. Architecture and local state

A user-started `CaptureService`, immediately promoted to a foreground service
with `microphone|location` types, owns `MediaRecorder` and the fused-location
subscription. Its ongoing notification states that capture is active and
offers Stop and Sync actions. Audio and location fail independently.

The service is not the upload queue. Components are:

- `AudioCapture`: records bounded AAC/MPEG-4 segments, finalizes and validates
  them, calculates MD5, then adds them to the manifest.
- `LocationCapture`: persists accepted fixes, periodically seals them into
  immutable JSON batches, calculates MD5, then adds them to the manifest.
- `SpoolRepository`: owns SQLite rows, file/key creation, state transitions,
  recovery, and acknowledged cleanup.
- `UploadWorker`: streams pending files through signed S3 PUTs and records 2xx
  success before deleting local files.
- `SyncScheduler`: maintains unique constrained WorkManager work with
  exponential backoff.
- `BootReceiver`: reconciles the spool, schedules upload, and posts a tap-to-
  resume notification when capture was desired before reboot.

Internal storage layout:

```text
files/spool/audio/YYYY/MM/DD/<uuid>.recording
files/spool/audio/YYYY/MM/DD/<uuid>.m4a
files/spool/location/YYYY/MM/DD/<uuid>.json
files/spool/photo/YYYY/MM/DD/...              # reserved for later
SQLite manifest                               # stable key, path, MD5, status
```

Manifest rows include UUID, stable object key, kind, local path, content type,
byte count, base64 MD5, creation time, status (`PENDING` or `UPLOADED`), attempt
count, and last error. A worker only operates on `PENDING`. After PUT returns
2xx, it marks the row `UPLOADED` in a transaction and then unlinks the exact
known path. Uploaded rows are kept as a small audit/deduplication record and
may be pruned after 90 days. Recovery retries pending rows, imports valid
finalized orphans when possible, quarantines unusable partial recordings, and
finishes unlinking uploaded rows. It never scans outside app-owned directories.

## 4. Object keys and payloads

Keys are assigned once and never derived solely from timestamps:

```text
<prefix><installation-id>/audio/YYYY/MM/DD/<UTC-start>-<uuid>.m4a
<prefix><installation-id>/location/YYYY/MM/DD/<UTC-start>-<uuid>.json
<prefix><installation-id>/photo/YYYY/MM/DD/<UTC-start>-<uuid>.<ext>  # later
```

Normalize the optional prefix to empty or a trailing slash. Path components
contain only conservative ASCII characters. UUIDs prevent collision and make
re-PUT safe. Payloads are immutable after entering `PENDING`.

Audio defaults to continuous 15-minute segments, mono AAC-LC in MPEG-4/M4A,
16 kHz where supported, at 24–32 kbit/s. Record actual settings, start/end UTC,
elapsed-realtime timestamps, time zone/offset, and stop reason in SQLite. Do not
use `MediaRecorder.pause()`; stop and seal the segment, then start another.

Location uses Fused Location Provider. Start near 30-second/50-metre balanced-
power updates while moving and back off when stationary where practical. Store
UTC and elapsed-realtime timestamps, latitude, longitude, accuracy, optional
altitude/speed/bearing, provider/mock status, and battery state. Reject invalid
coordinates and fixes over the configured accuracy threshold (initially 100 m).
Seal newline-free JSON batches at 100 fixes, 15 minutes, or about 256 KiB.

Photo capture is outside the MVP. It later slots into the same immutable spool
and manifest using user-initiated CameraX capture; request no camera or media
permission now.

## 5. S3 PUT protocol

For every payload, build the path-style or virtual-host request appropriate to
the configured endpoint, sign with AWS Signature Version 4 (`s3` service), and
stream the file with fixed `Content-Length`. Send:

- `Content-Type` for the payload;
- `Content-MD5` (base64 MD5 of the exact bytes);
- `x-amz-content-sha256` and the required SigV4 date/authorization headers.

Use normal TLS validation and bounded connect/write/read timeouts. Never place
credentials in URLs, analytics, notifications, or release logs. Clock skew and
signature/credential errors are configuration failures shown to the user.

Any HTTP 2xx means PUT succeeded. Mark `UPLOADED`, then delete locally. Network
errors, timeouts, 408, 425, 429, and 5xx stay pending and retry. Authentication,
authorization, invalid endpoint/bucket, checksum, and other ordinary 4xx errors
stay pending but surface as configuration/action-required errors. A lost HTTP
response means retry the same key. Multipart upload is unnecessary for the
bounded MVP segments; add it only if object sizes later require it.

## 6. Reliability

### Foreground capture and process death

- Start capture only from a visible activity or explicit notification action;
  call `startForeground()` immediately and truthfully show active sensors.
- Persist desired capture state separately from observed state. Reconstruct
  state from SQLite/files rather than trusting process memory.
- Finalize audio via `.recording`, recorder stop/release, validation/nonzero
  check, fsync, MD5 calculation, atomic rename to `.m4a`, then manifest insert.
  Recovery validates readable partial MPEG-4 with `MediaExtractor`; quarantine
  unreadable bytes rather than deleting them.
- A GPS failure must not stop audio and an audio failure must not discard GPS.
  Permission revocation seals/stops only the affected sensor.
- Modern Android restricts microphone/location foreground-service starts from
  the background. At boot, reconcile/schedule and post “Tap to resume capture”
  rather than claiming silent restart. Force-stop remains unrecoverable until
  the user launches the app.

### Upload scheduling, Doze, and network policy

Use unique WorkManager work so enqueue events coalesce. Require a connected
network; prefer `UNMETERED` by default but allow the user to permit any network.
Explicit Sync Now may use any connected network. Use exponential backoff
starting at 30 seconds. One worker uploads sequentially with streaming I/O.
WorkManager may be deferred by Doze; local capture continues meanwhile.

The setup UI explains vendor battery management and links to documented system
battery-optimization settings. An exemption is optional and denial is valid.
Do not use exact alarms. Use a narrowly scoped wake lock only if device testing
proves it necessary.

### Storage pressure

Track usable storage before start and rollover:

- warn below max(2 GiB, 10% free);
- below 1 GiB shorten segments and prioritize sync;
- below 512 MiB safely seal and stop audio, continue low-volume location only
  if safe, and raise a high-visibility notification.

Cleanup order is cache, uploaded payloads whose unlink was interrupted, then
old uploaded manifest records. Never automatically evict pending captures.
Offer explicit export and confirmed deletion for recovery.

## 7. Battery and storage budgets

At 24 kbit/s audio is about 10.8 MB/hour or 259 MB/day; at 32 kbit/s it is
about 14.4 MB/hour or 346 MB/day. Seven offline days need roughly 1.8–2.4 GB
before safety margin; reserve at least twice the intended offline window. Use
hardware AAC and do not transcode on device.

Location JSON is typically only a few MB/day at a 30-second moving interval;
GNSS/radio wakeups dominate its battery cost. Balanced-power fused fixes,
distance thresholds, batching, passive fixes, and stationary backoff are the
primary mitigations. Measure a 24-hour and seven-day field run on each target
device; budgets are estimates, not guarantees.

## 8. Permissions and privacy

Request progressively with an explanation:

- `RECORD_AUDIO`: record user-enabled ambient audio.
- `ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION`: capture fixes.
- `ACCESS_BACKGROUND_LOCATION`: separate, explicit step for capture while the
  activity is not visible.
- `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, and
  `FOREGROUND_SERVICE_LOCATION`: honest continuous capture.
- `POST_NOTIFICATIONS`: persistent capture and recovery notification.
- `RECEIVE_BOOT_COMPLETED`: recover spool/scheduling and prompt to resume.
- `INTERNET` and `ACCESS_NETWORK_STATE`: direct bucket PUTs and constraints.
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`: only to open the optional documented
  exemption flow; never loop or coerce.

Do not request contacts, hardware identifiers, all-files access, media-library
access, exact alarms, or camera in MVP. Keep payloads in internal storage and
exclude them and credentials from Android backup. The lock-screen notification
must reveal active capture without exposing coordinates, filenames, or secrets.

## 9. Verification and rollout

Automated tests cover SigV4 canonicalization/golden vectors, stable key reuse,
manifest transitions, 2xx cleanup, retryable and configuration errors, a lost
response followed by re-PUT, location batching, and recovery. Instrumented
tests cover Room migrations, WorkManager constraints, permission revocation,
and notification actions.

Before daily use, test on the actual phone: permission setup, 15-minute
rollover, screen-off/Doze, reboot tap-to-resume, process kill at every finalize
and PUT boundary, Wi-Fi/cellular transitions, bad credentials, clock changes,
low/full storage, battery optimization, and a multi-day offline queue. Confirm
with bucket-side administration (outside the app) that objects and MD5 values
arrived. A signed release and on-device soak testing remain required after the
prototype builds.
