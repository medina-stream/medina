# Timezones For Day-Level Resources

## Goal

Keep storage keyed in UTC while redefining Medina day resources as **local civil dates** assembled from UTC-keyed events.

An event belongs to day `020260722` iff the event timestamp, interpreted in the event's effective IANA time zone, falls on local date `2026-07-22`.

This applies first to GPS day resources, then to transcripts/audio day resources.

## Current Constraints

- Raw GPS, chunks, and existing day IDs are UTC-oriented today.
- `parseIntervalId("020260722")` currently means `2026-07-22T00:00:00Z` to `2026-07-23T00:00:00Z`.
- Daily GPS resource planning currently reads exactly 24 UTC hour objects.
- Expo day views and transcript filtering currently render and bucket in UTC.
- Interval JSON (`/:intervalId.json`) is still a UTC interval summary built from chunk overlap.

The plan must not silently change all 9-digit IDs everywhere at once. GPS-day semantics can change first, but interval resources and generic date helpers need an explicit migration plan.

## Core Decisions

### 1. Keep UTC keys; add per-event timezone attribution

UTC remains the only storage keyspace for:

- raw ingests
- `gps-hours/<utc-hour>.json`
- `chunks/<utc-chunk>.…`
- existing object timestamps

Timezone is derived metadata attached to events, never part of the key.

### 2. Resolve timezone per event, not per day

Use this precedence order for every timestamped event:

1. explicit ingest/device time zone metadata when trustworthy
2. GPS-derived IANA zone from coordinates
3. carry-forward last known zone within a bounded freshness window
4. configured default zone as a final fallback

Record both:

- `timeZone`: effective IANA zone used for membership/rendering
- `timeZoneSource`: `device` | `gps` | `carry-forward` | `default`

Without source tracking, degraded days will be impossible to debug or safely re-materialize.

### 3. Prefer per-point timezone annotation over per-hour annotation

Per-hour zone annotation is too lossy for:

- flights crossing zones within one UTC hour
- border crossings
- DST transitions near hour boundaries
- later transcript joins that need point-precise lookup

Recommended shape for `gps-hours/<hour>.json`:

- annotate each deduplicated/collapsed point with `timeZone` and `timeZoneSource`
- optionally add a compact hour-level summary such as zone runs or counts for debugging

Do not make the day resource reconstruct zone changes from one zone per hour. That will mis-bucket real travel days.

### 4. Treat local-day identity separately from UTC interval parsing

`020260722` can become a local-day resource ID for GPS and transcript views, but generic interval helpers must not keep pretending it means UTC midnight.

Do not overload `parseIntervalId` further. Instead:

- keep `parseIntervalId` as UTC interval parsing for existing interval resources
- add a distinct local-day concept for day-level derived resources, e.g. `parseDayId`, `LocalDayId`, or equivalent
- migrate GPS and transcript day planning/rendering to the new helper

If this separation is skipped, month/year rollups, CLI helpers, caching logic, and UI date math will accumulate subtle bugs.

## Event Timezone Resolution

### GPS points

For each GPS point:

1. use ingest metadata zone if present and valid
2. else derive zone from lat/lon with offline lookup
3. else carry forward the most recent known zone
4. else use configured default

Validation rules:

- reject invalid or unknown IANA zone names
- if device metadata zone conflicts strongly with GPS-derived zone for a sustained span, prefer device only when the ingest source is known to emit correct capture-time zones; otherwise mark conflict and fall back to GPS

The plan should explicitly define what "carry-forward" means. Recommended:

- carry forward only from the latest prior point/event within 36 hours
- after that, fall back to default and mark degraded

Unbounded carry-forward will mislabel long gaps and travel days after airplane-mode periods.

### Transcripts and audio chunks

Second phase membership should use the same precedence order, but audio rarely has direct lat/lon. Recommended fallback chain:

1. ingest/device zone metadata on the recording/chunk
2. GPS join using nearest GPS point(s) around chunk start time
3. carry-forward recent known zone
4. configured default

