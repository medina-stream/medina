/**
 * Domain-port tests for the capture-loop shadow (src/capture.ts): the
 * classification, receipt-key derivation, key parsing, and payload
 * validation must agree with the medina-dev implementations they
 * mirror (lib/capture/*, lib/lifelog/Resources.ts) — these vectors pin
 * that agreement. The live parity evidence is the shadow pass itself.
 */
import { describe, expect, test } from "bun:test";
import {
  appendProvenanceRecord,
  canonicalTranscriptKey,
  captureBlobKey,
  classifySourceKey,
  contentTypeForKey,
  fixWins,
  gpsInboxFile,
  gpsInboxPoint,
  gpsInboxText,
  identityVersion,
  ingestIdFor,
  latestLocationJson,
  latestLocationKey,
  liveTranscriptKey,
  localTranscriptKey,
  parseCaptureAudioKey,
  parseDeviceEvent,
  parseLivePhoneTranscript,
  parseLocationFix,
  parsePhoneTranscript,
  parseReceipt,
  phoneTranscriptJson,
  provenanceKey,
  receiptJson,
  receiptKeyFor,
  sha256Hex,
  SourceObject,
} from "./capture.ts";

const INSTALL = "4aa981c1-e6a1-4422-a0df-f2215c2781a3";
const SEGMENT = "3f8a2b1c-1111-4222-8333-444455556666";
const AUDIO_KEY = `${INSTALL}/audio/2026/11/02/20261102T180000Z-${SEGMENT}.m4a`;

describe("classifySourceKey", () => {
  test("audio segments are capture-bucket, case-insensitively", () => {
    expect(classifySourceKey(AUDIO_KEY)).toBe("capture-bucket");
    expect(classifySourceKey(`${INSTALL}/audio/X.M4A`)).toBe("capture-bucket");
  });
  test("probe objects are dropped outright", () => {
    expect(classifySourceKey("probe/9f86d081")).toBe("skipped");
  });
  test("events and transcripts classify by their markers", () => {
    expect(
      classifySourceKey(`${INSTALL}/events/2026/11/02/20261102T180000Z-x.json`),
    ).toBe("device-events");
    expect(
      classifySourceKey(
        `${INSTALL}/transcript/2026/11/02/20261102T180000Z-${SEGMENT}.json`,
      ),
    ).toBe("local-transcripts");
    expect(
      classifySourceKey(
        `${INSTALL}/transcript/2026/11/02/20261102T180000Z-${SEGMENT}.live.json`,
      ),
    ).toBe("local-transcripts");
  });
  test("location JSON and everything else is skipped", () => {
    expect(
      classifySourceKey(`${INSTALL}/location/2026/11/02/20261102T180000Z-x.json`),
    ).toBe("skipped");
    expect(classifySourceKey("README")).toBe("skipped");
  });
});

describe("receiptKeyFor", () => {
  test("matches ingestReceiptKey's sanitize-and-join derivation", () => {
    // `${fileId}-${version}` with /, . stripped; hyphens survive.
    expect(
      receiptKeyFor("capture-bucket", AUDIO_KEY, "abc123etag"),
    ).toBe(
      `ingest/capture-bucket/${INSTALL}audio2026110220261102T180000Z-${SEGMENT}m4a-abc123etag.json`,
    );
    expect(
      receiptKeyFor(
        "device-events",
        `${INSTALL}/events/2026/11/02/e.json`,
        "etag-1",
      ),
    ).toBe(
      `ingest/device-events/${INSTALL}events20261102ejson-etag-1.json`,
    );
  });
});

describe("identityVersion", () => {
  const object = new SourceObject({
    key: AUDIO_KEY,
    size: 10,
    etag: "etagx",
    lastModified: "2026-11-02T18:00:00.000Z",
  });
  test("etags win; lastModified is the fallback", () => {
    expect(identityVersion("capture-bucket", object)).toBe("etagx");
    expect(
      identityVersion(
        "device-events",
        new SourceObject({ ...object, etag: null }),
      ),
    ).toBe("2026-11-02T18:00:00.000Z");
  });
});

describe("artifact keys", () => {
  const id = "a".repeat(64);
  test("capture keys mirror Resources.ts", () => {
    expect(provenanceKey(id)).toBe(`capture/${id}/provenance.json`);
    expect(captureBlobKey(id, "seg.m4a")).toBe(`capture/${id}/seg.m4a`);
    expect(captureBlobKey(id, "provenance.json")).toBe(
      `capture/${id}/_provenance.json`,
    );
    expect(localTranscriptKey(id)).toBe(
      `transcript/assemblyai-u35p-v1/${id}.ondevice.json`,
    );
    expect(liveTranscriptKey(INSTALL, SEGMENT)).toBe(
      `transcript/assemblyai-u35p-v1/live/${INSTALL}/${SEGMENT}.json`,
    );
    expect(latestLocationKey(INSTALL)).toBe(
      `state/latest-location/${INSTALL}.json`,
    );
  });
});

