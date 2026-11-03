/**
 * The capture loop on the Medina Worker (migration milestone 4, step 2 —
 * docs/cloudflare-migration.md §4.3 step 2).
 *
 * This is the Worker's port of the medina-dev capture loop — the three
 * ingest-only sources over the capture app's upload bucket
 * (`sco-lifelog-in`): `capture-bucket` (audio segments), `device-events`
 * (volunteered device facts, `location.fix` today), and
 * `local-transcripts` (on-device first-look transcripts). The domain
 * vocabulary is the server's (lib/capture/CaptureBucket.ts,
 * DeviceEvents.ts, LocalTranscripts.ts): a pass *classifies* listed
 * objects into sources, computes each item's ingest *plan* — the
 * receipt it is guarded by, the artifact keys it writes, the index keys
 * it registers — and then either performs the plan or, in shadow mode,
 * diffs the plan against what medina-dev actually did.
 *
 * SHADOW MODE (the step-2 build): the pass performs nothing. It never
 * writes to a bucket, never registers with the index, and submits
 * nothing anywhere; its only writes are its own notebook (the
 * CaptureShadow Durable Object). The plan is computed exactly as the
 * live pass performs it, so the diff is the cutover evidence: for
 * every object in the window, did the live pipeline produce precisely
 * the artifacts the plan says it should have?
 *
 * LIVE MODE (the step-2 cutover, Nov 2): the loop runs in two halves
 * on the same plan. The live pass performs every unreceipted item in
 * its scan window — the receipt write, the artifact writes, the index
 * registrations, each exactly as medina-dev's ingest performed them
 * (lib/capture/Audio.ts, DeviceEvents.ts, LocalTranscripts.ts through
 * the ArtifactStore seam: a write lands in the bucket, then registers
 * itself; a failed registration fails the write). The shadow pass
 * then diffs the trailing window against reality as before — whoever
 * wrote the receipts — so the notebook keeps verifying the pipeline
 * after the flip, and medina-dev's silence is itself observable.
 * Which mode runs is the CAPTURE_LOOP_MODE deploy variable; shadow is
 * the default and the rollback position.
 *
 * The device-events hardening (§4.3 step 2) is built in by
 * construction: the plan reduces a batch's location fixes to ONE
 * latest-location write per device — the newest fix in the batch, by
 * the event's own timestamp — instead of the server's one write per
 * event, which is what R2 rate-limited under the Oct 28 burst. In
 * shadow mode the reduction is compared against medina-dev's current
 * latest-location object; a receipted batch whose newest fix is not
 * the believed position is reported as `stale`, the exact defect the
 * hardening removes.
 *
 * Structure: the top half is the domain (schemas, key math, payload
 * validation — pure, no platform), the bottom half is the platform
 * layer (Effect services over the R2 bindings, the medina-index HTTP
 * API, and the notebook Durable Object). Platform plumbing stays below
 * the domain surface.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// ---------------------------------------------------------------------------
// Domain: sources, objects, classification
// ---------------------------------------------------------------------------

/** The capture loop's three sources, in the server's own names. */
export const CaptureSourceName = Schema.Literals([
  "capture-bucket",
  "device-events",
  "local-transcripts",
]);
export type CaptureSourceName = typeof CaptureSourceName.Type;

/** One object in the capture source bucket, as a listing reports it. */
export class SourceObject extends Schema.Class<SourceObject>("SourceObject")({
  key: Schema.String,
  size: Schema.Number,
  etag: Schema.NullOr(Schema.String),
  /** Bucket lastModified, ISO — the ordering and windowing clock. */
  lastModified: Schema.String,
}) {}

/**
 * Classify one listed object exactly as the server's three mappings do
 * over their shared listing (lib/capture/CaptureBucket.ts,
 * DeviceEvents.ts, LocalTranscripts.ts): probe objects are dropped
 * outright; .m4a is capture-bucket audio (any other non-probe key maps
 * to a non-audio mime there and is dropped at discovery, so it belongs
 * to no source); `/events/` .json is a device event; `/transcript/`
 * .json is a local transcript. Everything else is skipped.
 */
export const classifySourceKey = (
  key: string,
): CaptureSourceName | "skipped" => {
  if (key.startsWith("probe/")) return "skipped";
  if (key.toLowerCase().endsWith(".m4a")) return "capture-bucket";
  if (key.includes("/events/") && key.endsWith(".json")) {
    return "device-events";
  }
  if (key.includes("/transcript/") && key.endsWith(".json")) {
    return "local-transcripts";
  }
  return "skipped";
};

/**
 * The (key, version) identity a receipt is written under, per source:
 * capture-bucket versions by the object's checksum (its etag) falling
 * back to modifiedTime; the JSON sources version by etag falling back
 * to lastModified. (lib/capture/CaptureBucket.ts's identity function,
 * DeviceEvents.ts and LocalTranscripts.ts's object mappings.)
 */
export const identityVersion = (
  source: CaptureSourceName,
  object: SourceObject,
): string =>
  source === "capture-bucket"
    ? (object.etag ?? object.lastModified)
    : (object.etag ?? object.lastModified);

/**
 * The ingest receipt key — port of `ingestReceiptKey` in
 * lib/lifelog/Resources.ts: `ingest/<source>/<fileId>-<version>.json`
 * with every character outside [a-zA-Z0-9_-] stripped.
 */
export const receiptKeyFor = (
  source: CaptureSourceName,
  fileId: string,
  version: string,
): string =>
  `ingest/${source}/${`${fileId}-${version}`.replace(/[^a-zA-Z0-9_-]/g, "")}.json`;

// ---------------------------------------------------------------------------
// Domain: artifact keys (ports of lib/lifelog/Resources.ts + DeviceEvents.ts)
// ---------------------------------------------------------------------------

export const TRANSCRIPT_VERSION = "assemblyai-u35p-v1";

export const captureDir = (captureId: string): string =>
  `capture/${captureId}`;
export const provenanceKey = (captureId: string): string =>
  `${captureDir(captureId)}/provenance.json`;
/** The blob keeps its original filename, sanitized (captureBlobName). */
export const captureBlobKey = (
  captureId: string,
  filename: string,
): string => {
  const name = filename.replace(/[/\\]/g, "_");
  const safe =
    name === "provenance.json" || name.startsWith(".tmp-")
      ? `_${name}`
      : name;
  return `${captureDir(captureId)}/${safe}`;
};
export const localTranscriptKey = (captureId: string): string =>
  `transcript/${TRANSCRIPT_VERSION}/${captureId}.ondevice.json`;
export const liveTranscriptKey = (
  installId: string,
  segmentUuid: string,
): string =>
  `transcript/${TRANSCRIPT_VERSION}/live/${installId}/${segmentUuid}.json`;
export const liveTranscriptPromotedKey = (
  installId: string,
  segmentUuid: string,
): string =>
  `transcript/${TRANSCRIPT_VERSION}/live/${installId}/${segmentUuid}.promoted.json`;
/** Where the freshest known position per install lives (DeviceEvents.ts). */
export const latestLocationKey = (installId: string): string =>
  `state/latest-location/${installId}.json`;

/**
 * Parse a capture-bucket audio object key
 * (`<install>/audio/YYYY/MM/DD/<utc>-<uuid>.m4a`) into install id +
 * segment UUID — port of `parseCaptureAudioKey`. Null for anything else.
 */
export const parseCaptureAudioKey = (
  objectKey: string,
): { installId: string; segmentUuid: string } | null => {
  const parts = objectKey.split("/");
  const audioIdx = parts.indexOf("audio");
  if (audioIdx < 1) return null;
  const installId = parts[audioIdx - 1];
  const file = parts[parts.length - 1] ?? "";
  const m =
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.m4a$/i.exec(
      file,
    );
  if (!installId || !m?.[1]) return null;
  return { installId, segmentUuid: m[1] };
};

export interface LivePhoneTranscript {
  readonly segmentUuid: string;
  readonly installId: string;
  readonly capturedAt: string | null;
  readonly updateSeq: number;
  readonly segments: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
    readonly text: string;
  }>;
  readonly text: string;
}

/** A sealed segment's final first-look transcript (parsePhoneTranscript). */
export interface PhoneTranscript {
  readonly captureId: string;
  readonly audioKey: string;
  readonly capturedAt: string | null;
  readonly engine: string;
  readonly model: string;
  readonly language: string;
  readonly segments: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
    readonly text: string;
  }>;
  readonly text: string;
}

// ---------------------------------------------------------------------------
// Domain: payload validation — exact ports of the server's hand parsers
// (lib/capture/DeviceEvents.ts, LocalTranscripts.ts). Parity demands the
// same accept/reject verdicts, so these mirror the originals check by
// check rather than re-expressing them.
// ---------------------------------------------------------------------------

export interface DeviceEvent {
  readonly id: string;
  readonly device: string;
  readonly seq: number;
  readonly at: string;
  readonly type: string;
  readonly payload: unknown;
}

