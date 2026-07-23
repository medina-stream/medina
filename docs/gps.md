# GPS ingest and declarative movement resources

GPS logger posts use the normal `POST /in` path. The raw ingest is classified once by triage, dispatched to a deterministic UTC hour, and materialized through the same durable work/resource machinery as other inputs.

## Resource graph

```text
in/*
  -> triage/*
  -> dispatch-index/gps-hour/<hour>/*
  -> gps-hours/<hour>.json
  -> <day>/gps.md
  -> <day>/map.png
  -> <day>/map.svg
```

- `gps-hours/<hour>.json` contains raw, duplicate, deduplicated, and collapsed counts plus the complete deduplicated point stream needed for exact day-level recomposition.
- `<day>/gps.md` declares the day’s 24 hour objects as dependencies and recomputes collapse across hour boundaries.
- Maps depend on the daily markdown resource and refresh through normal resource receipts.
- Raw `in/*` objects remain the durable source of truth. There is no GPS-specific ingest index or dual-write path.

## Scheduling

Points in one hour share one work item. Updates debounce for one minute with a ten-minute maximum delay. Late arrivals and updates received while an hour is running reopen or schedule a new work generation.

## Output behavior

Daily markdown collapses exact duplicates, GPS jitter, and high-frequency stationary updates while preserving significant movement, periodic samples, movement-state changes, and the final point. The summary uses the configured OpenAI-compatible provider when available and otherwise falls back to deterministic text.

Map configuration:

- `MEDINA_MAPBOX_TOKEN`, `MAPBOX_TOKEN`, or `MAPBOX_ACCESS_TOKEN`
- `MEDINA_MAPBOX_STYLE`
- `MEDINA_STATIC_MAP_URL_TEMPLATE`

GPS summary configuration:

- `MEDINA_GPS_SUMMARY_MODE=off` for deterministic summaries
- `MEDINA_GPS_SUMMARY_MODEL`
- `MEDINA_GPS_OPENAI_BASE_URL` or `OPENAI_BASE_URL`

## URLs

For day `020260627`:

- `/020260627/gps.md`
- `/020260627/map.png`
- `/020260627/map.svg`

## Remaining improvements

- latest-day index;
- Web Mercator path projection for large areas;
- privacy controls and location precision reduction;
- cached reverse geocoding for semantic summaries.