describe("parseCaptureAudioKey", () => {
  test("extracts install and segment from a recorder key", () => {
    expect(parseCaptureAudioKey(AUDIO_KEY)).toEqual({
      installId: INSTALL,
      segmentUuid: SEGMENT,
    });
  });
  test("rejects non-audio keys", () => {
    expect(parseCaptureAudioKey(`${INSTALL}/location/x.json`)).toBeNull();
    expect(parseCaptureAudioKey("audio/2026/x.m4a")).toBeNull();
  });
});

describe("payload validation", () => {
  const event = {
    schemaVersion: 1,
    id: "evt-1",
    device: INSTALL,
    seq: 7,
    at: "2026-11-02T18:00:00.000Z",
    type: "location.fix",
    payload: {
      lat: 37.7968,
      lon: -122.4373,
      accuracyM: 12,
      speedMps: null,
      bearingDeg: null,
      mock: false,
      activity: { type: "still", confidence: 90 },
    },
  };
  test("a well-formed location.fix parses end to end", () => {
    const parsed = parseDeviceEvent(event);
    expect(parsed?.id).toBe("evt-1");
    const fix = parseLocationFix(parsed?.payload);
    expect(fix?.lat).toBe(37.7968);
    expect(fix?.activityType).toBe("still");
    expect(fix?.mock).toBe(false);
  });
  test("malformed envelopes and fixes are rejected like the server", () => {
    expect(parseDeviceEvent({ ...event, schemaVersion: 2 })).toBeNull();
    expect(parseDeviceEvent({ ...event, seq: "7" })).toBeNull();
    expect(parseDeviceEvent({ ...event, at: "not a date" })).toBeNull();
    expect(
      parseLocationFix({ lat: 91, lon: 0, accuracyM: 1 }),
    ).toBeNull();
    expect(parseLocationFix({ lat: 0, lon: 0 })).toBeNull();
  });
  test("live partials require the live flag and a uuid segment", () => {
    const live = {
      schemaVersion: 1,
      live: true,
      segmentUuid: SEGMENT,
      installId: INSTALL,
      capturedAt: "2026-11-02T18:00:00.000Z",
      updateSeq: 3,
      text: "hello",
      segments: [{ start: 0, end: 1.5, text: "hello" }],
    };
    expect(parseLivePhoneTranscript(live)?.updateSeq).toBe(3);
    expect(parseLivePhoneTranscript({ ...live, live: false })).toBeNull();
    expect(
      parseLivePhoneTranscript({ ...live, segmentUuid: "nope" }),
    ).toBeNull();
  });
  test("receipts parse, junk does not", () => {
    expect(
      parseReceipt({ captureId: "x", ingestedAt: "2026-11-02T18:00:00Z" })
        ?.captureId,
    ).toBe("x");
    expect(parseReceipt({ nope: 1 })).toBeNull();
    expect(parseReceipt("str")).toBeNull();
  });
  test("final first-look transcripts require a content-hash capture id", () => {
    const captureId = "a".repeat(64);
    const parsed = parsePhoneTranscript({
      schemaVersion: 1,
      captureId,
      audioKey: AUDIO_KEY,
      text: "hello world",
      segments: [{ start: 0, end: 2, text: "hello world" }],
    });
    expect(parsed?.captureId).toBe(captureId);
    expect(parsed?.engine).toBe("whisper.cpp");
    expect(parsed?.capturedAt).toBeNull();
    expect(
      parsePhoneTranscript({ schemaVersion: 1, captureId: "short", text: "", segments: [] }),
    ).toBeNull();
    expect(
      parsePhoneTranscript({ schemaVersion: 1, captureId, text: "", segments: [{ start: "0" }] }),
    ).toBeNull();
  });
});