export interface LocationFix {
  readonly lat: number;
  readonly lon: number;
  readonly accuracyM: number;
  readonly speedMps: number | null;
  readonly bearingDeg: number | null;
  readonly mock: boolean;
  readonly activityType: string;
  readonly activityConfidence: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

export const parseDeviceEvent = (raw: unknown): DeviceEvent | null => {
  if (!isRecord(raw)) return null;
  if (raw["schemaVersion"] !== 1) return null;
  const { id, device, seq, at, type, payload } = raw;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof device !== "string" || device.length === 0) return null;
  if (typeof seq !== "number" || !Number.isFinite(seq)) return null;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return null;
  if (typeof type !== "string" || type.length === 0) return null;
  return { id, device, seq, at, type, payload };
};

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export const parseLocationFix = (payload: unknown): LocationFix | null => {
  if (!isRecord(payload)) return null;
  const lat = numOrNull(payload["lat"]);
  const lon = numOrNull(payload["lon"]);
  const accuracyM = numOrNull(payload["accuracyM"]);
  if (lat === null || lon === null || accuracyM === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const activity = isRecord(payload["activity"]) ? payload["activity"] : {};
  return {
    lat,
    lon,
    accuracyM,
    speedMps: numOrNull(payload["speedMps"]),
    bearingDeg: numOrNull(payload["bearingDeg"]),
    mock: payload["mock"] === true,
    activityType:
      typeof activity["type"] === "string" ? activity["type"] : "unknown",
    activityConfidence: numOrNull(activity["confidence"]) ?? 0,
  };
};

/**
 * A live partial for an in-progress segment — port of
 * `parseLivePhoneTranscript` (lib/capture/LocalTranscripts.ts): same
 * envelope as the final first-look, but keyed by segment UUID and
 * overwritten on every tick. Identity lives in the payload, not the
 * object key.
 */
export const parseLivePhoneTranscript = (
  raw: unknown,
): LivePhoneTranscript | null => {
  if (!isRecord(raw)) return null;
  if (raw["schemaVersion"] !== 1 || raw["live"] !== true) return null;
  const segmentUuid = raw["segmentUuid"];
  const installId = raw["installId"];
  const text = raw["text"];
  const segments = raw["segments"];
  if (
    typeof segmentUuid !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      segmentUuid,
    )
  ) {
    return null;
  }
  if (typeof installId !== "string" || installId.length === 0) return null;
  if (typeof text !== "string" || !Array.isArray(segments)) return null;
  for (const s of segments) {
    if (!isRecord(s)) return null;
    if (
      typeof s["start"] !== "number" ||
      typeof s["end"] !== "number" ||
      typeof s["text"] !== "string"
    ) {
      return null;
    }
  }
  return {
    segmentUuid,
    installId,
    capturedAt:
      typeof raw["capturedAt"] === "string" ? raw["capturedAt"] : null,
    updateSeq: typeof raw["updateSeq"] === "number" ? raw["updateSeq"] : 0,
    segments: segments as LivePhoneTranscript["segments"],
    text,
  };
};

/**
 * A sealed segment's final first-look — exact port of
 * `parsePhoneTranscript` (lib/capture/LocalTranscripts.ts): the phone
 * computed the capture id itself (sha256 of the audio bytes), so the
 * payload carries the identity the transcript files under.
 */
export const parsePhoneTranscript = (
  raw: unknown,
): PhoneTranscript | null => {
  if (!isRecord(raw)) return null;
  if (raw["schemaVersion"] !== 1) return null;
  const captureId = raw["captureId"];
  const text = raw["text"];
  const segments = raw["segments"];
  if (typeof captureId !== "string" || !/^[0-9a-f]{64}$/.test(captureId)) {
    return null;
  }
  if (typeof text !== "string" || !Array.isArray(segments)) return null;
  for (const s of segments) {
    if (!isRecord(s)) return null;
    if (
      typeof s["start"] !== "number" ||
      typeof s["end"] !== "number" ||
      typeof s["text"] !== "string"
    ) {
      return null;
    }
  }
  return {
    captureId,
    audioKey: typeof raw["audioKey"] === "string" ? raw["audioKey"] : "",
    capturedAt:
      typeof raw["capturedAt"] === "string" ? raw["capturedAt"] : null,
    engine: typeof raw["engine"] === "string" ? raw["engine"] : "whisper.cpp",
    model: typeof raw["model"] === "string" ? raw["model"] : "",
    language: typeof raw["language"] === "string" ? raw["language"] : "en",
    segments: segments as PhoneTranscript["segments"],
    text,
  };
};

/** The receipt medina-dev writes per ingested item (IngestReceipt). */
export interface IngestReceiptShape {
  readonly captureId: string;
  readonly ingestedAt: string;
}

export const parseReceipt = (raw: unknown): IngestReceiptShape | null => {
  if (!isRecord(raw)) return null;
  if (typeof raw["captureId"] !== "string") return null;
  return {
    captureId: raw["captureId"],
    ingestedAt:
      typeof raw["ingestedAt"] === "string" ? raw["ingestedAt"] : "",
  };
};

// ---------------------------------------------------------------------------
// Domain: the performed writes — the JSON the live pass stores, in the
// exact shapes medina-dev's schemas serialize (lib/lifelog/Resources.ts,
// lib/capture/DeviceEvents.ts, lib/lifelog/Gps.ts). Consumers decode by
// schema, so field presence is the contract: optional fields the server
// omits (a transcript's capturedAt) are omitted here too.
// ---------------------------------------------------------------------------

/** The pre-content-hash ingest id (Resources.ts `ingestId`). */
export const ingestIdFor = (
  source: CaptureSourceName,
  fileId: string,
  version: string,
): string =>
  `${source}-${fileId}-${version}`.replace(/[^a-zA-Z0-9_-]/g, "");

/** The canonical (vendor) transcript key — the grandfather probe. */
export const canonicalTranscriptKey = (captureId: string): string =>
  `transcript/${TRANSCRIPT_VERSION}/${captureId}.json`;

/** The receipt body (IngestReceipt): capture id + ingest instant. */
export const receiptJson = (
  captureId: string,
  ingestedAt: string,
): IngestReceiptShape => ({ captureId, ingestedAt });

export interface ProvenanceRecordShape {
  readonly source: string;
  readonly filename: string;
  readonly fileId: string;
  readonly mimeType: string;
  readonly modifiedTime: string;
  readonly md5Checksum: string | null;
  readonly fetchedAt: string;
}

export interface ProvenanceShape {
  readonly captureId: string;
  readonly records: ReadonlyArray<ProvenanceRecordShape>;
}

/**
 * Append one sighting to a capture's provenance, unless the same
 * (source, fileId, filename) sighting is already recorded — the
 * server's rule (Audio.ts): the same content can arrive twice and
 * each sighting's metadata is evidence, but a re-performed ingest of
 * the same sighting adds nothing. Returns the next document and
 * whether it changed. An existing document that fails to parse is
 * treated as absent, as the server's schema decode failure is.
 */
export const appendProvenanceRecord = (
  existing: unknown,
  captureId: string,
  record: ProvenanceRecordShape,
): { readonly next: ProvenanceShape; readonly changed: boolean } => {
  let records: ReadonlyArray<ProvenanceRecordShape> = [];
  if (isRecord(existing) && Array.isArray(existing["records"])) {
    records = existing["records"].filter(
      (r): r is ProvenanceRecordShape =>
        isRecord(r) &&
        typeof r["source"] === "string" &&
        typeof r["filename"] === "string" &&
        typeof r["fileId"] === "string",
    );
  }
  const seen = records.some(
    (r) =>
      r.source === record.source &&
      r.fileId === record.fileId &&
      r.filename === record.filename,
  );
  return seen
    ? { next: { captureId, records }, changed: false }
    : { next: { captureId, records: [...records, record] }, changed: true };
};

/**
 * The Transcript document a phone transcript files as
 * (LocalTranscripts.ts `transcriptFromPhone`): on-device provider,
 * segment seconds rounded to utterance milliseconds, `capturedAt`
 * omitted when the payload carried none.
 */
export const phoneTranscriptJson = (
  parsed: {
    readonly capturedAt: string | null;
    readonly segments: ReadonlyArray<{
      readonly start: number;
      readonly end: number;
      readonly text: string;
    }>;
    readonly text: string;
  },
  version: string,
  ingestId: string,
  inputKey: string,
  completedAt: string,
): Record<string, unknown> => ({
  provider: "ondevice",
  version,
  ingestId,
  inputKey,
  ...(parsed.capturedAt === null
    ? {}
    : { capturedAt: parsed.capturedAt }),
  transcriptId: null,
  vendorKey: null,
  status: "completed",
  completedAt,
  text: parsed.text,
  utterances: parsed.segments.map((s) => ({
    speaker: null,
    startMs: Math.round(s.start * 1000),
    endMs: Math.round(s.end * 1000),
    text: s.text,
    confidence: null,
  })),
  error: null,
});

/** The believed-position document (DeviceEvents.ts `LatestLocation`). */
export interface LatestLocationShape {
  readonly installId: string;
  readonly lat: number;
  readonly lon: number;
  readonly accuracyM: number;
  readonly speedMps: number | null;
  readonly bearingDeg: number | null;
  readonly activityType: string;
  readonly activityConfidence: number;
  readonly at: string;
  readonly eventId: string;
  readonly eventSeq: number;
  readonly updatedAt: string;
}