Join rules need to be explicit. Recommended:

- join on chunk start time first
- accept nearest GPS evidence only within a bounded window, e.g. 30 minutes
- if no nearby GPS exists, use carry-forward/default and mark degraded

## Day Membership

### GPS day materialization

To materialize local day `D`, read a widened UTC hour window, then filter by each point's own local date.

Recommended initial read window:

- UTC range `[D 00:00Z - 14h, D+1 00:00Z + 14h)`

Reasons:

- UTC offsets span `[-12, +14]`
- using `+14` on both sides is simpler than asymmetric `-14/+12`
- a symmetric 52-hour window is easier to reason about and test
- the extra 2 hours over `-14/+12` are operationally cheap compared with correctness risk

Then:

- collect deduplicated points from all candidate hours
- compute each point's local date from `point.timeZone`
- keep only points whose local date equals `D`
- recompute collapse/segmentation after filtering, not before

Do not define membership by dominant zone of the day. Membership is strictly per event.

### No-GPS days

If a day has no GPS points, the resource cannot infer a zone from same-day data. The fallback policy must be explicit:

- use last known zone before that day, subject to freshness bound
- otherwise use configured default
- persist day-level provenance describing which fallback was used

Recommended day-level metadata:

- `dominantTimeZone`
- `timeZoneCoverage`: per-zone seconds or point counts
- `timeZoneFallbackUsed`: boolean
- `timeZoneWarnings`: array of codes such as `no-gps`, `stale-carry-forward`, `conflicting-device-zone`

## Dominant Zone Definition

The dominant zone should be a presentation hint only. It must never affect membership.

Define it precisely as:

- sum segment durations per time zone using the event/segment effective zone
- choose the zone with the greatest covered duration
- tie-break by the zone of the earliest event in the day
- if the top zone covers less than 60% of covered duration, mark the day as `multiZone: true`

Point count alone is a weak metric because sparse flight points can dominate a long stay or vice versa depending on sampling.

For no-GPS or degenerate days, dominant zone may come from fallback provenance, but should be marked degraded.

## Rendering And API Shape

### Add structured GPS JSON

Do not make the app parse markdown for structured day data.

Add `/:dayId/gps.json` alongside `gps.md` with:

- `dayId`
- `summary`
- `dominantTimeZone`
- `multiZone`
- `segments`: `{ startTime, endTime, timeZone, timeZoneSource?, place?, kind, distanceMeters?, mode? }[]`
- optional `timeline`: pre-rendered strings for backwards compatibility if useful
- `warnings`

`gps.md` can remain as a human-readable artifact, but the app should move to JSON.

### Timestamp formatting

Every rendered timestamp should use the resource-provided `timeZone`, not browser local time and not hard-coded UTC.

For mixed-zone days:

- format each segment in its own zone
- omit zone suffix when the segment zone equals `dominantTimeZone` and the day is not meaningfully multi-zone
- include a short zone label when it differs from the dominant zone, e.g. `2:20 PM EDT`

Prefer IANA-zone-aware formatting at render time; do not persist preformatted clocks as the canonical data model.

### LLM narrative

Travel days are where generic prompts fail. The prompt should carry explicit zone structure, not just one day-level zone.

Provide the model:

- ordered segments with `startTime`, `endTime`, `timeZone`, `kind`, place name, and travel mode
- a short transition summary such as `time zone changes: PDT until 14:20, EDT after 22:05`
- a rule that times must be interpreted in the segment's zone

Prompt guidance:

- tell the model not to imply impossible elapsed times across zone jumps
- tell it to describe the day continuously without overemphasizing the mechanics of timezone changes unless they matter
- prefer relative phrasing on complex travel days when exact clock times are distracting

Fallback summary generation should also become zone-aware instead of emitting raw UTC ISO strings.

## Risks And Missed Failure Modes

### Semantic break of 9-digit IDs

This is the biggest hidden risk.

