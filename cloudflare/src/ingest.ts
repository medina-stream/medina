/**
 * Push ingest on the Medina Worker (migration milestone 4, step 11 —
 * docs/cloudflare-migration.md §4.3): the `POST /in` endpoint, ported
 * from the bun server's handler in example-lifelog/main.ts and its two
 * ingest paths, lib/lifelog/Gps.ts (`parseGpsBody` + `gpsInboxWrite`)
 * and lib/capture/HttpIngest.ts (`httpIngest`).
 *
 * The server's trust was the tailnet: Tailscale Serve resolved the
 * poster to the owner's login and there was no token. On the Worker
 * the credential is a per-device capability token from the same
 * registry that gates the capture policy (worker.ts verifies it
 * before calling here): machine posters present it as a Bearer header
 * or `?token=`, per the plan addendum's "service tokens replace the
 * tailnet-identity trust". One transition bridge exists beside it —
 * `POST /serve-in/<token>` (the token in the path), which exists only
 * so the Tailscale Serve endpoint on the retired server's host can
 * proxy the phone GPS logger's unchanged posts to this handler; see
 * the retirement note in docs/cloudflare-migration.md §4.3.
 *
 * Semantics are the server's, decision for decision:
 *
 *  - `?source=` labels provenance (default "http"), validated as
 *    `[a-z0-9][a-z0-9-]{0,63}`; anything else is a 400.
 *  - A body that parses as GPS (form-encoded single point, the
 *    GPSLogger custom-URL shape; or JSON points — Overland
 *    `{locations:[…]}`, OwnTracks, or a bare lat/lon object) is
 *    written as one NDJSON file under `gps/inbox/`, exactly the
 *    server's `gpsInboxWrite` recipe (filename and row shape
 *    included), and the live GPS stage compacts it from there.
 *    GPS is recognized by content, not by source label; the parse
 *    source label for the default "http" source is "gps-gpslogger".
 *  - Any other body becomes an uninterpreted capture, like the
 *    server's `httpIngest`: content-hash identity, the blob at
 *    `capture/<sha256>/<name>`, provenance appended beside it (a
 *    re-post of the same bytes is a duplicate sighting, not a second
 *    blob). The server's copy additionally ran an archive
 *    reconciliation whose job was moving bytes from its disk into
 *    this bucket; here the bytes are born in the bucket, and the
 *    live archive sweep receipts them on its next pass.
 *  - An empty body is a 400; nothing is ever silently dropped.
 */
import * as Effect from "effect/Effect";
import { INBOX_PREFIX, type GpsPointRow } from "./gps.ts";

/** The slice of the R2 bucket binding this module uses (worker.ts's
 * R2BucketLike satisfies it structurally). */
export interface IngestBucket {
  get(key: string): Promise<{
    readonly body: ReadableStream;
    readonly size: number;
    readonly httpEtag: string;
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null>;
  put(
    key: string,
    value: string | Uint8Array,
    options?: {
      readonly httpMetadata?: { readonly contentType?: string };
      readonly customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
}

const sha256HexBytes = (bytes: Uint8Array): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new Uint8Array(bytes),
    );
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  });

const sha256HexText = (text: string): Effect.Effect<string> =>
  sha256HexBytes(new TextEncoder().encode(text));

// ---------------------------------------------------------------------------
// GPS body parsing — a line-for-line port of the server's parseGpsBody
// (lib/lifelog/Gps.ts), producing the Worker's GpsPointRow shape.
// ---------------------------------------------------------------------------

