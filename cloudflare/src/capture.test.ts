/**
 * Domain-port tests for the capture-loop shadow (src/capture.ts): the
 * classification, receipt-key derivation, key parsing, and payload
 * validation must agree with the medina-dev implementations they
 * mirror (lib/capture/*, lib/lifelog/Resources.ts) — these vectors pin
 * that agreement. The live parity evidence is the shadow pass itself.
 */
import { describe, expect, test } from "bun:test";
import {
  captureBlobKey,
  classifySourceKey,
  identityVersion,
  latestLocationKey,
  liveTranscriptKey,
  localTranscriptKey,
  parseCaptureAudioKey,
  parseDeviceEvent,
  parseLivePhoneTranscript,
  parseLocationFix,
  parseReceipt,
  provenanceKey,
  receiptKeyFor,
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
});
