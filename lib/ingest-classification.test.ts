import { describe, expect, test } from "bun:test";

import { classifyIngest, parseLocationPointBody } from "./ingest-classification";

describe("ingest classification", () => {
  test("recognizes GPS logger form bodies before generic text handling", () => {
    expect(parseLocationPointBody("lat=37.1&lon=-122.2&time=2026-06-25T12%3A34%3A56Z&s=1.5")).toEqual({
      eventTime: "2026-06-25T12:34:56.000Z",
      latitude: 37.1,
      longitude: -122.2,
      speed: 1.5,
    });
    expect(classifyIngest({
      body: "lat=37.1&lon=-122.2&time=1782388800",
      contentType: "application/octet-stream",
    })).toMatchObject({
      kind: "location-point",
    });
    expect(classifyIngest({
      body: "lat=37.1&lon=-122.2&time=2026-07-17T12%3A34%3A56Z",
      contentType: "text/plain",
    })).toMatchObject({
      kind: "location-point",
    });
  });

  test("classifies audio from MIME, extension, and magic bytes", () => {
    expect(classifyIngest({ contentType: "audio/mpeg" })).toMatchObject({
      evidence: "content-type",
      kind: "audio",
    });
    expect(classifyIngest({ fileName: "voice-note.M4A" })).toMatchObject({
      evidence: "extension",
      kind: "audio",
    });
    expect(classifyIngest({
      body: new Uint8Array([0x49, 0x44, 0x33, 0x04]),
      contentType: "application/octet-stream",
    })).toMatchObject({
      evidence: "magic-bytes",
      kind: "audio",
    });
  });

  test("classifies av candidates from MIME, extension, and container magic", () => {
    expect(classifyIngest({ contentType: "video/mp4" })).toMatchObject({
      evidence: "content-type",
      kind: "av-candidate",
    });
    expect(classifyIngest({ fileName: "clip.webm" })).toMatchObject({
      evidence: "extension",
      kind: "av-candidate",
    });
    expect(classifyIngest({
      body: new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]),
      contentType: "application/octet-stream",
    })).toMatchObject({
      evidence: "magic-bytes",
      kind: "av-candidate",
    });
  });

  test("classifies images from MIME, extension, and magic bytes", () => {
    expect(classifyIngest({ contentType: "image/png" })).toMatchObject({
      evidence: "content-type",
      kind: "image",
    });
    expect(classifyIngest({ fileName: "photo.jpeg" })).toMatchObject({
      evidence: "extension",
      kind: "image",
    });
    expect(classifyIngest({
      body: new Uint8Array([0xff, 0xd8, 0xff, 0xdb]),
      contentType: "application/octet-stream",
    })).toMatchObject({
      evidence: "magic-bytes",
      kind: "image",
    });
  });

  test("classifies generic text without confusing it for GPS or audio", () => {
    expect(classifyIngest({ body: "hello=world", contentType: "text/plain" })).toEqual({
      confidence: 0.8,
      evidence: "content-type",
      kind: "text",
    });
    expect(classifyIngest({ fileName: "notes.json" })).toEqual({
      confidence: 0.75,
      evidence: "extension",
      kind: "text",
    });
    expect(classifyIngest({
      body: new Uint8Array([0x49, 0x44, 0x33, 0x04]),
      contentType: "text/plain",
    })).toMatchObject({
      evidence: "magic-bytes",
      kind: "audio",
    });
  });

  test("does not classify PDFs as dispatchable audio", () => {
    expect(classifyIngest({ contentType: "application/pdf" })).toEqual({
      confidence: 0,
      kind: "unknown",
    });
    expect(classifyIngest({
      body: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      contentType: "application/octet-stream",
    })).toEqual({
      confidence: 0,
      kind: "unknown",
    });
    expect(classifyIngest({ fileName: "document.pdf" })).toEqual({
      confidence: 0,
      kind: "unknown",
    });
  });
});