describe("performed writes", () => {
  const captureId = "b".repeat(64);
  test("receipt and identity derivations match the server", () => {
    expect(receiptJson("cap", "2026-11-02T18:00:00.000Z")).toEqual({
      captureId: "cap",
      ingestedAt: "2026-11-02T18:00:00.000Z",
    });
    expect(ingestIdFor("capture-bucket", "a/b c.m4a", "v1")).toBe(
      "capture-bucket-abcm4a-v1",
    );
    expect(canonicalTranscriptKey(captureId)).toBe(
      `transcript/assemblyai-u35p-v1/${captureId}.json`,
    );
    expect(contentTypeForKey("x/y.json", "fb")).toBe("application/json");
    expect(contentTypeForKey("x/y.m4a", "fb")).toBe("audio/mp4");
    expect(contentTypeForKey("x/y.ndjson", "fb")).toBe("application/x-ndjson");
    expect(contentTypeForKey("x/y.bin", "fb")).toBe("fb");
  });
  test("provenance appends a sighting once, keyed by source+file+name", () => {
    const record = {
      source: "capture-bucket",
      filename: "seg.m4a",
      fileId: AUDIO_KEY,
      mimeType: "audio/mp4",
      modifiedTime: "2026-11-02T18:00:00.000Z",
      md5Checksum: "etag-1",
      fetchedAt: "2026-11-02T18:01:00.000Z",
    };
    const first = appendProvenanceRecord(null, captureId, record);
    expect(first.changed).toBe(true);
    expect(first.next.records).toHaveLength(1);
    const again = appendProvenanceRecord(first.next, captureId, record);
    expect(again.changed).toBe(false);
    expect(again.next.records).toHaveLength(1);
    const other = appendProvenanceRecord(first.next, captureId, {
      ...record,
      filename: "renamed.m4a",
    });
    expect(other.changed).toBe(true);
    expect(other.next.records).toHaveLength(2);
    // A corrupt existing document is treated as absent, as the
    // server's failed schema decode is.
    expect(appendProvenanceRecord("junk", captureId, record).changed).toBe(
      true,
    );
  });
  test("phone transcripts serialize in the Transcript schema's shape", () => {
    const doc = phoneTranscriptJson(
      {
        capturedAt: null,
        segments: [{ start: 0.0004, end: 1.5, text: "hi" }],
        text: "hi",
      },
      "1",
      captureId,
      AUDIO_KEY,
      "2026-11-02T18:01:00.000Z",
    );
    expect(doc["provider"]).toBe("ondevice");
    expect("capturedAt" in doc).toBe(false);
    expect(doc["transcriptId"]).toBeNull();
    expect(doc["status"]).toBe("completed");
    expect(doc["utterances"]).toEqual([
      { speaker: null, startMs: 0, endMs: 1500, text: "hi", confidence: null },
    ]);
    const withStamp = phoneTranscriptJson(
      { capturedAt: "2026-11-02T18:00:00.000Z", segments: [], text: "" },
      "live-3",
      `live/${INSTALL}/${SEGMENT}`,
      AUDIO_KEY,
      "2026-11-02T18:01:00.000Z",
    );
    expect(withStamp["capturedAt"]).toBe("2026-11-02T18:00:00.000Z");
    expect(withStamp["version"]).toBe("live-3");
  });
  test("the latest-location reduction is newest-wins, ties by sequence", () => {
    const believed = {
      at: "2026-11-02T18:00:00.000Z",
      eventSeq: 7,
    };
    expect(fixWins({ at: "2026-11-02T18:01:00.000Z", eventSeq: 1 }, believed)).toBe(true);
    expect(fixWins({ at: "2026-11-02T17:59:00.000Z", eventSeq: 99 }, believed)).toBe(false);
    expect(fixWins({ at: believed.at, eventSeq: 8 }, believed)).toBe(true);
    expect(fixWins({ at: believed.at, eventSeq: 7 }, believed)).toBe(false);
    expect(fixWins({ at: believed.at, eventSeq: 1 }, null)).toBe(true);
    expect(fixWins({ at: believed.at, eventSeq: 1 }, "junk")).toBe(true);
  });
  test("latest-location and gps inbox documents match the server's", async () => {
    const event = parseDeviceEvent({
      schemaVersion: 1,
      id: "evt-9",
      device: INSTALL,
      seq: 11,
      at: "2026-11-02T18:05:00.000Z",
      type: "location.fix",
      payload: {
        lat: 37.7968,
        lon: -122.4373,
        accuracyM: 9,
        speedMps: 1.5,
        bearingDeg: null,
        mock: false,
        activity: { type: "walking", confidence: 80 },
      },
    });
    if (event === null) throw new Error("event should parse");
    const fix = parseLocationFix(event.payload);
    if (fix === null) throw new Error("fix should parse");
    expect(
      latestLocationJson(event, fix, "2026-11-02T18:05:30.000Z"),
    ).toEqual({
      installId: INSTALL,
      lat: 37.7968,
      lon: -122.4373,
      accuracyM: 9,
      speedMps: 1.5,
      bearingDeg: null,
      activityType: "walking",
      activityConfidence: 80,
      at: "2026-11-02T18:05:00.000Z",
      eventId: "evt-9",
      eventSeq: 11,
      updatedAt: "2026-11-02T18:05:30.000Z",
    });
    const point = gpsInboxPoint(event, fix);
    expect(point.source).toBe(`capture/${INSTALL}`);
    expect(point.ts).toBe("2026-11-02T18:05:00.000Z");
    expect(point.acc).toBe(9);
    expect(JSON.parse(point.raw)).toEqual({
      id: "evt-9",
      device: INSTALL,
      seq: 11,
      at: "2026-11-02T18:05:00.000Z",
      type: "location.fix",
      payload: event.payload,
    });
    const text = gpsInboxText([point]);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trim().split("\n")).toHaveLength(1);
    const hash = await sha256Hex(text);
    const file = gpsInboxFile([point], "2026-11-02T18:05:30.123Z", hash);
    expect(file.key).toBe(
      `gps/inbox/2026-11-02T180530123Z-${hash.slice(0, 8)}.ndjson`,
    );
    expect(file.text).toBe(text);
  });
});