Today, these are UTC-based:

- `resources/interval.ts`
- `resources/intervals.ts`
- transcript day keys and finalization logic
- Expo `dateFromDayId`, `dayBounds`, and transcript filtering
- CLI helpers like `yesterday`

If GPS day resources switch first while `/:intervalId.json` stays UTC, one day screen may mix:

- local-day GPS
- UTC-day transcript list
- UTC-day coverage stats

That hybrid state is acceptable only if called out and sequenced deliberately. It is not acceptable as an unmarked silent behavior change.

### Caching/fingerprinting

Re-materializing `020260722/gps.md` under new semantics means old caches keyed only by path may serve stale UTC-day content.

Mitigations:

- bump resource versions for GPS and map resources
- re-materialize dependent artifacts
- if external caching exists, purge or rely on object last-modified/ETag changes

### Month/year rollups

Month/year resources built from UTC day helpers will become semantically inconsistent if some children are local-day resources and others remain UTC intervals.

Do not attempt month/year local-civil rollups in this change. Keep them explicitly out of scope until day semantics are standardized across resource types.

### Device metadata trust

Phones may report current zone at upload time rather than capture time, or omit it entirely. The plan should assume device zone metadata is useful but not authoritative without source-specific validation.

### Sparse GPS on flights

Red-eye handling is correct only if there are enough points near midnight transitions. With sparse GPS, some crossings will still be approximate. This is acceptable if provenance/warnings are preserved.

## Recommended Rollout

### Phase 1: timezone attribution in GPS hour resources

Build first:

- offline IANA lookup integration
- point-level `timeZone` and `timeZoneSource` on `gps-hours/<hour>.json`
- tests for DST, border crossing, and same-hour zone change cases

This is the safest foundational change because it preserves UTC keys and does not yet alter day semantics.

### Phase 2: local-day GPS assembly and structured output

Build next:

- new local-day planner that reads widened UTC hour windows
- filtering by point local date
- `gps.json`
- zone-aware timeline/summary generation
- map resources updated to consume structured GPS output instead of markdown parsing when practical

Keep `gps.md` as a derived presentation artifact from the same structured model.

### Phase 3: app consumes structured GPS resource

Then update Expo to:

- fetch `gps.json`
- render segment times in `segment.timeZone`
- stop parsing markdown for GPS structure

This should land before transcript local-day migration so the GPS behavior is visible and verifiable independently.

### Phase 4: transcript/audio local-day membership

After GPS is stable:

- define transcript zone inference and GPS join rules
- materialize transcript day resources by local-day membership
- update app transcript filtering and day metadata accordingly

Do not continue using UTC `dayBounds` once transcript day resources switch semantics.

### Phase 5: broader day-ID contract cleanup

Finally:

- separate UTC interval parsing from local-day parsing in shared helpers
- audit CLI, API docs, and any month/year rollups
- decide whether `/:intervalId.json` remains a UTC interval resource or gains a parallel local-day summary resource

## Concrete Recommendations

1. Use per-point timezone attribution, not per-hour-only attribution.
2. Use a symmetric widened planning window of 52 UTC hours (`-14h` to `+14h`) for initial correctness.
3. Add `timeZoneSource` everywhere timezone inference happens.
4. Keep `parseIntervalId` UTC-specific; introduce a separate local-day helper instead of mutating shared semantics in place.
5. Add `gps.json` and move the app to structured data before changing transcript day semantics.
6. Define dominant zone by covered duration, not point count.
7. Mark degraded/fallback days explicitly in stored artifacts.
8. Treat month/year local-civil rollups as out of scope until day semantics are uniform.

## Suggested First Landing

The safest first PR is:

- add point-level timezone inference to `gps-hours/<hour>.json`
- add tests and provenance fields
- no day-ID semantic change yet

The second PR should introduce local-day GPS assembly plus `gps.json`.

That sequence keeps storage stable, makes correctness testable on travel days, and avoids mixing too many semantic changes in one landing.
