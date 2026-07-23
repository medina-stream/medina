import { serve } from "bun";
import api, { streams } from "./api";
import { subscribeToEvents } from "#lib/event";
import { eventsWebSocket, handleEventsRequest, publishEventToWebSocketClients } from "./events";
import { createBunAppUiHandlers } from "./adapters/bun/app-ui";
import { serveCliBundle } from "./adapters/bun/cli";
import { serveSdkBundle } from "./adapters/bun/sdk";
import { validateStreamsOnStartup } from "./bucket-health";
import { serveStaticAsset } from "./static-assets";
import { serveHomePage } from "./home-page";

const isProduction = process.env.NODE_ENV === "production";
const hostname = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? "3001");
const { serveApp, serveExpoAsset } = createBunAppUiHandlers({ isProduction });

await validateStreamsOnStartup(streams);

let websocketServer: Bun.Server<unknown> | null = null;
const unsubscribeFromEvents = subscribeToEvents((event) => {
  if (!websocketServer) {
    return;
  }

  publishEventToWebSocketClients(websocketServer, event);
});

const server = serve({
  hostname,
  port,
  idleTimeout: Number(process.env.HTTP_IDLE_TIMEOUT_SECONDS ?? 120),
  maxRequestBodySize: Number(process.env.MAX_REQUEST_BODY_SIZE ?? 2 * 1024 * 1024 * 1024),
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/events" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return handleEventsRequest(req, server);
    }

    const response = await api.fetch(req);
    if (response.status !== 404) return response;
    return (await serveStaticAsset(url.pathname)) ?? response;
  },
  websocket: eventsWebSocket,
  routes: {
    "/": (req) => serveHomePage(req),
    "/app": (req) => serveApp(req),
    "/app/": (req) => serveApp(req),
    "/app/*": (req) => serveApp(req),
    "/_expo/*": (req) => serveExpoAsset(req),
    "/.expo/*": (req) => serveExpoAsset(req),
    "/assets/*": (req) => serveExpoAsset(req),
    "/API.md": () => new Response(null, { status: 301, headers: { location: "/api.md" } }),
    "/sdk.js": () => serveSdkBundle(),
    "/sdk.d.ts": () => new Response(Bun.file("./server/sdk.d.ts"), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
    "/sdk.ts": () => new Response(Bun.file("./server/sdk.ts"), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
    "/medina-cli.ts": () => serveCliBundle(),
  },

  development: !isProduction && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

websocketServer = server;

process.on("exit", () => {
  unsubscribeFromEvents();
});

console.log(`🚀 Server running at ${server.url}`);