export const latestLocationJson = (
  event: DeviceEvent,
  fix: LocationFix,
  updatedAt: string,
): LatestLocationShape => ({
  installId: event.device,
  lat: fix.lat,
  lon: fix.lon,
  accuracyM: fix.accuracyM,
  speedMps: fix.speedMps,
  bearingDeg: fix.bearingDeg,
  activityType: fix.activityType,
  activityConfidence: fix.activityConfidence,
  at: event.at,
  eventId: event.id,
  eventSeq: event.seq,
  updatedAt,
});

/**
 * Does the candidate fix displace the believed position? The reduction
 * the hardened pass writes by: newest by the event's own timestamp,
 * ties by sequence. An absent or unreadable believed position loses.
 */
export const fixWins = (
  candidate: { readonly at: string; readonly eventSeq: number },
  believed: unknown,
): boolean => {
  if (!isRecord(believed)) return true;
  const at = believed["at"];
  const seq = believed["eventSeq"];
  if (typeof at !== "string" || typeof seq !== "number") return true;
  if (candidate.at !== at) return candidate.at > at;
  return candidate.eventSeq > seq;
};

/**
 * One GPS inbox point for a routed location.fix, and the inbox file it
 * lands in — ports of DeviceEvents.ts's gpsInboxWrite call and
 * Gps.ts's file naming: one NDJSON file per post, named by the post
 * instant and the first 8 hex of the content's sha256. The envelope in
 * `raw` is re-serialized in the server's key order.
 */
export interface GpsInboxPoint {
  readonly source: string;
  readonly ts: string;
  readonly lat: number;
  readonly lon: number;
  readonly speed: number | null;
  readonly alt: null;
  readonly acc: number;
  readonly batt: null;
  readonly raw: string;
}

export const gpsInboxPoint = (
  event: DeviceEvent,
  fix: LocationFix,
): GpsInboxPoint => ({
  source: `capture/${event.device}`,
  ts: event.at,
  lat: fix.lat,
  lon: fix.lon,
  speed: fix.speedMps,
  alt: null,
  acc: fix.accuracyM,
  batt: null,
  raw: JSON.stringify({
    id: event.id,
    device: event.device,
    seq: event.seq,
    at: event.at,
    type: event.type,
    payload: event.payload,
  }),
});

export const GPS_INBOX_PREFIX = "gps/inbox";

/** The NDJSON body of one inbox post (one line per point, terminated). */
export const gpsInboxText = (
  points: ReadonlyArray<GpsInboxPoint>,
): string => points.map((point) => JSON.stringify(point)).join("\n") + "\n";

export const gpsInboxFile = (
  points: ReadonlyArray<GpsInboxPoint>,
  postedAtIso: string,
  linesSha256Hex: string,
): { readonly key: string; readonly text: string } => {
  const name = `${postedAtIso.replace(/[:.]/g, "")}-${linesSha256Hex.slice(0, 8)}.ndjson`;
  return { key: `${GPS_INBOX_PREFIX}/${name}`, text: gpsInboxText(points) };
};

