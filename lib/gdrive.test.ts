import { describe, expect, test } from "bun:test";
import { createMemoryBucket } from "./bucket.test";
import {
  buildAuthorizationUrl,
  consumePendingState,
  createPendingState,
  exportTargetForFile,
  isGoogleNativeDocument,
  type DriveFile,
} from "./gdrive";

describe("gdrive OAuth state", () => {
  test("createPendingState then consumePendingState returns the payload", async () => {
    const bucket = createMemoryBucket();
    const state = await createPendingState(bucket, { folderId: "folder-1" });
    expect(await consumePendingState(bucket, state)).toEqual({ folderId: "folder-1" });
  });

  test("consumePendingState rejects a mismatched state", async () => {
    const bucket = createMemoryBucket();
    await createPendingState(bucket);
    expect(await consumePendingState(bucket, "wrong")).toBe(null);
  });

  test("consumePendingState is single-use", async () => {
    const bucket = createMemoryBucket();
    const state = await createPendingState(bucket, { sourceId: "src-1" });
    expect(await consumePendingState(bucket, state)).toEqual({ sourceId: "src-1" });
    expect(await consumePendingState(bucket, state)).toBe(null);
  });

  test("buildAuthorizationUrl includes the redirect uri, scopes, and offline access", () => {
    const url = buildAuthorizationUrl("https://medina.example/connect/google/callback", {
      GOOGLE_CLIENT_ID: "client-123",
      GOOGLE_CLIENT_SECRET: "secret",
    });
    expect(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
    expect(url).toContain("client_id=client-123");
    expect(url).toContain("redirect_uri=https%3A%2F%2Fmedina.example%2Fconnect%2Fgoogle%2Fcallback");
    expect(url).toContain("access_type=offline");
    expect(url).toContain("prompt=consent");
    expect(url).toContain("scope=openid+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.readonly");
  });

  test("buildAuthorizationUrl throws when client credentials are missing", () => {
    expect(() => buildAuthorizationUrl("https://x/cb", {})).toThrow("GOOGLE_CLIENT_ID");
  });
});

describe("gdrive native document export", () => {
  test("isGoogleNativeDocument identifies google-apps mime types", () => {
    expect(isGoogleNativeDocument("application/vnd.google-apps.document")).toBe(true);
    expect(isGoogleNativeDocument("application/vnd.google-apps.spreadsheet")).toBe(true);
    expect(isGoogleNativeDocument("audio/mp4")).toBe(false);
  });

  test("exportTargetForFile appends the right extension", () => {
    const file: DriveFile = { id: "1", name: "Doc", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-01-01T00:00:00.000Z" };
    expect(exportTargetForFile(file)).toEqual({
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "Doc.docx",
    });
  });

  test("exportTargetForFile does not double-append an existing extension", () => {
    const file: DriveFile = { id: "1", name: "Doc.docx", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-01-01T00:00:00.000Z" };
    expect(exportTargetForFile(file)?.filename).toBe("Doc.docx");
  });

  test("exportTargetForFile returns null for non-native files", () => {
    const file: DriveFile = { id: "1", name: "a.m4a", mimeType: "audio/mp4", modifiedTime: "2026-01-01T00:00:00.000Z" };
    expect(exportTargetForFile(file)).toBeNull();
  });
});
