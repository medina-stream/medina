/**
 * Domain-port tests for the archive sweep (src/archive.ts): the
 * reconciliation plan must make the same decisions as medina-dev's
 * archiveCapture (lib/capture/Archive.ts) over the same inputs —
 * carry / head-verify / upload, and the rewrite condition. The live
 * parity evidence is the shadow pass itself.
 */
import { describe, expect, test } from "bun:test";
import {
  archiveContentTypeFor,
  archiveReceiptJson,
  archiveReceiptKey,
  parseArchiveReceipt,
  planArchiveCapture,
  type ArchiveReceiptShape,
  type CaptureFile,
} from "./archive.ts";
import type { CatalogHead } from "./catalog.ts";

const NOW = "2026-11-03T00:00:00.000Z";

const file = (name: string, size: number): CaptureFile => ({
  name,
  size,
  uploaded: new Date("2026-11-01T00:00:00.000Z"),
});

const receiptOf = (
  captureId: string,
  files: ArchiveReceiptShape["files"],
): ArchiveReceiptShape => ({ captureId, files });

const head = (size: number, etag = "etagx"): CatalogHead => ({
  size,
  etag,
  uploaded: "2026-11-01T00:00:00.000Z",
});

describe("planArchiveCapture", () => {
  test("a settled capture carries everything and rewrites nothing", () => {
    const listed = [file("a.m4a", 100), file("provenance.json", 10)];
    const receipt = receiptOf("cap", [
      { name: "a.m4a", size: 100, etag: "e1", uploadedAt: "2026-10-01T00:00:00.000Z" },
      { name: "provenance.json", size: 10, etag: "e2", uploadedAt: "2026-10-01T00:00:00.000Z" },
    ]);
    const plan = planArchiveCapture("cap", listed, receipt, new Map(), NOW);
    expect(plan.rewrite).toBe(false);
    expect(plan.uploads).toEqual([]);
    expect(plan.entries.map((e) => e.etag)).toEqual(["e1", "e2"]);
    expect(plan.ghosts).toEqual([]);
  });

  test("no receipt: every file is head-verified, none uploaded, receipt written", () => {
    const listed = [file("a.m4a", 100), file("provenance.json", 10)];
    const heads = new Map([
      ["a.m4a", head(100, "ha")],
      ["provenance.json", head(10, "hp")],
    ]);
    const plan = planArchiveCapture("cap", listed, null, heads, NOW);
    expect(plan.rewrite).toBe(true);
    expect(plan.uploads).toEqual([]);
    expect(plan.entries).toEqual([
      { name: "a.m4a", size: 100, etag: "ha", uploadedAt: "2026-11-01T00:00:00.000Z" },
      { name: "provenance.json", size: 10, etag: "hp", uploadedAt: "2026-11-01T00:00:00.000Z" },
    ]);
  });

  test("a file the bucket cannot head is an upload, receipted at plan time", () => {
    const listed = [file("a.m4a", 100)];
    const heads = new Map<string, CatalogHead | null>([["a.m4a", null]]);
    const plan = planArchiveCapture("cap", listed, null, heads, NOW);
    expect(plan.uploads).toEqual(["a.m4a"]);
    expect(plan.entries).toEqual([
      { name: "a.m4a", size: 100, etag: null, uploadedAt: NOW },
    ]);
    expect(plan.rewrite).toBe(true);
  });

  test("a grown file re-verifies by head; a size mismatch there uploads", () => {
    const listed = [file("provenance.json", 12)];
    const receipt = receiptOf("cap", [
      { name: "provenance.json", size: 10, etag: "old", uploadedAt: "2026-10-01T00:00:00.000Z" },
    ]);
    const verified = planArchiveCapture(
      "cap",
      listed,
      receipt,
      new Map([["provenance.json", head(12, "new")]]),
      NOW,
    );
    expect(verified.uploads).toEqual([]);
    expect(verified.entries[0]?.etag).toBe("new");
    expect(verified.rewrite).toBe(true);
    const diverged = planArchiveCapture(
      "cap",
      listed,
      receipt,
      new Map([["provenance.json", head(11)]]),
      NOW,
    );
    expect(diverged.uploads).toEqual(["provenance.json"]);
  });

  test("ghost entries are reported but do not force a rewrite on their own", () => {
    const listed = [file("a.m4a", 100)];
    const receipt = receiptOf("cap", [
      { name: "a.m4a", size: 100, etag: "e1", uploadedAt: "2026-10-01T00:00:00.000Z" },
      { name: "gone.json", size: 5, etag: "e9", uploadedAt: "2026-10-01T00:00:00.000Z" },
    ]);
    const plan = planArchiveCapture("cap", listed, receipt, new Map(), NOW);
    expect(plan.ghosts).toEqual(["gone.json"]);
    expect(plan.rewrite).toBe(false);
    expect(plan.entries).toHaveLength(1);
  });
});

describe("receipt shapes", () => {
  test("keys and content types match the server's", () => {
    expect(archiveReceiptKey("abc")).toBe("archive/archive-v1/abc.json");
    expect(archiveContentTypeFor("x.m4a")).toBe("audio/mp4");
    expect(archiveContentTypeFor("x.json")).toBe("application/json");
    expect(archiveContentTypeFor("x.ndjson")).toBeUndefined();
  });

  test("the stored JSON round-trips and keeps the server's field order", () => {
    const receipt = receiptOf("cap", [
      { name: "a.m4a", size: 100, etag: "e1", uploadedAt: "2026-10-01T00:00:00.000Z" },
    ]);
    const json = archiveReceiptJson(receipt);
    expect(json.startsWith('{\n  "captureId": "cap",\n  "files": [\n    {\n      "name": "a.m4a",')).toBe(true);
    expect(parseArchiveReceipt(JSON.parse(json))).toEqual(receipt);
  });

  test("malformed receipts do not decode", () => {
    expect(parseArchiveReceipt(null)).toBeNull();
    expect(parseArchiveReceipt({ captureId: "x" })).toBeNull();
    expect(
      parseArchiveReceipt({
        captureId: "x",
        files: [{ name: "a", size: "1", etag: null, uploadedAt: "t" }],
      }),
    ).toBeNull();
    expect(
      parseArchiveReceipt({
        captureId: "x",
        files: [{ name: "a", size: 1, etag: 5, uploadedAt: "t" }],
      }),
    ).toBeNull();
  });
});
