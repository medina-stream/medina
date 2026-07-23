import { getServerUrl } from "./settings";

export type ServerEvent = {
  id: string;
  createdAt: string;
  data: Record<string, unknown>;
};

type Listener = (event: ServerEvent) => void;

const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let connectGeneration = 0;

function getEventsWsUrl(): string {
  const serverUrl = getServerUrl();
  return serverUrl.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://") + "/events";
}

function connect(generation = connectGeneration) {
  if (generation !== connectGeneration || listeners.size === 0) {
    return;
  }

  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }

  const url = getEventsWsUrl();
  console.log("[events] connecting to", url);
  socket = new WebSocket(url);

  socket.onopen = () => {
    console.log("[events] connected");
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  socket.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data as string) as ServerEvent;
      console.log("[events] received:", event.data?.type, event);
      for (const listener of listeners) {
        listener(event);
      }
    } catch {
      // ignore malformed messages
    }
  };

  socket.onerror = (e) => {
    console.warn("[events] error", e);
  };

  socket.onclose = () => {
    if (socket) {
      socket = null;
    }
    if (generation !== connectGeneration || listeners.size === 0) {
      return;
    }

    console.log("[events] disconnected, reconnecting in 3s");
    reconnectTimer = setTimeout(() => connect(generation), 3000);
  };
}

function disconnect() {
  connectGeneration += 1;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
}

export function subscribeEvents(listener: Listener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    connectGeneration += 1;
    connect();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) disconnect();
  };
}