/** SHA-256 hex of bytes or text — the index's per-write hash. */
export const sha256Hex = async (
  data: Uint8Array | string,
): Promise<string> => {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * The content type the server's artifact store stamps per key
 * (ArtifactStore.ts `contentTypeFor`): the performed writes match it
 * so a key's metadata does not depend on who wrote it.
 */
export const contentTypeForKey = (key: string, fallback: string): string => {
  if (key.endsWith(".json")) return "application/json";
  if (key.endsWith(".m4a")) return "audio/mp4";
  if (key.endsWith(".ogg")) return "audio/ogg";
  if (key.endsWith(".sqlite")) return "application/vnd.sqlite3";
  if (key.endsWith(".ndjson")) return "application/x-ndjson";
  if (key.endsWith(".md") || key.endsWith(".txt")) return "text/plain";
  return fallback;
};

// ---------------------------------------------------------------------------
// Domain: the ingest plan and the shadow verdict
// ---------------------------------------------------------------------------

/**
 * What ingesting one source object writes, in the server's vocabulary:
 * the receipt that guards it (`receiptKeyFor`), the capture artifact
 * keys (`captureBlobKey`, `provenanceKey`), the transcript keys
 * (`localTranscriptKey`, `liveTranscriptKey`), and the index keys it
 * registers — every store write registers, the milestone-3 seam rule,
 * which is why the checks below diff bucket presence AND index
 * presence. A `FixCandidate` is the one non-keyed effect an event can
 * have: a contribution to its device's believed position.
 */
export interface FixCandidate {
  readonly installId: string;
  readonly eventId: string;
  readonly eventSeq: number;
  readonly at: string;
  readonly sourceKey: string;
}

export type ItemVerdict =
  | "matched"
  | "legacy"
  | "pending"
  | "missing-receipt"
  | "missing-artifact"
  | "missing-index"
  | "error";

export interface ItemOutcome {
  readonly source: CaptureSourceName;
  readonly key: string;
  readonly verdict: ItemVerdict;
  readonly detail: string;
}

export type LatestVerdict =
  | "match"
  | "dev-newer"
  | "pending"
  | "stale"
  | "missing";

export interface LatestOutcome {
  readonly installId: string;
  readonly verdict: LatestVerdict;
  readonly shadowEventId: string;
  readonly shadowAt: string;
  readonly devEventId: string | null;
  readonly devAt: string | null;
}

export class SourceCounts extends Schema.Class<SourceCounts>("SourceCounts")({
  classified: Schema.Number,
  matched: Schema.Number,
  legacy: Schema.Number,
  pending: Schema.Number,
  mismatched: Schema.Number,
  /** Items the live pass performed this run (0 in pure shadow runs). */
  performed: Schema.Number,
}) {}

export class CaptureShadowReport extends Schema.Class<CaptureShadowReport>(
  "CaptureShadowReport",
)({
  ranAt: Schema.String,
  mode: Schema.Literals(["cron", "manual"]),
  windowFrom: Schema.String,
  windowTo: Schema.String,
  listedTotal: Schema.Number,
  inWindow: Schema.Number,
  checked: Schema.Number,
  truncated: Schema.Boolean,
  indexReachable: Schema.Boolean,
  /** How many receipts were found under each version derivation. */
  derivationEtag: Schema.Number,
  derivationLastModified: Schema.Number,
  sources: Schema.Record(CaptureSourceName, SourceCounts),
  mismatches: Schema.Array(
    Schema.Struct({
      source: CaptureSourceName,
      key: Schema.String,
      verdict: Schema.String,
      detail: Schema.String,
    }),
  ),
  latestLocations: Schema.Array(
    Schema.Struct({
      installId: Schema.String,
      verdict: Schema.String,
      shadowEventId: Schema.String,
      shadowAt: Schema.String,
      devEventId: Schema.NullOr(Schema.String),
      devAt: Schema.NullOr(Schema.String),
    }),
  ),
}) {}

export interface CaptureShadowOptions {
  readonly mode: "cron" | "manual";
  readonly windowFrom: Date;
  readonly windowTo: Date;
  /** An unreceipted item younger than this is pending, not missing. */
  readonly staleAfterMs: number;
  /** Per-source counts from a live pass that ran just before this
   * diff (live mode); folded into the report so the notebook records
   * performing and verifying in one entry. */
  readonly performed?: Readonly<Record<CaptureSourceName, number>>;
}

export interface CaptureLiveOptions {
  readonly windowFrom: Date;
  readonly windowTo: Date;
  /** Per-source cap on items performed in one pass — the server's
   * discovery bound (SOURCE_BUCKET_LIMIT, 25), so a backlog drains at
   * the pacing the pipeline was proven at. */
  readonly perSourceLimit: number;
}

export interface CaptureLiveSummary {
  readonly listedTotal: number;
  readonly scanned: number;
  readonly performed: Record<CaptureSourceName, number>;
  readonly alreadyReceipted: number;
  readonly errors: ReadonlyArray<{
    readonly source: CaptureSourceName;
    readonly key: string;
    readonly detail: string;
  }>;
}

// ---------------------------------------------------------------------------
// Platform: typed errors
// ---------------------------------------------------------------------------

export class CaptureListError extends Data.TaggedError("CaptureListError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class ArtifactReadError extends Data.TaggedError("ArtifactReadError")<{
  readonly key: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

export class IndexRequestError extends Data.TaggedError("IndexRequestError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class NotebookError extends Data.TaggedError("NotebookError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

type CaptureError =
  | CaptureListError
  | ArtifactReadError
  | IndexRequestError
  | NotebookError;

// ---------------------------------------------------------------------------
// Platform: minimal structural types for the Workers runtime surface,
// the same standalone approach as worker.ts and medina-index.
// ---------------------------------------------------------------------------

export interface R2ObjectBodyLike {
  readonly body: ReadableStream;
  readonly size: number;
  readonly httpEtag: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2ListedObjectLike {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded: Date;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  head(key: string): Promise<{ readonly size: number } | null>;
  put(
    key: string,
    value: string | Uint8Array,
    options?: {
      readonly httpMetadata?: { readonly contentType?: string };
    },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(options: {
    readonly prefix?: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<{
    readonly objects: ReadonlyArray<R2ListedObjectLike>;
    readonly truncated: boolean;
    readonly cursor?: string;
  }>;
}

export interface SecretsStoreSecretLike {
  get(): Promise<string>;
}

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface CaptureEnv {
  readonly sourceBucket: R2BucketLike;
  readonly artifacts: R2BucketLike;
  readonly indexToken: SecretsStoreSecretLike;
  readonly notebook: DurableObjectNamespaceLike;
  /** The loop's mode, from the CAPTURE_LOOP_MODE deploy variable:
   * "live" performs; anything else is shadow (the safe default). */
  readonly loopMode: "shadow" | "live";
}

/** The medina-index Worker — the artifact index's public home (§1.4). */
export const MEDINA_INDEX_URL = "https://medina-index.alignlabs.workers.dev";

const readBodyText = (object: R2ObjectBodyLike): Promise<string> =>
  new Response(object.body).text();

// ---------------------------------------------------------------------------
// Platform: services
// ---------------------------------------------------------------------------

/** The capture app's upload bucket (sco-lifelog-in), read-only. */
export class CaptureSource extends Context.Service<
  CaptureSource,
  {
    /** The whole source prefix, newest-first, as the server lists it. */
    readonly listAll: Effect.Effect<
      ReadonlyArray<SourceObject>,
      CaptureListError
    >;
    /** Download one object as text (device events, transcripts). */
    readonly downloadText: (
      key: string,
    ) => Effect.Effect<string, ArtifactReadError>;
    /** Download one object as bytes (audio segments, for hashing). */
    readonly downloadBytes: (
      key: string,
    ) => Effect.Effect<Uint8Array, ArtifactReadError>;
  }
>()("medina-cloudflare/CaptureSource") {}

/**
 * The canonical artifact bucket (sco-lifelog). Reads for the diff;
 * writes for the live pass, with the server's ArtifactStore seam
 * semantics: a write lands in the bucket and then registers itself in
 * the index, and a failed registration fails the write — the index is
 * the listing source of truth, so a write it cannot see must not
 * pretend to have succeeded. Byte/text writes register (size, sha256);
 * the blob write mirrors the server's putFile (size only — the bytes
 * arrived by stream there, so no hash was ever computed for it).
 */
export class ArtifactLedger extends Context.Service<
  ArtifactLedger,
  {
    readonly exists: (
      key: string,
    ) => Effect.Effect<boolean, ArtifactReadError>;
    readonly readJson: (
      key: string,
    ) => Effect.Effect<Option.Option<unknown>, ArtifactReadError>;
    /** Raw text, un-parsed (provenance merges, provisional copies). */
    readonly readText: (
      key: string,
    ) => Effect.Effect<Option.Option<string>, ArtifactReadError>;
    readonly writeText: (
      key: string,
      text: string,
    ) => Effect.Effect<void, ArtifactReadError | IndexRequestError>;
    readonly writeBlob: (
      key: string,
      bytes: Uint8Array,
    ) => Effect.Effect<void, ArtifactReadError | IndexRequestError>;
    /** Delete + unregister (the promoted provisional's removal). */
    readonly remove: (
      key: string,
    ) => Effect.Effect<void, ArtifactReadError | IndexRequestError>;
  }
>()("medina-cloudflare/ArtifactLedger") {}

/**
 * The artifact index (the medina-index Worker's Durable Object),
 * authenticated with the INDEX_API_TOKEN Secrets Store binding — the
 * same Bearer credential medina-dev and medina-index already share.
 */
export class ArtifactIndex extends Context.Service<
  ArtifactIndex,
  {
    readonly listKeys: (
      prefix: string,
    ) => Effect.Effect<ReadonlyArray<string>, IndexRequestError>;
    /** Register one artifact key (an idempotent upsert in the index). */
    readonly register: (
      key: string,
      size: number | null,
      hash: string | null,
    ) => Effect.Effect<void, IndexRequestError>;
    /** Unregister one artifact key (idempotent in the index). */
    readonly unregister: (
      key: string,
    ) => Effect.Effect<void, IndexRequestError>;
  }
>()("medina-cloudflare/ArtifactIndex") {}

/** The shadow's own notebook (the CaptureShadow Durable Object). */
export class CaptureNotebook extends Context.Service<
  CaptureNotebook,
  {
    readonly record: (
      report: CaptureShadowReport,
    ) => Effect.Effect<void, NotebookError>;
    readonly latest: Effect.Effect<
      Option.Option<CaptureShadowReport>,
      NotebookError
    >;
  }
>()("medina-cloudflare/CaptureNotebook") {}

const MAX_LIST_PAGES = 50;

export const capturePlatformLayer = (
  env: CaptureEnv,
): Layer.Layer<
  CaptureSource | ArtifactLedger | ArtifactIndex | CaptureNotebook
> => {
  /**
   * One authenticated index write (register/unregister), shared by the
   * ArtifactIndex service and the ledger's self-registering writes.
   */
  const indexWrite = (
    path: "/register" | "/unregister",
    body: Record<string, unknown>,
    key: string,
  ): Effect.Effect<void, IndexRequestError> =>
    Effect.gen(function* () {
      const token = yield* Effect.tryPromise({
        try: () => env.indexToken.get(),
        catch: (cause) =>
          new IndexRequestError({
            message: "reading the INDEX_API_TOKEN binding failed",
            cause,
          }),
      });
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(`${MEDINA_INDEX_URL}${path}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          }),
        catch: (cause) =>
          new IndexRequestError({
            message: `index ${path} for ${key} failed to send`,
            cause,
          }),
      });
      if (!response.ok) {
        return yield* Effect.fail(
          new IndexRequestError({
            message: `index ${path} for ${key} answered ${response.status}`,
            cause: response.status,
          }),
        );
      }
    });

  return Layer.mergeAll(
    Layer.succeed(CaptureSource, {
      listAll: Effect.tryPromise({
        try: async () => {
          const all: Array<SourceObject> = [];
          let cursor: string | undefined;
          for (let page = 0; page < MAX_LIST_PAGES; page++) {
            const result = await env.sourceBucket.list({
              prefix: "",
              limit: 1000,
              ...(cursor === undefined ? {} : { cursor }),
            });
            for (const object of result.objects) {
              all.push(
                new SourceObject({
                  key: object.key,
                  size: object.size,
                  etag: object.etag,
                  lastModified: object.uploaded.toISOString(),
                }),
              );
            }
            if (!result.truncated || result.cursor === undefined) break;
            cursor = result.cursor;
          }
          return all.sort((a, b) =>
            b.lastModified.localeCompare(a.lastModified),
          );
        },
        catch: (cause) =>
          new CaptureListError({
            message: "listing the capture source bucket failed",
            cause,
          }),
      }),
      downloadText: (key) =>
        Effect.tryPromise({
          try: async () => {
            const object = await env.sourceBucket.get(key);
            if (object === null) {
              throw new Error(`source object ${key} vanished`);
            }
            return readBodyText(object);
          },
          catch: (cause) =>
            new ArtifactReadError({
              key,
              message: `downloading ${key} from the source bucket failed`,
              cause,
            }),
        }),
      downloadBytes: (key) =>
        Effect.tryPromise({
          try: async () => {
            const object = await env.sourceBucket.get(key);
            if (object === null) {
              throw new Error(`source object ${key} vanished`);
            }
            return new Uint8Array(await object.arrayBuffer());
          },
          catch: (cause) =>
            new ArtifactReadError({
              key,
              message: `downloading ${key} from the source bucket failed`,
              cause,
            }),
        }),
    }),
    Layer.succeed(ArtifactLedger, {
      exists: (key) =>
        Effect.tryPromise({
          try: async () => (await env.artifacts.head(key)) !== null,
          catch: (cause) =>
            new ArtifactReadError({
              key,
              message: `heading artifact ${key} failed`,
              cause,
            }),
        }),
      readJson: (key) =>
        Effect.tryPromise({
          try: async () => {
            const object = await env.artifacts.get(key);
            if (object === null) return Option.none<unknown>();
            const text = await readBodyText(object);
            try {
              return Option.some(JSON.parse(text) as unknown);
            } catch {
              return Option.none<unknown>();
            }
          },
          catch: (cause) =>
            new ArtifactReadError({
              key,
              message: `reading artifact ${key} failed`,
              cause,
            }),
        }),
      readText: (key) =>
        Effect.tryPromise({
          try: async () => {
            const object = await env.artifacts.get(key);
            if (object === null) return Option.none<string>();
            return Option.some(await readBodyText(object));
          },
          catch: (cause) =>
            new ArtifactReadError({
              key,
              message: `reading artifact ${key} failed`,
              cause,
            }),
        }),
      writeText: (key, text) =>
        Effect.gen(function* () {
          const hash = yield* Effect.promise(() => sha256Hex(text));
          yield* Effect.tryPromise({
            try: () =>
              env.artifacts.put(key, text, {
                httpMetadata: {
                  contentType: contentTypeForKey(key, "text/plain"),
                },
              }),
            catch: (cause) =>
              new ArtifactReadError({
                key,
                message: `writing artifact ${key} failed`,
                cause,
              }),
          });
          yield* indexWrite(
            "/register",
            { key, size: new TextEncoder().encode(text).length, hash },
            key,
          );
        }),
      writeBlob: (key, bytes) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () =>
              env.artifacts.put(key, bytes, {
                httpMetadata: {
                  contentType: contentTypeForKey(
                    key,
                    "application/octet-stream",
                  ),
                },
              }),
            catch: (cause) =>
              new ArtifactReadError({
                key,
                message: `writing artifact ${key} failed`,
                cause,
              }),
          });
          // The server's putFile registers size only — it streamed the
          // bytes to disk and never computed a content hash for them.
          yield* indexWrite(
            "/register",
            { key, size: bytes.length, hash: null },
            key,
          );
        }),
      remove: (key) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => env.artifacts.delete(key),
            catch: (cause) =>
              new ArtifactReadError({
                key,
                message: `deleting artifact ${key} failed`,
                cause,
              }),
          });
          yield* indexWrite("/unregister", { key }, key);
        }),
    }),
    Layer.succeed(ArtifactIndex, {
      listKeys: (prefix) =>
        Effect.gen(function* () {
          const token = yield* Effect.tryPromise({
            try: () => env.indexToken.get(),
            catch: (cause) =>
              new IndexRequestError({
                message: "reading the INDEX_API_TOKEN binding failed",
                cause,
              }),
          });
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(
                `${MEDINA_INDEX_URL}/list?prefix=${encodeURIComponent(prefix)}`,
                { headers: { authorization: `Bearer ${token}` } },
              ),
            catch: (cause) =>
              new IndexRequestError({
                message: `index list for ${prefix} failed to send`,
                cause,
              }),
          });
          if (!response.ok) {
            return yield* Effect.fail(
              new IndexRequestError({
                message: `index list for ${prefix} answered ${response.status}`,
                cause: response.status,
              }),
            );
          }
          const body = yield* Effect.tryPromise({
            try: async () => (await response.json()) as { keys?: unknown },
            catch: (cause) =>
              new IndexRequestError({
                message: `index list for ${prefix} returned unreadable JSON`,
                cause,
              }),
          });
          return Array.isArray(body.keys)
            ? body.keys.filter(
                (k): k is string => typeof k === "string",
              )
            : [];
        }),
      register: (key, size, hash) =>
        indexWrite("/register", { key, size, hash }, key),
      unregister: (key) => indexWrite("/unregister", { key }, key),
    }),
    Layer.succeed(CaptureNotebook, {
      record: (report) =>
        Effect.tryPromise({
          try: async () => {
            const stub = env.notebook.get(
              env.notebook.idFromName(CAPTURE_SHADOW_DO_NAME),
            );
            const response = await stub.fetch(
              new Request("http://capture-shadow/report", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(report),
              }),
            );
            if (!response.ok) {
              throw new Error(
                `notebook rejected a report: ${response.status}`,
              );
            }
          },
          catch: (cause) =>
            new NotebookError({
              message: "recording a shadow report failed",
              cause,
            }),
        }),
      latest: Effect.tryPromise({
        try: async () => {
          const stub = env.notebook.get(
            env.notebook.idFromName(CAPTURE_SHADOW_DO_NAME),
          );
          const response = await stub.fetch(
            new Request("http://capture-shadow/status"),
          );
          if (!response.ok) {
            throw new Error(`notebook status answered ${response.status}`);
          }
          const body = (await response.json()) as {
            lastReport?: CaptureShadowReport | null;
          };
          return body.lastReport != null
            ? Option.some(body.lastReport)
            : Option.none<CaptureShadowReport>();
        },
        catch: (cause) =>
          new NotebookError({
            message: "reading the shadow notebook failed",
            cause,
          }),
      }),
    }),
  );
};

// ---------------------------------------------------------------------------
// The shadow pass: plan every item in the window, diff against reality.
// ---------------------------------------------------------------------------

const MAX_ITEMS_PER_PASS = 1000;
const MAX_STORED_MISMATCHES = 100;
const LIVE_PROVISIONAL_GRACE_MS = 6 * 60 * 60 * 1000;
/**
 * The largest source object the live pass will buffer to hash. Capture
 * segments are 15-minute AAC at 32 kbps (~4 MB by policy); the cap is
 * a guard rail, not an expectation — an object past it fails its item
 * (no receipt, retried, reported) instead of exhausting the isolate.
 */
const MAX_BUFFERED_BYTES = 128 * 1024 * 1024;

const emptyCounts = (): {
  classified: number;
  matched: number;
  legacy: number;
  pending: number;
  mismatched: number;
  performed: number;
} => ({
  classified: 0,
  matched: 0,
  legacy: 0,
  pending: 0,
  mismatched: 0,
  performed: 0,
});

/**
 * Resolve an item's receipt, trying the etag version derivation
 * first and the lastModified derivation second — the server's
 * version comes from its S3 listing, the Worker's from the R2
 * binding, and the shadow proved the two agree (117/117 etag).
 * Shared by the shadow diff and the live pass: one definition of
 * "already ingested" for both halves of the loop.
 */
/** The slice of the ledger receipt resolution needs. */
export interface ReceiptReader {
  readonly readJson: (
    key: string,
  ) => Effect.Effect<Option.Option<unknown>, ArtifactReadError>;
}

export const findReceipt = (
  ledger: ReceiptReader,
  itemSource: CaptureSourceName,
  object: SourceObject,
): Effect.Effect<
  {
    receipt: Option.Option<IngestReceiptShape>;
    receiptKey: string;
    derivation: "etag" | "lastModified" | null;
  },
  ArtifactReadError
> =>
  Effect.gen(function* () {
    const etagVersion = object.etag ?? object.lastModified;
    const etagKey = receiptKeyFor(itemSource, object.key, etagVersion);
    const first = yield* ledger.readJson(etagKey);
    if (Option.isSome(first)) {
      const parsed = parseReceipt(first.value);
      if (parsed !== null) {
        return {
          receipt: Option.some(parsed),
          receiptKey: etagKey,
          derivation: "etag" as const,
        };
      }
    }
    if (object.etag !== null && object.etag !== object.lastModified) {
      const lmKey = receiptKeyFor(itemSource, object.key, object.lastModified);
      const second = yield* ledger.readJson(lmKey);
      if (Option.isSome(second)) {
        const parsed = parseReceipt(second.value);
        if (parsed !== null) {
          return {
            receipt: Option.some(parsed),
            receiptKey: lmKey,
            derivation: "lastModified" as const,
          };
        }
      }
    }
    return {
      receipt: Option.none<IngestReceiptShape>(),
      receiptKey: etagKey,
      derivation: null,
    };
  });

export const runCaptureShadowPass = (
  options: CaptureShadowOptions,
): Effect.Effect<
  CaptureShadowReport,
  CaptureError,
  CaptureSource | ArtifactLedger | ArtifactIndex | CaptureNotebook
> =>
  Effect.gen(function* () {
    const source = yield* CaptureSource;
    const ledger = yield* ArtifactLedger;
    const index = yield* ArtifactIndex;
    const notebook = yield* CaptureNotebook;

    const ranAt = options.windowTo.toISOString();
    const listed = yield* source.listAll;
    const inWindow = listed.filter((object) => {
      const t = Date.parse(object.lastModified);
      return (
        t >= options.windowFrom.getTime() && t < options.windowTo.getTime()
      );
    });

    // Index reachability is probed once per pass on a tiny prefix; a
    // failure degrades index checks for the pass (flagged on the
    // report) instead of failing every item.
    const indexReachable = yield* index
      .listKeys("state/latest-location")
      .pipe(
        Effect.map(() => true),
        Effect.catch(() => Effect.succeed(false)),
      );

    const counts: Record<CaptureSourceName, ReturnType<typeof emptyCounts>> =
      {
        "capture-bucket": emptyCounts(),
        "device-events": emptyCounts(),
        "local-transcripts": emptyCounts(),
      };
    if (options.performed !== undefined) {
      for (const name of Object.keys(counts) as Array<CaptureSourceName>) {
        counts[name].performed = options.performed[name] ?? 0;
      }
    }
    const mismatches: Array<{
      source: CaptureSourceName;
      key: string;
      verdict: string;
      detail: string;
    }> = [];
    let derivationEtag = 0;
    let derivationLastModified = 0;

    const noteMismatch = (
      itemSource: CaptureSourceName,
      key: string,
      verdict: ItemVerdict,
      detail: string,
    ): void => {
      counts[itemSource].mismatched++;
      if (mismatches.length < MAX_STORED_MISMATCHES) {
        mismatches.push({ source: itemSource, key, verdict, detail });
      }
    };

    const ageMs = (object: SourceObject): number =>
      options.windowTo.getTime() - Date.parse(object.lastModified);

    const checkAudio = (
      object: SourceObject,
    ): Effect.Effect<ItemOutcome, ArtifactReadError | IndexRequestError> =>
      Effect.gen(function* () {
        const { receipt, derivation } = yield* findReceipt(
          ledger,
          "capture-bucket",
          object,
        );
        if (derivation === "etag") derivationEtag++;
        if (derivation === "lastModified") derivationLastModified++;
        if (Option.isNone(receipt)) {
          return ageMs(object) > options.staleAfterMs
            ? {
                source: "capture-bucket" as const,
                key: object.key,
                verdict: "missing-receipt" as const,
                detail: "no ingest receipt under either version derivation",
              }
            : {
                source: "capture-bucket" as const,
                key: object.key,
                verdict: "pending" as const,
                detail: "no ingest receipt yet; inside the staleness window",
              };
        }
        const captureId = receipt.value.captureId;
        if (!/^[0-9a-f]{64}$/.test(captureId)) {
          return {
            source: "capture-bucket" as const,
            key: object.key,
            verdict: "legacy" as const,
            detail: `receipt carries a pre-content-hash capture id (${captureId.slice(0, 32)}…)`,
          };
        }
        const filename = object.key.split("/").pop() ?? object.key;
        const blobKey = captureBlobKey(captureId, filename);
        const provKey = provenanceKey(captureId);
        const blobThere = yield* ledger.exists(blobKey);
        const provThere = yield* ledger.exists(provKey);
        if (!blobThere || !provThere) {
          return {
            source: "capture-bucket" as const,
            key: object.key,
            verdict: "missing-artifact" as const,
            detail: `capture ${captureId.slice(0, 12)}…: blob ${blobThere ? "present" : "MISSING"}, provenance ${provThere ? "present" : "MISSING"}`,
          };
        }
        if (indexReachable) {
          const registered = yield* index.listKeys(captureDir(captureId));
          if (
            !registered.includes(blobKey) ||
            !registered.includes(provKey)
          ) {
            return {
              source: "capture-bucket" as const,
              key: object.key,
              verdict: "missing-index" as const,
              detail: `capture ${captureId.slice(0, 12)}…: artifacts in the bucket but not both registered in the index`,
            };
          }
        }
        return {
          source: "capture-bucket" as const,
          key: object.key,
          verdict: "matched" as const,
          detail: `capture ${captureId.slice(0, 12)}…: receipt, blob, provenance${indexReachable ? ", index" : ""} agree`,
        };
      });

    const checkTranscript = (
      object: SourceObject,
    ): Effect.Effect<ItemOutcome, ArtifactReadError> =>
      Effect.gen(function* () {
        const live = object.key.endsWith(".live.json");
        const { receipt, derivation } = yield* findReceipt(
          ledger,
          "local-transcripts",
          object,
        );
        if (derivation === "etag") derivationEtag++;
        if (derivation === "lastModified") derivationLastModified++;
        if (Option.isNone(receipt)) {
          return ageMs(object) > options.staleAfterMs
            ? {
                source: "local-transcripts" as const,
                key: object.key,
                verdict: "missing-receipt" as const,
                detail: "no ingest receipt under either version derivation",
              }
            : {
                source: "local-transcripts" as const,
                key: object.key,
                verdict: "pending" as const,
                detail: "no ingest receipt yet; inside the staleness window",
              };
        }
        if (!live) {
          const captureId = receipt.value.captureId;
          if (captureId === "") {
            return {
              source: "local-transcripts" as const,
              key: object.key,
              verdict: "matched" as const,
              detail: "skip receipt (payload failed validation on the server)",
            };
          }
          const artifact = localTranscriptKey(captureId);
          const there = yield* ledger.exists(artifact);
          return there
            ? {
                source: "local-transcripts" as const,
                key: object.key,
                verdict: "matched" as const,
                detail: `first-look transcript filed for capture ${captureId.slice(0, 12)}…`,
              }
            : {
                source: "local-transcripts" as const,
                key: object.key,
                verdict: "missing-artifact" as const,
                detail: `receipt names capture ${captureId.slice(0, 12)}… but ${artifact} is absent`,
              };
        }
        // Live partials: identity lives in the payload. The
        // provisional is either still live, promoted (marker left,
        // provisional removed), or aged out under the retention
        // sweep — the first two are checked exactly, the third is
        // accepted past the grace window and labelled.
        const liveText = yield* source.downloadText(object.key).pipe(
          Effect.map(Option.some),
          Effect.catch(() => Effect.succeed(Option.none<string>())),
        );
        let liveParsed: LivePhoneTranscript | null = null;
        if (Option.isSome(liveText)) {
          try {
            liveParsed = parseLivePhoneTranscript(
              JSON.parse(liveText.value),
            );
          } catch {
            liveParsed = null;
          }
        }
        if (liveParsed === null) {
          return {
            source: "local-transcripts" as const,
            key: object.key,
            verdict: "matched" as const,
            detail: Option.isNone(liveText)
              ? "receipt present; payload unreadable in this pass (download failed)"
              : "receipt present; payload is not a valid live partial (server skip-receipts those)",
          };
        }
        const liveThere = yield* ledger.exists(
          liveTranscriptKey(liveParsed.installId, liveParsed.segmentUuid),
        );
        const promotedThere = yield* ledger.exists(
          liveTranscriptPromotedKey(
            liveParsed.installId,
            liveParsed.segmentUuid,
          ),
        );
        if (liveThere || promotedThere) {
          return {
            source: "local-transcripts" as const,
            key: object.key,
            verdict: "matched" as const,
            detail: promotedThere
              ? "provisional promoted to the sealed capture"
              : "provisional live transcript present",
          };
        }
        return ageMs(object) > LIVE_PROVISIONAL_GRACE_MS
          ? {
              source: "local-transcripts" as const,
              key: object.key,
              verdict: "matched" as const,
              detail: "receipt present; provisional aged out (promoted or retention-swept)",
            }
          : {
              source: "local-transcripts" as const,
              key: object.key,
              verdict: "missing-artifact" as const,
              detail: "receipt present but neither the provisional nor its promotion marker exists",
            };
      });

    interface EventCheck {
      readonly outcome: ItemOutcome;
      readonly fix: Option.Option<FixCandidate>;
      readonly receipted: boolean;
    }

    const checkEvent = (
      object: SourceObject,
    ): Effect.Effect<EventCheck, ArtifactReadError> =>
      Effect.gen(function* () {
        const { receipt, derivation } = yield* findReceipt(
          ledger,
          "device-events",
          object,
        );
        if (derivation === "etag") derivationEtag++;
        if (derivation === "lastModified") derivationLastModified++;
        const receipted = Option.isSome(receipt);
        // The payload is small and the plan needs it (validation +
        // the fix reduction), so the shadow reads it — the one place
        // the shadow downloads from the source bucket.
        const text = yield* source.downloadText(object.key).pipe(
          Effect.map(Option.some),
          Effect.catch(() => Effect.succeed(Option.none<string>())),
        );
        let event: DeviceEvent | null = null;
        if (Option.isSome(text)) {
          try {
            event = parseDeviceEvent(JSON.parse(text.value));
          } catch {
            event = null;
          }
        } else {
          // The payload could not be read in this pass: the receipt
          // still diffs, but no validation or fix claims are made.
          return {
            outcome: {
              source: "device-events" as const,
              key: object.key,
              verdict: receipted
                ? ("matched" as const)
                : ageMs(object) > options.staleAfterMs
                  ? ("missing-receipt" as const)
                  : ("pending" as const),
              detail: receipted
                ? "receipt present; payload unreadable in this pass (download failed)"
                : "no ingest receipt; payload unreadable in this pass (download failed)",
            },
            fix: Option.none<FixCandidate>(),
            receipted,
          };
        }
        if (!receipted) {
          const verdict =
            ageMs(object) > options.staleAfterMs
              ? ("missing-receipt" as const)
              : ("pending" as const);
          return {
            outcome: {
              source: "device-events" as const,
              key: object.key,
              verdict,
              detail:
                verdict === "pending"
                  ? "no ingest receipt yet; inside the staleness window"
                  : "no ingest receipt under either version derivation",
            },
            fix: Option.none<FixCandidate>(),
            receipted: false,
          };
        }
        if (event === null) {
          return {
            outcome: {
              source: "device-events" as const,
              key: object.key,
              verdict: "matched" as const,
              detail: "skip receipt (payload failed validation on the server)",
            },
            fix: Option.none<FixCandidate>(),
            receipted: true,
          };
        }
        let fix = Option.none<FixCandidate>();
        if (event.type === "location.fix") {
          const parsedFix = parseLocationFix(event.payload);
          if (parsedFix !== null && !parsedFix.mock) {
            fix = Option.some<FixCandidate>({
              installId: event.device,
              eventId: event.id,
              eventSeq: event.seq,
              at: event.at,
              sourceKey: object.key,
            });
          }
        }
        return {
          outcome: {
            source: "device-events" as const,
            key: object.key,
            verdict: "matched" as const,
            detail: `event ${event.type} receipted`,
          },
          fix,
          receipted: true,
        };
      });

    // Classify the window and check every item (bounded concurrency;
    // one item's failure is recorded as its verdict, never fatal).
    const classified = inWindow
      .map((object) => ({ object, source: classifySourceKey(object.key) }))
      .filter(
        (
          entry,
        ): entry is {
          object: SourceObject;
          source: CaptureSourceName;
        } => entry.source !== "skipped",
      );
    const truncated = classified.length > MAX_ITEMS_PER_PASS;
    const batch = classified.slice(0, MAX_ITEMS_PER_PASS);
    for (const entry of batch) counts[entry.source].classified++;

    const fixCandidates: Array<{
      fix: FixCandidate;
      receipted: boolean;
    }> = [];

    const outcomes = yield* Effect.forEach(
      batch,
      (entry) =>
        Effect.gen(function* () {
          if (entry.source === "capture-bucket") {
            return yield* checkAudio(entry.object);
          }
          if (entry.source === "local-transcripts") {
            return yield* checkTranscript(entry.object);
          }
          const checked = yield* checkEvent(entry.object);
          if (Option.isSome(checked.fix)) {
            fixCandidates.push({
              fix: checked.fix.value,
              receipted: checked.receipted,
            });
          }
          return checked.outcome;
        }).pipe(
          Effect.catch((cause) =>
            Effect.succeed<ItemOutcome>({
              source: entry.source,
              key: entry.object.key,
              verdict: "error",
              detail: String(cause).slice(0, 300),
            }),
          ),
        ),
      { concurrency: 16 },
    );

    for (const outcome of outcomes) {
      switch (outcome.verdict) {
        case "matched":
          counts[outcome.source].matched++;
          break;
        case "legacy":
          counts[outcome.source].legacy++;
          break;
        case "pending":
          counts[outcome.source].pending++;
          break;
        default:
          noteMismatch(
            outcome.source,
            outcome.key,
            outcome.verdict,
            outcome.detail,
          );
      }
    }

    // The device-events reduction: per install, the batch's newest
    // fix (by the event's own timestamp, ties by sequence) is the one
    // write the hardened pass would make. Compare it with the
    // believed position medina-dev currently holds.
    const newestByInstall = new Map<
      string,
      { fix: FixCandidate; receipted: boolean }
    >();
    for (const candidate of fixCandidates) {
      const current = newestByInstall.get(candidate.fix.installId);
      if (
        current === undefined ||
        candidate.fix.at > current.fix.at ||
        (candidate.fix.at === current.fix.at &&
          candidate.fix.eventSeq > current.fix.eventSeq)
      ) {
        newestByInstall.set(candidate.fix.installId, candidate);
      }
    }
    const latestLocations: Array<LatestOutcome> = [];
    for (const [installId, candidate] of newestByInstall) {
      const devRaw = yield* ledger
        .readJson(latestLocationKey(installId))
        .pipe(
          Effect.catch(() =>
            Effect.succeed(Option.none<unknown>()),
          ),
        );
      let devEventId: string | null = null;
      let devAt: string | null = null;
      if (Option.isSome(devRaw) && isRecord(devRaw.value)) {
        devEventId =
          typeof devRaw.value["eventId"] === "string"
            ? devRaw.value["eventId"]
            : null;
        devAt =
          typeof devRaw.value["at"] === "string"
            ? devRaw.value["at"]
            : null;
      }
      let verdict: LatestVerdict;
      if (devEventId === candidate.fix.eventId) {
        verdict = "match";
      } else if (devAt !== null && devAt > candidate.fix.at) {
        verdict = "dev-newer";
      } else if (!candidate.receipted) {
        verdict = "pending";
      } else if (devAt === null) {
        verdict = "missing";
      } else {
        verdict = "stale";
      }
      latestLocations.push({
        installId,
        verdict,
        shadowEventId: candidate.fix.eventId,
        shadowAt: candidate.fix.at,
        devEventId,
        devAt,
      });
    }

    const report = new CaptureShadowReport({
      ranAt,
      mode: options.mode,
      windowFrom: options.windowFrom.toISOString(),
      windowTo: options.windowTo.toISOString(),
      listedTotal: listed.length,
      inWindow: inWindow.length,
      checked: batch.length,
      truncated,
      indexReachable,
      derivationEtag,
      derivationLastModified,
      sources: {
        "capture-bucket": new SourceCounts(counts["capture-bucket"]),
        "device-events": new SourceCounts(counts["device-events"]),
        "local-transcripts": new SourceCounts(counts["local-transcripts"]),
      },
      mismatches,
      latestLocations,
    });
    yield* notebook.record(report);
    return report;
  });

// ---------------------------------------------------------------------------
// The live pass: perform every unreceipted item in the scan window,
// exactly as medina-dev's ingest performs it. Per-item order mirrors
// the server: artifacts first, the receipt last (the receipt is the
// guard; a crash before it means the next pass re-performs, and every
// write is idempotent — content-addressed blobs, append-guarded
// provenance, upsert registrations — so re-performing converges).
// One item's failure is recorded and the pass moves on; an unreceipted
// item is retried by the next pass while it is inside the window.
// ---------------------------------------------------------------------------

export const runCaptureLivePass = (
  options: CaptureLiveOptions,
): Effect.Effect<
  CaptureLiveSummary,
  CaptureListError,
  CaptureSource | ArtifactLedger
> =>
  Effect.gen(function* () {
    const source = yield* CaptureSource;
    const ledger = yield* ArtifactLedger;

    const listed = yield* source.listAll;
    const inWindow = listed.filter((object) => {
      const t = Date.parse(object.lastModified);
      return (
        t >= options.windowFrom.getTime() && t < options.windowTo.getTime()
      );
    });
    const classified = inWindow
      .map((object) => ({ object, source: classifySourceKey(object.key) }))
      .filter(
        (
          entry,
        ): entry is {
          object: SourceObject;
          source: CaptureSourceName;
        } => entry.source !== "skipped",
      );

    const performed: Record<CaptureSourceName, number> = {
      "capture-bucket": 0,
      "device-events": 0,
      "local-transcripts": 0,
    };
    const errors: Array<{
      source: CaptureSourceName;
      key: string;
      detail: string;
    }> = [];
    let alreadyReceipted = 0;
    let scanned = 0;

    // The batch's location fixes, reduced per install as they are
    // performed; the believed position is written once, after the
    // items, from the reduction — the §4.3 step-2 hardening.
    const pendingFixes = new Map<
      string,
      { event: DeviceEvent; fix: LocationFix }
    >();
    const noteFix = (event: DeviceEvent, fix: LocationFix): void => {
      const current = pendingFixes.get(event.device);
      if (
        current === undefined ||
        fixWins(
          { at: event.at, eventSeq: event.seq },
          { at: current.event.at, eventSeq: current.event.seq },
        )
      ) {
        pendingFixes.set(event.device, { event, fix });
      }
    };

    const writeReceipt = (
      itemSource: CaptureSourceName,
      object: SourceObject,
      captureId: string,
    ): Effect.Effect<void, ArtifactReadError | IndexRequestError> =>
      ledger.writeText(
        receiptKeyFor(
          itemSource,
          object.key,
          identityVersion(itemSource, object),
        ),
        JSON.stringify(receiptJson(captureId, new Date().toISOString())),
      );

    const performAudio = (
      object: SourceObject,
    ): Effect.Effect<void, ArtifactReadError | IndexRequestError | Error> =>
      Effect.gen(function* () {
        if (object.size > MAX_BUFFERED_BYTES) {
          return yield* Effect.fail(
            new Error(
              `source object is ${object.size} bytes, past the ${MAX_BUFFERED_BYTES}-byte buffer cap`,
            ),
          );
        }
        const bytes = yield* source.downloadBytes(object.key);
        const captureId = yield* Effect.promise(() => sha256Hex(bytes));
        // Grandfather: a transcript already exists under the
        // pre-content-hash id — adopt that id, retain no audio.
        const legacyId = ingestIdFor(
          "capture-bucket",
          object.key,
          identityVersion("capture-bucket", object),
        );
        if (yield* ledger.exists(canonicalTranscriptKey(legacyId))) {
          yield* writeReceipt("capture-bucket", object, legacyId);
          return;
        }
        const filename = object.key.split("/").pop() ?? object.key;
        const blobKey = captureBlobKey(captureId, filename);
        if (!(yield* ledger.exists(blobKey))) {
          yield* ledger.writeBlob(blobKey, bytes);
        }
        const provKey = provenanceKey(captureId);
        const existingProv = yield* ledger.readJson(provKey);
        const { next, changed } = appendProvenanceRecord(
          Option.getOrNull(existingProv),
          captureId,
          {
            source: "capture-bucket",
            filename,
            fileId: object.key,
            mimeType: "audio/mp4",
            modifiedTime: object.lastModified,
            md5Checksum: object.etag,
            fetchedAt: new Date().toISOString(),
          },
        );
        if (changed) {
          yield* ledger.writeText(provKey, JSON.stringify(next));
        }
        yield* writeReceipt("capture-bucket", object, captureId);
        // Promote a live provisional for this segment now that the
        // content-hash capture id is known (LocalTranscripts.ts).
        const parsedKey = parseCaptureAudioKey(object.key);
        if (parsedKey !== null) {
          const liveKey = liveTranscriptKey(
            parsedKey.installId,
            parsedKey.segmentUuid,
          );
          const provisional = yield* ledger.readText(liveKey);
          if (Option.isSome(provisional)) {
            let valid = false;
            try {
              valid = isRecord(JSON.parse(provisional.value));
            } catch {
              valid = false;
            }
            const target = localTranscriptKey(captureId);
            if (valid && !(yield* ledger.exists(target))) {
              yield* ledger.writeText(target, provisional.value);
            }
            yield* ledger.remove(liveKey);
            yield* ledger.writeText(
              liveTranscriptPromotedKey(
                parsedKey.installId,
                parsedKey.segmentUuid,
              ),
              JSON.stringify(
                receiptJson(captureId, new Date().toISOString()),
              ),
            );
          }
        }
      });

    // A payload that does not parse fails the item, as the server's
    // ingest fails it: no receipt, retried next pass. (Effect.try, not
    // a bare throw — a throw inside the generator would be a defect
    // and escape the item-level failure handling.)
    const parseJson = (text: string): Effect.Effect<unknown, Error> =>
      Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: (cause) =>
          new Error(`payload is not valid JSON: ${String(cause).slice(0, 120)}`),
      });

    const performEvent = (
      object: SourceObject,
    ): Effect.Effect<void, ArtifactReadError | IndexRequestError | Error> =>
      Effect.gen(function* () {
        const text = yield* source.downloadText(object.key);
        const raw = yield* parseJson(text);
        const event = parseDeviceEvent(raw);
        if (event === null) {
          // Failed validation: a skip receipt, so it is never retried.
          yield* writeReceipt("device-events", object, "");
          return;
        }
        if (event.type === "location.fix") {
          const fix = parseLocationFix(event.payload);
          if (fix !== null && !fix.mock) {
            const point = gpsInboxPoint(event, fix);
            const body = gpsInboxText([point]);
            const hash = yield* Effect.promise(() => sha256Hex(body));
            const file = gpsInboxFile(
              [point],
              new Date().toISOString(),
              hash,
            );
            yield* ledger.writeText(file.key, file.text);
            noteFix(event, fix);
          }
        }
        yield* writeReceipt("device-events", object, event.id);
      });

    const performTranscript = (
      object: SourceObject,
    ): Effect.Effect<void, ArtifactReadError | IndexRequestError | Error> =>
      Effect.gen(function* () {
        const text = yield* source.downloadText(object.key);
        const raw = yield* parseJson(text);
        const now = new Date().toISOString();
        if (object.key.endsWith(".live.json")) {
          const parsed = parseLivePhoneTranscript(raw);
          if (parsed === null) {
            yield* writeReceipt("local-transcripts", object, "");
            return;
          }
          // A partial that raced the seal must not resurrect a
          // promoted provisional.
          const promoted = yield* ledger.exists(
            liveTranscriptPromotedKey(parsed.installId, parsed.segmentUuid),
          );
          if (!promoted) {
            yield* ledger.writeText(
              liveTranscriptKey(parsed.installId, parsed.segmentUuid),
              JSON.stringify(
                phoneTranscriptJson(
                  parsed,
                  `live-${parsed.updateSeq}`,
                  `live/${parsed.installId}/${parsed.segmentUuid}`,
                  object.key,
                  now,
                ),
              ),
            );
          }
          yield* writeReceipt("local-transcripts", object, "");
          return;
        }
        const parsed = parsePhoneTranscript(raw);
        if (parsed === null) {
          yield* writeReceipt("local-transcripts", object, "");
          return;
        }
        // Always write: the batch final transcribes the whole sealed
        // file, so it is the authoritative first-look and wins over a
        // promoted provisional regardless of ingest order.
        yield* ledger.writeText(
          localTranscriptKey(parsed.captureId),
          JSON.stringify(
            phoneTranscriptJson(parsed, "1", parsed.captureId, parsed.audioKey, now),
          ),
        );
        yield* writeReceipt("local-transcripts", object, parsed.captureId);
      });

    // Scan: resolve every in-window item's receipt (bounded
    // concurrency — the fan-out the shadow diff uses). A failed
    // receipt read marks the item unreceipted; its perform then
    // surfaces the underlying failure as the item's error.
    const checks = yield* Effect.forEach(
      classified,
      (entry) =>
        Effect.gen(function* () {
          const { receipt } = yield* findReceipt(
            ledger,
            entry.source,
            entry.object,
          );
          return { entry, receipted: Option.isSome(receipt) };
        }).pipe(
          Effect.catch(() =>
            Effect.succeed({ entry, receipted: false }),
          ),
        ),
      { concurrency: 16 },
    );
    scanned = checks.length;
    alreadyReceipted = checks.filter((check) => check.receipted).length;

    // Perform: sequential, newest-first per source (the listing's
    // order), capped per source — the order the reduction and the
    // receipt guard are reasoned about in.
    for (const { entry, receipted } of checks) {
      if (receipted) continue;
      if (performed[entry.source] >= options.perSourceLimit) continue;
      const outcome = yield* Effect.gen(function* () {
        if (entry.source === "capture-bucket") {
          yield* performAudio(entry.object);
        } else if (entry.source === "device-events") {
          yield* performEvent(entry.object);
        } else {
          yield* performTranscript(entry.object);
        }
        return "performed" as const;
      }).pipe(
        Effect.match({
          onFailure: (cause) => ({
            kind: "error" as const,
            detail: String(cause).slice(0, 300),
          }),
          onSuccess: (kind) => ({ kind, detail: "" }),
        }),
      );
      if (outcome.kind === "performed") performed[entry.source]++;
      else {
        errors.push({
          source: entry.source,
          key: entry.object.key,
          detail: outcome.detail,
        });
      }
    }

    // The reduction lands once per install: the batch's newest fix,
    // and only when it displaces the believed position.
    for (const [installId, pending] of pendingFixes) {
      const key = latestLocationKey(installId);
      const believed = yield* ledger.readJson(key).pipe(
        Effect.catch(() => Effect.succeed(Option.none<unknown>())),
      );
      if (
        fixWins(
          { at: pending.event.at, eventSeq: pending.event.seq },
          Option.getOrNull(believed),
        )
      ) {
        yield* ledger
          .writeText(
            key,
            JSON.stringify(
              latestLocationJson(
                pending.event,
                pending.fix,
                new Date().toISOString(),
              ),
            ),
          )
          .pipe(
            Effect.catch((cause) =>
              Effect.sync(() => {
                errors.push({
                  source: "device-events",
                  key,
                  detail: `latest-location write failed: ${String(cause).slice(0, 240)}`,
                });
              }),
            ),
          );
      }
    }

    return {
      listedTotal: listed.length,
      scanned,
      performed,
      alreadyReceipted,
      errors,
    };
  });

// ---------------------------------------------------------------------------
// CaptureShadow: the shadow's notebook. One instance holds the pass
// reports (newest last 100) in its own SQLite storage — the only state
// the shadow writes anywhere.
// ---------------------------------------------------------------------------

export const CAPTURE_SHADOW_DO_NAME = "capture-shadow-v1";

interface SqlCursorLike {
  toArray(): Array<Record<string, unknown>>;
}

interface SqlStorageLike {
  exec(
    query: string,
    ...bindings: Array<unknown>
  ): SqlCursorLike;
}

interface DurableObjectStateLike {
  readonly storage: { readonly sql: SqlStorageLike };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

export class CaptureShadow {
  private readonly sql: SqlStorageLike;

  constructor(state: DurableObjectStateLike) {
    this.sql = state.storage.sql;
    void state.blockConcurrencyWhile(async () => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS reports (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           ran_at TEXT NOT NULL,
           report TEXT NOT NULL
         )`,
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/report") {
      const body = await request.text();
      let ranAt = new Date().toISOString();
      try {
        const parsed = JSON.parse(body) as { ranAt?: unknown };
        if (typeof parsed.ranAt === "string") ranAt = parsed.ranAt;
      } catch {
        // keep the default; the body is still stored verbatim
      }
      this.sql.exec(
        `INSERT INTO reports (ran_at, report) VALUES (?, ?)`,
        ranAt,
        body,
      );
      this.sql.exec(
        `DELETE FROM reports WHERE id NOT IN (
           SELECT id FROM reports ORDER BY id DESC LIMIT 100
         )`,
      );
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (request.method === "GET" && url.pathname === "/status") {
      const rows = this.sql
        .exec(`SELECT report FROM reports ORDER BY id DESC LIMIT 1`)
        .toArray();
      const countRows = this.sql
        .exec(`SELECT COUNT(*) AS n FROM reports`)
        .toArray();
      const lastReport =
        rows.length > 0 && typeof rows[0]?.["report"] === "string"
          ? (JSON.parse(rows[0]["report"] as string) as unknown)
          : null;
      return new Response(
        JSON.stringify({
          runCount: Number(countRows[0]?.["n"] ?? 0),
          lastReport,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
}
