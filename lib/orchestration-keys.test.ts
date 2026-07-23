import { describe, expect, test } from "bun:test";

import { decodeWorkKeySegment, encodeWorkKeySegment } from "./work-queue";
import {
  decodeOrchestrationKeySegment,
  dispatchGroupPrefix,
  dispatchMembershipKey,
  encodeOrchestrationKeySegment,
  triageKey,
} from "./orchestration-keys";

describe("orchestration keys", () => {
  test("uses the same reversible base64url encoding as work queue keys", () => {
    const keys = [
      "in/0197b2a7-7e0a-7de4-a4e7-a813ab08f13d",
      "sources/phone/camera-roll/2026/07/17/clip 01?.m4a",
      "triage/in/source-1/clip:01?.m4a",
      "dispatch-index/ingests/group:alpha/in/source-1/clip:01?.m4a",
    ];

    for (const key of keys) {
      const encoded = encodeOrchestrationKeySegment(key);
      expect(encoded).toBe(encodeWorkKeySegment(key));
      expect(decodeOrchestrationKeySegment(encoded)).toBe(key);
      expect(decodeWorkKeySegment(encoded)).toBe(key);
    }
  });

  test("builds deterministic triage and dispatch keys", () => {
    const ingestKey = "in/source-1/clip:01?.m4a";
    const handlerName = "ingests/audio";
    const groupKey = "recordings/2026-07-17T12";
    const triageObjectKey = triageKey(ingestKey);

    expect(triageObjectKey).toBe(`triage/${encodeOrchestrationKeySegment(ingestKey)}.json`);
    expect(dispatchGroupPrefix(handlerName, groupKey)).toBe(
      `dispatch-index/${handlerName}/${encodeOrchestrationKeySegment(groupKey)}/`,
    );
    expect(dispatchMembershipKey(handlerName, groupKey, triageObjectKey)).toBe(
      `dispatch-index/${handlerName}/${encodeOrchestrationKeySegment(groupKey)}/${encodeOrchestrationKeySegment(triageObjectKey)}.json`,
    );
  });

  test("rejects invalid traversal and malformed encoded segments", () => {
    expect(() => encodeOrchestrationKeySegment("../escape")).toThrow("Invalid bucket key");
    expect(() => decodeOrchestrationKeySegment("bad$segment")).toThrow("Invalid encoded orchestration key segment");
  });
});
