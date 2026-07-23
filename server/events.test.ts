import { describe, expect, mock, test } from "bun:test";

const upgradeMock = mock(() => true);
const publishMock = mock();

const { eventsWebSocket, handleEventsRequest, publishEventToWebSocketClients } = await import("./events");

describe("events websocket transport", () => {
  test("upgrades websocket requests on /events", async () => {
    const req = new Request("http://localhost:3000/events", {
      headers: {
        upgrade: "websocket",
      },
    });

    const response = await handleEventsRequest(req, {
      upgrade: upgradeMock,
    } as unknown as Pick<Bun.Server, "upgrade">);

    expect(upgradeMock).toHaveBeenCalled();
    expect(response).toBeUndefined();
  });

  test("rejects non-websocket requests to /events", async () => {
    const req = new Request("http://localhost:3000/events");

    const response = await handleEventsRequest(req, {
      upgrade: upgradeMock,
    } as unknown as Pick<Bun.Server, "upgrade">);

    expect(response?.status).toBe(426);
    expect(response?.headers.get("upgrade")).toBe("websocket");
  });

  test("publishes serialized events to subscribed clients", () => {
    publishEventToWebSocketClients({
      publish: publishMock,
    } as unknown as Pick<Bun.Server, "publish">, {
      id: "evt-1",
      createdAt: "2026-04-07T00:00:00.000Z",
      data: {
        type: "test",
      },
    });

    expect(publishMock).toHaveBeenCalledWith("events", JSON.stringify({
      id: "evt-1",
      createdAt: "2026-04-07T00:00:00.000Z",
      data: {
        type: "test",
      },
    }));
  });

  test("websocket lifecycle subscribes and unsubscribes from the events topic", () => {
    const subscribe = mock();
    const unsubscribe = mock();
    const ws = {
      subscribe,
      unsubscribe,
    } as unknown as Bun.ServerWebSocket<unknown>;

    eventsWebSocket.open(ws);
    eventsWebSocket.close(ws);

    expect(subscribe).toHaveBeenCalledWith("events");
    expect(unsubscribe).toHaveBeenCalledWith("events");
  });
});
