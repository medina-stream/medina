import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const webSocketMock = mock();

const { createMedinaClient } = await import("./sdk");

describe("Medina SDK ingest helpers", () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    webSocketMock.mockClear();
    globalThis.WebSocket = webSocketMock as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  });

  test("connectEvents opens a websocket to /events", () => {
    const client = createMedinaClient({ baseUrl: "https://medina.example/app", token: "secret" });

    client.connectEvents();

    expect(webSocketMock).toHaveBeenCalledWith("wss://medina.example/events?token=secret");
  });

  test("createIngestDestination posts standard metadata plus caller pairs", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({
      action: "http://localhost:3000/in",
      headers: {
        "Content-Type": "audio/m4a",
        "x-amz-meta-created-at": "2026-04-06T12:00:00.000Z",
        "x-amz-meta-original-filename": "clip.m4a",
        "x-amz-meta-sdk-version": "medina-sdk/0.1.0",
        "x-medina-ingest-key": "in/test-key",
      },
      key: "in/test-key",
      metadata: {
        "created-at": "2026-04-06T12:00:00.000Z",
        "original-filename": "clip.m4a",
        "sdk-version": "medina-sdk/0.1.0",
        source: "sdk-test",
      },
      method: "POST",
    }), {
      headers: { "content-type": "application/json; charset=utf-8" },
      status: 200,
    }));
    globalThis.fetch = fetchMock as typeof fetch;

    const client = createMedinaClient("http://localhost:3000");
    const destination = await client.createIngestDestination({
      createdAt: "2026-04-06T12:00:00.000Z",
      fileName: "clip.m4a",
      metadata: {
        source: "sdk-test",
      },
      type: "audio/m4a",
    });

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:3000/in", {
      body: JSON.stringify({
        metadata: {
          "created-at": "2026-04-06T12:00:00.000Z",
          "original-filename": "clip.m4a",
          "sdk-version": "medina-sdk/0.1.0",
          source: "sdk-test",
        },
        type: "audio/m4a",
      }),
      headers: expect.any(Headers),
      method: "POST",
    });
    const initHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(initHeaders.get("content-type")).toBe("application/json");
    expect(destination.metadata).toEqual({
      "created-at": "2026-04-06T12:00:00.000Z",
      "original-filename": "clip.m4a",
      "sdk-version": "medina-sdk/0.1.0",
      source: "sdk-test",
    });
    expect(destination.key).toBe("in/test-key");
  });

  test("uploadIngest uses the returned upload endpoint as-is", async () => {
    const fetchMock = mock()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        action: "http://localhost:3000/in",
        headers: {
          "Content-Type": "audio/m4a",
          "x-amz-meta-created-at": "2026-04-06T12:00:00.000Z",
          "x-amz-meta-original-filename": "clip.m4a",
          "x-amz-meta-sdk-version": "medina-sdk/0.1.0",
          "x-amz-meta-device-name": "Pixel 8",
          "x-medina-ingest-key": "in/test-key",
        },
        key: "in/test-key",
        metadata: {
          "created-at": "2026-04-06T12:00:00.000Z",
          "original-filename": "clip.m4a",
          "sdk-version": "medina-sdk/0.1.0",
          "device-name": "Pixel 8",
        },
        method: "POST",
      }), {
        headers: { "content-type": "application/json; charset=utf-8" },
        status: 200,
      }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const client = createMedinaClient("http://localhost:3000");
    const result = await client.uploadIngest({
      body: new Blob(["audio"], { type: "audio/m4a" }),
      createdAt: "2026-04-06T12:00:00.000Z",
      fileName: "clip.m4a",
      metadata: {
        deviceName: "Pixel 8",
      },
      type: "audio/m4a",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://localhost:3000/in", {
      body: JSON.stringify({
        metadata: {
          "created-at": "2026-04-06T12:00:00.000Z",
          "original-filename": "clip.m4a",
          "sdk-version": "medina-sdk/0.1.0",
          "device-name": "Pixel 8",
        },
        type: "audio/m4a",
      }),
      headers: expect.any(Headers),
      method: "POST",
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:3000/in", {
      body: expect.any(Blob),
      headers: expect.any(Headers),
      method: "POST",
    });
    const uploadHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Headers;
    expect(uploadHeaders.get("Content-Type")).toBe("audio/m4a");
    expect(uploadHeaders.get("x-amz-meta-device-name")).toBe("Pixel 8");
    expect(uploadHeaders.get("x-medina-ingest-key")).toBe("in/test-key");
    expect(result).toEqual({
      ingestId: "test-key",
      key: "in/test-key",
      metadata: {
        "created-at": "2026-04-06T12:00:00.000Z",
        "original-filename": "clip.m4a",
        "sdk-version": "medina-sdk/0.1.0",
        "device-name": "Pixel 8",
      },
    });
  });

  test("uploadIngest requires a file name when the body is not a File", async () => {
    const client = createMedinaClient("http://localhost:3000");

    await expect(client.uploadIngest({
      body: new Blob(["audio"], { type: "audio/m4a" }),
      type: "audio/m4a",
    })).rejects.toThrow("Missing fileName for ingest metadata.");
  });
  test("request adds token auth and humane JSON helpers reflect API routes", async () => {
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://medina.example/recordings.json");
      const headers = init?.headers as Headers;
      expect(headers.get("Authorization")).toBe("Bearer secret");
      expect(headers.get("accept")).toBe("application/json");
      return new Response(JSON.stringify([{ id: "recording-1" }]), {
        headers: { "content-type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = createMedinaClient({ baseUrl: "https://medina.example", token: "secret" });
    expect(await client.getRecordings()).toEqual([{ id: "recording-1" }]);
  });

  test("request can combine token and Tailscale auth headers", async () => {
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Headers;
      expect(headers.get("Authorization")).toBe("Bearer secret");
      expect(headers.get("Tailscale-User-Login")).toBe("owner@example.com");
      return new Response(JSON.stringify([]), {
        headers: { "content-type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = createMedinaClient({
      baseUrl: "https://medina.example",
      tailscaleLogin: "owner@example.com",
      token: "secret",
    });
    await client.getRecordings();
  });

  test("uploadIngest can notify the server after upload", async () => {
    const fetchMock = mock()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        action: "https://medina.example/in/test-key",
        headers: { "Content-Type": "audio/m4a" },
        ingestId: "test-key",
        key: "in/test-key",
        metadata: {
          "created-at": "2026-04-06T12:00:00.000Z",
          "original-filename": "clip.m4a",
          "sdk-version": "medina-sdk/0.1.0",
        },
        method: "PUT",
      }), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, eventId: "event-1" }), {
        headers: { "content-type": "application/json" },
      }));
    globalThis.fetch = fetchMock as typeof fetch;

    const client = createMedinaClient({ baseUrl: "https://medina.example", token: "secret" });
    await client.uploadIngest({
      body: new Blob(["audio"], { type: "audio/m4a" }),
      createdAt: "2026-04-06T12:00:00.000Z",
      fileName: "clip.m4a",
      notify: true,
      type: "audio/m4a",
    });

    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://medina.example/events");
    const notifyInit = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(JSON.parse(notifyInit.body as string)).toMatchObject({
      type: "ingest-uploaded",
      ingestId: "test-key",
      ingestKey: "in/test-key",
      filename: "clip.m4a",
    });
  });

});
