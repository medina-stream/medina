# Stream time & layered ingest plan

Design jam, 2026-09-20. **Status: parked.** No implementation authorized —
this is the model to build toward, not a work order.

Two halves: (1) how time, timezone, and location work across streams and
sources; (2) how data gets in, taught as progressive layers from "dumb" to
webscale.

---

## Part 1 — Stream time

### The one-liner

UTC underneath, always. A stream has its own timezone — the *day language*.
Location lives on the *source*. The story is usually told through the
*user's* clock.

### Entities

- **Stream** (one per lifelog). Has an alias: defaults to `1`, `2`, …; a
  short stable name is nicer, kept stable to the device.
- **Source** (a mic, a listening station, a phone). Default alias: `mic`
  — the word a kid would use. Fixed sources get their location/TZ configured
  up front; mobile sources (the phone) report it over time.
- **Capture**. Inherits its source's location *at capture time*, which gives
  it a source TZ. Coarse is enough (city level); resolve TZ with a bundled
  offline database, never an external service — coordinates don't leave the box.
- **User lens**. The narrative defaults to the user's clock, taken from their
  primary device (usually the phone, which travels with them). For fixed
  sources this differs from source-local time; for the phone they coincide.

### Day language

- Instants and intervals are stored in UTC. APIs are unambiguous; clients can
  always display correctly.
- The stream TZ decides what "Tuesday" means: day keys, journal URLs, bucket
  day-prefixes. Day keys use Long Now five-digit years: `0YYYYMMDD`, e.g.
  `/020260921/summary.md`.
- Changing the stream TZ is **prospective-only**, via an effective-date
  boundary. Historical days never reshuffle: noon stays the noon you lived.
  Re-basing is possible but unnecessary — if you move to Paris and never
  re-base, nothing breaks; new days just keep the old midnight boundaries.
- Day membership is by stream-midnight. A capture belongs to the stream day
  containing its start; coverage *spans* split across day keys in the index.

### Bucket layout

Day-first, then the ingest area, then the source, then the UTC instant:

```
/020260921/in/mic/20260921T073000Z.m4a
```

- The **folder** is narrative: which day of *your* life this belongs to.
  The naive user finds Tuesday and deletes the prefix. Done.
- The **filename** is physics: the exact UTC instant, unambiguous, sortable.
- When they disagree (a NYC mic's Tuesday-midnight recording landing in your
  Monday-evening journal) that's not a wart — it's the model working.
- Keys are append-only history: never renamed, even across a stream-TZ
  re-base. Pre-rebase days keep their original prefixes; the day index tells
  the coherent story.

### Rendering

- One unified 24h timeline per stream day, on the stream-TZ axis, with
  per-source lanes plus a merged "anything recording" band.
- Each source's section headings show source-local time with the user-lens
  equivalent when they differ:
  `nyc-home — 12:00–12:15am local (9:00pm your time)`.
- Cross-source narration uses UTC instants: *"moments after the alarm sounded
  over here, a flash was seen on the other side of the world."*
- The **degenerate case** (one mic, stream TZ = local) is the whole model
  with all annotations hidden: source-local, stream-day, and your time
  collapse into one clock. This is the teaching moment — the naive user's
  mental model and the power user's model are the same URLs.

### The kid flow: the clock is the API

1. `GET /` → stream info: alias, day language TZ, and what today is.
   One bootstrap; everything else falls out of the wall clock.
2. `POST` audio to `/in` → the server files it by instant and *teaches the
   URL scheme back* in the response (`201 Location: /020260921/in/mic/…`).
   The convention is learned from the server, not from docs.
3. `GET /020260921/summary.md` → the rich human-level thing back.

Concrete layer-1: an ESP32 buffers 10 seconds of WAV from a breadboard mic
and POSTs it to `test.medina.stream/in`. Small enough to hold, real enough
to get a journal entry back.

### Stress points (resolved direction noted; details open)

- **DST**: stream days can be 23 or 25 hours. Need a rule for axis offsets
  past 1440 on the long day.
- **Midnight-spanning captures**: file under start-day; split only coverage
  in the index. A few minutes of spillover is a documented edge.
- **Phone with no GPS** (airplane mode): fall back to last-known TZ with a
  decaying confidence flag; journal may mark "location uncertain."
- **Backfill for pre-GPS recordings**: default to home TZ, refine with travel
  evidence. Transcripts themselves are a free oracle ("we're at the cafe in
  Paris").
- **Primary source**: what designates the user's lens in a multi-station
  world — a setting, defaulting to the phone.

---

## Part 2 — Layered ingest (cloudmic lessons)

Protocol philosophy: **the dumb path always works; every smarter layer is
opt-in.** Be liberal in what you accept; let clients earn their way up the
stack a few lines at a time. (In the 80s we called lesson 2 "GETing an HTML
form." The policy doc is the machine-readable form.)

- **Lesson 1 — childish.** POST raw bytes to `/in`. Don't know better, don't
  need to. The server deals with it and presents a coherent source of truth
  eventually.
- **Lesson 2 — ask first.** `GET /policy.json`: the server *suggests* where
  and how to send data. The kid changes ~5 lines and now PUTs to the
  canonical `/020260921/in/mic/…` layout. The architecture becomes genuinely
  webscale. (This layer already exists in production as the capture policy.)
- **Lesson 3+ — negotiate.** Transcoding preferences, metadata, auth headers…
  each its own small lesson.
- **Top layer — pre-claimed continuous signatures.** Every day before
  midnight, the authenticated client fetches tomorrow's slot manifest — one
  signed doc covering the day's slots, not N round trips. The server decides
  the ingest URLs (sharding, rotation, capacity). Per slot: record → content
  hash → join with the pre-claimed ticket → sign. Chain segments (each
  signature commits to the previous segment's hash) so gaps and reordering
  are detectable. Optionally anchor the day's root hash externally
  (blockchain) so third parties can verify without trusting the server.

The trust stack decomposes into independently useful layers:

| Layer | Attests | Buys you |
|---|---|---|
| Ticket | server expects slot S from client C | server-side ingest control |
| Hash + signature | this exact audio filled slot S | tamper-evidence |
| Chaining | segments are ordered and complete | gap/reorder detection |
| Anchoring | day root published externally | third-party verifiability |

Notes:

- Convergence: hopefully most input eventually matches the canonical storage
  format anyway; the server normalizes the rest. Smarter clients mean less
  server work — the incentives align.
- Clock-skew policy for slot boundaries needs deciding up front; client and
  server clocks *will* disagree there.
- The layering is the fallback story: miss the pre-midnight ticket fetch?
  Dumb POST. The server never withholds the dumb path.