const finite = (
  value: string | number | null | undefined,
): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const isoOrNull = (value: string | null | undefined): string | null => {
  if (!value) return null;
  // Epoch seconds (with optional fraction) vs epoch millis, decided by
  // the shape of the digits — not string length, which a fraction
  // breaks. (The server's recipe, verbatim.)
  const seconds = value.match(/^(\d{10})(\.\d+)?$/);
  const ms = seconds
    ? Number(seconds[1] + (seconds[2] ?? "")) * 1000
    : /^\d{13}(\.\d+)?$/.test(value)
      ? Number(value)
      : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/** GPSLogger custom-URL bodies: form-encoded lat/lon/time/s/alt/acc/batt. */
const parseFormPoint = (
  source: string,
  body: string,
): GpsPointRow | null => {
  if (!/(^|&)lat=/.test(body)) return null;
  const params = new URLSearchParams(body);
  const lat = finite(params.get("lat"));
  const lon = finite(
    params.get("lon") ?? params.get("long") ?? params.get("longitude"),
  );
  const ts = isoOrNull(
    params.get("time") ?? params.get("timestamp") ?? params.get("tst"),
  );
  if (lat === null || lon === null || ts === null) return null;
  return {
    source,
    ts,
    lat,
    lon,
    speed: finite(
      params.get("s") ??
        params.get("spd") ??
        params.get("speed") ??
        params.get("vel"),
    ),
    alt: finite(params.get("alt") ?? params.get("altitude")),
    acc: finite(params.get("acc") ?? params.get("accuracy")),
    batt: finite(params.get("batt") ?? params.get("battery")),
    raw: body,
  };
};

/** Overland-style `{locations: [GeoJSON Feature...]}` and
 * OwnTracks-style single-object JSON bodies. */
const parseJsonPoints = (
  source: string,
  body: string,
): Array<GpsPointRow> | null => {
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const features = Array.isArray(parsed?.locations)
    ? parsed.locations
    : parsed?._type === "location" ||
        (parsed?.lat !== undefined && parsed?.lon !== undefined)
      ? [parsed]
      : null;
  if (!features) return null;
  const points: Array<GpsPointRow> = [];
  for (const feature of features) {
    const geometry = feature?.geometry?.coordinates;
    const properties = feature?.properties ?? feature;
    const lon = finite(geometry?.[0] ?? properties.lon ?? properties.longitude);
    const lat = finite(geometry?.[1] ?? properties.lat ?? properties.latitude);
    const ts = isoOrNull(
      String(
        properties.timestamp ?? properties.time ?? properties.tst ?? "",
      ),
    );
    if (lat === null || lon === null || ts === null) continue;
    points.push({
      source,
      ts,
      lat,
      lon,
      speed: finite(properties.speed ?? properties.vel),
      alt: finite(properties.altitude ?? properties.alt),
      acc: finite(
        properties.horizontal_accuracy ??
          properties.acc ??
          properties.accuracy,
      ),
      batt: finite(properties.battery_level ?? properties.batt),
      raw: JSON.stringify(feature),
    });
  }
  return points.length ? points : null;
};

export const parseGpsBody = (
  source: string,
  body: string,
): Array<GpsPointRow> | null => {
  const form = parseFormPoint(source, body);
  if (form) return [form];
  return parseJsonPoints(source, body);
};

// ---------------------------------------------------------------------------
// The two ingest paths
// ---------------------------------------------------------------------------

/** Append parsed points to the transient inbox (one NDJSON file per
 * post) — the server's `gpsInboxWrite` recipe: same filename, same
 * row encoding (a Schema.Class GpsPoint stringifies field-for-field
 * like the plain row built here), so either host's files are
 * interchangeable to the compaction. */
const gpsInboxWrite = (
  bucket: IngestBucket,
  points: ReadonlyArray<GpsPointRow>,
): Effect.Effect<number> =>
  Effect.gen(function* () {
    const lines = points.map((point) => JSON.stringify(point)).join("\n") + "\n";
    const digest = yield* sha256HexText(lines);
    const name = `${new Date().toISOString().replace(/[:.]/g, "")}-${digest.slice(0, 8)}.ndjson`;
    yield* Effect.promise(() =>
      bucket.put(`${INBOX_PREFIX}/${name}`, new TextEncoder().encode(lines)),
    );
    return points.length;
  });

/** The blob keeps its original filename (sanitized), so provenance
 * survives even if every JSON record were lost. (The server's
 * captureBlobName, verbatim.) */
const captureBlobName = (filename: string): string => {
  const name = filename.replace(/[/\\]/g, "_");
  return name === "provenance.json" || name.startsWith(".tmp-")
    ? `_${name}`
    : name;
};

interface ProvenanceRecordShape {
  readonly source: string;
  readonly filename: string;
  readonly fileId: string;
  readonly mimeType: string;
  readonly modifiedTime: string;
  readonly md5Checksum: string | null;
  readonly fetchedAt: string;
}

/** One HTTP-posted body as an uninterpreted capture — the server's
 * `httpIngest`, minus its archive reconciliation (the bytes are born
 * in the archive here). */
const httpIngest = (
  bucket: IngestBucket,
  source: string,
  bytes: Uint8Array,
  contentType: string,
): Effect.Effect<{ captureId: string; duplicate: boolean }> =>
  Effect.gen(function* () {
    const receivedAt = new Date().toISOString();
    const captureId = yield* sha256HexBytes(bytes);

    const extension = contentType.includes("json")
      ? "json"
      : contentType.includes("csv")
        ? "csv"
        : contentType.includes("text")
          ? "txt"
          : "bin";
    const filename = `${source}-${receivedAt.replace(/[:.]/g, "")}.${extension}`;
    const provenanceKey = `capture/${captureId}/provenance.json`;

    const existingObject = yield* Effect.promise(() =>
      bucket.get(provenanceKey),
    );
    let existingRecords: Array<ProvenanceRecordShape> = [];
    if (existingObject !== null) {
      const text = yield* Effect.promise(async () =>
        new Response(existingObject.body).text(),
      );
      try {
        const parsed = JSON.parse(text) as {
          records?: Array<ProvenanceRecordShape>;
        };
        if (Array.isArray(parsed.records)) existingRecords = parsed.records;
      } catch {
        existingRecords = [];
      }
    }
    const duplicate = existingRecords.length > 0;

    if (!duplicate) {
      const blobKey = `capture/${captureId}/${captureBlobName(filename)}`;
      yield* Effect.promise(() => bucket.put(blobKey, bytes));
    }

    const provenance = {
      captureId,
      records: [
        ...existingRecords,
        {
          source: `http-${source}`,
          filename,
          fileId: captureId,
          mimeType: contentType,
          modifiedTime: receivedAt,
          md5Checksum: null,
          fetchedAt: receivedAt,
        },
      ],
    };
    yield* Effect.promise(() =>
      bucket.put(provenanceKey, JSON.stringify(provenance, null, 2), {
        httpMetadata: { contentType: "application/json" },
      }),
    );
    return { captureId, duplicate };
  });

// ---------------------------------------------------------------------------
// The handler. The caller has already verified the poster's
// capability token (see worker.ts); everything from here mirrors the
// server's route body.
// ---------------------------------------------------------------------------

const textResponse = (body: string, status: number): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

export const handleIn = (
  bucket: IngestBucket,
  request: Request,
  url: URL,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const sourceParam = url.searchParams.get("source");
    const source =
      typeof sourceParam === "string" && sourceParam ? sourceParam : "http";
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(source)) {
      return textResponse(
        "source must be [a-z0-9-], e.g. gps-gpslogger",
        400,
      );
    }
    const body = yield* Effect.promise(async () =>
      new Uint8Array(await request.arrayBuffer()),
    );
    if (body.length === 0) return textResponse("empty body", 400);
    const contentType =
      request.headers.get("content-type") ?? "application/octet-stream";

    // GPS is recognized by content, not by source label — the phone
    // just posts to /in, like Drive files are recognized as audio by
    // mimeType. The points are the signal, the envelope is
    // scaffolding; unparseable bodies still land as blob captures so
    // nothing is silently dropped.
    const points = parseGpsBody(
      source === "http" ? "gps-gpslogger" : source,
      new TextDecoder().decode(body),
    );
    if (points) {
      const count = yield* gpsInboxWrite(bucket, points);
      return jsonResponse({ ok: true, points: count });
    }
    const result = yield* httpIngest(bucket, source, body, contentType);
    return jsonResponse({
      ok: true,
      captureId: result.captureId,
      duplicate: result.duplicate,
    });
  });
