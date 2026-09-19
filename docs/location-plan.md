# Location plan: events, activity, and places

The capture app's location story today: `FusedLocationProviderClient` at
`PRIORITY_BALANCED_POWER_ACCURACY` (~100m, network-based), fixed interval from
policy, fixes accumulate in SQLite and seal into JSON batches under
`capture/*/location/`. That was fine when location was cold storage. It is the
wrong shape now that we want the UI to prove it's up to date, the journal to
narrate travel correctly, and transport mode to stop being a guess.

Two root causes for the bad travel summaries:

1. **Coarse fixes.** Balanced-power accuracy is cell/wifi positioning. Speed
   derived from ~100m fixes at 30–60s intervals is noise, and every transport
   heuristic built on that noise inherits it.
2. **No activity signal.** The OS already knows whether Scott is walking,
   cycling, or in a vehicle. We ignore it and re-derive motion from GPS.

## Direction

Adopt the Android location helpers as a package, and move location from
**sealed bucket chunks** to the **device-events channel** (`docs/events-plan.md`):
each fix (or significant change) becomes one small `location.fix` event object
under `events/<install-id>/YYYY/MM/DD/`, routed server-side to whatever cares.
The batch path retires once events are live; during transition both can run.

## Phone: the helpers

### 1. Activity recognition (phase 1)

`ActivityRecognitionClient.requestActivityUpdates()` — walking, running,
on-bicycle, in-vehicle, still, tilting — with confidence. Nearly free:
the OS runs the classifier anyway for its own features.

- Requires the `ACTIVITY_RECOGNITION` runtime permission (Android 10+).
- Each `location.fix` event carries `activity: { type, confidence }`.
- Transport mode becomes a **label**, not an inference: in-vehicle → driving,
  on-bicycle → cycling, walking/running → walking, still → stationary.
  GPS speed stays as a corroborating signal, never the primary.

### 2. Adaptive fused location (phase 1)

Replace the fixed policy interval with two gears, switched by the activity
classifier:

- **Still:** `PRIORITY_BALANCED_POWER_ACCURACY`, 60s interval. Cheap heartbeat.
- **Moving:** `PRIORITY_HIGH_ACCURACY`, 15s interval. Real GPS, real speed.

High-accuracy GPS only runs while it is buying information. When the
classifier is uncertain, prefer the faster gear for one window, then settle.
`minUpdateDistanceMeters` stays as a backstop (no event spam while pacing
around the apartment).

### 3. Places: current place (phase 2)

Places SDK `findCurrentPlace()` → top candidate name + types + place ID,
attached to the event. This is the "at Aquatic Park" magic — raw coordinates
never read that well in a journal.

- Throttle: only on significant moves (new place likelihood, or every 5 min
  while moving). A Places call per fix would be spendy and pointless.
- Needs a Google Cloud API key with Places API enabled. Options:
  - **Key in the capture policy** (fits the existing design: secrets live in
    the policy, the app stores only the bootstrap URL). Key restricted to the
    Android app signature.
  - **Server-side resolution** via the Places web API at ingest time instead.
    Keeps the key off the phone entirely; adds a minute of latency to place
    names. The live event still carries raw coords, so the map stays live.
  - Decision needed from Scott; default to policy-delivered key unless he
    prefers server-side.

### 4. Geofences (phase 3, optional)

`GeofencingClient` around home (and later, learned frequent places) for
arrive/leave transitions. These become `place.arrived` / `place.left` events —
exactly the beats a day summary wants ("left home 8:04, arrived Aquatic Park
8:31"). Start with home only; learned places later.

## Event shape

```json
{
  "id": "<uuid>",
  "device": "<install-id>",
  "seq": 1234,
  "at": "2026-09-19T03:12:00.000Z",
  "type": "location.fix",
  "payload": {
    "lat": 37.7749, "lon": -122.4194, "accuracyM": 8,
    "speedMps": 3.2, "bearingDeg": 140,
    "activity": { "type": "walking", "confidence": 87 },
    "place": { "name": "Aquatic Park", "types": ["park"], "placeId": "ChIJ…" }
  }
}
```

At-least-once, idempotent on `id`, same as the rest of the events plan.
Fixes still spool in SQLite first (offline story unchanged); the uploader
drains them as individual event objects instead of sealed batches.

## Policy additions

`PolicyGps` grows: `activityRecognition: Boolean`, `adaptive: Boolean`,
`movingIntervalSeconds`, `places: Boolean`. The Places API key arrives via the
policy document when Scott provisions it. All server-owned, same as today.

## Server consumers (each a small router entry)

- **Live proof:** the status UI shows last fix age + place name — the "it's up
  to date" signal Scott likes, now with places.
- **Live draft summary:** the per-minute cheap-LLM day draft gets real
  movement beats with place names and true transport modes.
- **Day index / journal:** travel segments use the activity label directly;
  the speed-heuristic inference gets deleted, not tuned.
- **Geofence transitions** feed "left / arrived" moments into the journal.

## Battery budget (estimates)

- Activity recognition: negligible (OS already runs it).
- Still gear: same as today or cheaper (60s balanced).
- Moving gear: high-accuracy GPS at 15s is the real cost — bounded by only
  running while moving. A day with 2h of movement should cost single-digit
  percent, not the all-day whisper-style drain.
- Places: a handful of calls per outing, throttled. Negligible.

## Phases

1. **Activity + adaptive GPS as events.** Fixes transport mode and freshness;
   no new API keys, no billing. Retire the batch path after.
2. **Places current-place.** Needs Scott's call on key delivery (policy vs
   server-side).
3. **Geofences + server consumers** (live map beats, travel segments, journal
   moments).

## Open questions

- Places API key: policy-delivered (fresher, key on device) or server-side
  resolution (key stays home, ~1 min latency on names)?
- Retire the sealed location batches outright in phase 1, or run both during
  transition?
- Any places that should never be named in the journal (privacy floor)?
