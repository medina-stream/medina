import { type EventRecord } from "#lib/event";

const EVENTS_TOPIC = "events";

function isWebSocketUpgradeRequest(req: Request) {
  return req.headers.get("upgrade")?.toLowerCase() === "websocket";
}

export async function handleEventsRequest(
  req: Request,
  server: Pick<Bun.Server, "upgrade">,
): Promise<Response | undefined> {
  if (isWebSocketUpgradeRequest(req)) {
    const success = server.upgrade(req);
    return success ? undefined : Response.json({ error: "WebSocket upgrade error" }, { status: 400 });
  }

  return new Response("Upgrade Required", {
    status: 426,
    headers: {
      connection: "Upgrade",
      upgrade: "websocket",
    },
  });
}

export function publishEventToWebSocketClients(
  server: Pick<Bun.Server, "publish">,
  event: EventRecord,
) {
  server.publish(EVENTS_TOPIC, JSON.stringify(event));
}

export const eventsWebSocket = {
  open(ws: Bun.ServerWebSocket<unknown>) {
    ws.subscribe(EVENTS_TOPIC);
  },
  message() {
    // This socket is server-push only for now.
  },
  close(ws: Bun.ServerWebSocket<unknown>) {
    ws.unsubscribe(EVENTS_TOPIC);
  },
};
