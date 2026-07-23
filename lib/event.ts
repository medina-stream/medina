import { db } from "#lib/db";
import type { Database } from "bun:sqlite";

export type EventData = Record<string, unknown>;

export type EventRecord = {
  id: string;
  createdAt: string;
  data: EventData;
};

type EventRow = {
  key: string;
  created_at: string;
  data: string;
};

const EVENT_CHANNEL_NAME = "medina.events";
const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 500;

type EventStoreDependencies = {
  channelName?: string;
  db: Pick<Database, "exec" | "query">;
};

function clampEventLimit(limit?: number) {
  if (!Number.isFinite(limit)) {
    return DEFAULT_EVENT_LIMIT;
  }

  return Math.max(1, Math.min(MAX_EVENT_LIMIT, Math.trunc(limit ?? DEFAULT_EVENT_LIMIT)));
}

function parseEventData(value: unknown): EventData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Events must be JSON objects.");
  }

  return value as EventData;
}

function toEventRecord(row: EventRow): EventRecord {
  return {
    id: row.key,
    createdAt: row.created_at,
    data: parseEventData(JSON.parse(row.data) as unknown),
  };
}

function isEventRecord(value: unknown): value is EventRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<EventRecord>;
  return (
    typeof candidate.id === "string"
    && typeof candidate.createdAt === "string"
    && !!candidate.data
    && typeof candidate.data === "object"
    && !Array.isArray(candidate.data)
  );
}

export function createEventStore(dependencies: EventStoreDependencies) {
  const channelName = dependencies.channelName ?? EVENT_CHANNEL_NAME;
  const broadcastChannel = new BroadcastChannel(channelName);

  dependencies.db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      key TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}'
    );
  `);
  dependencies.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_created_at
    ON events(created_at);
  `);

  const insertEventStatement = dependencies.db.query<never, [string, string, string]>(
    "INSERT INTO events (key, created_at, data) VALUES (?1, ?2, ?3)",
  );

  function createEvent(data: EventData): EventRecord {
    const event: EventRecord = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      data: parseEventData(data),
    };

    insertEventStatement.run(event.id, event.createdAt, JSON.stringify(event.data));
    broadcastChannel.postMessage(event);

    return event;
  }

  function getEvents(limit?: number): EventRecord[] {
    const statement = dependencies.db.query<EventRow, [number]>(`
      SELECT key, created_at, data
      FROM events
      ORDER BY created_at DESC
      LIMIT ?1
    `);

    return statement.all(clampEventLimit(limit)).map(toEventRecord);
  }

  function subscribeToEvents(listener: (event: EventRecord) => void) {
    const channel = new BroadcastChannel(channelName);

    const onMessage = (message: MessageEvent<unknown>) => {
      if (isEventRecord(message.data)) {
        listener(message.data);
      }
    };

    channel.addEventListener("message", onMessage);

    return () => {
      channel.removeEventListener("message", onMessage);
      channel.close();
    };
  }

  return {
    createEvent,
    getEvents,
    subscribeToEvents,
  };
}

const eventStore = createEventStore({ db });

export const createEvent = eventStore.createEvent;
export const getEvents = eventStore.getEvents;
export const subscribeToEvents = eventStore.subscribeToEvents;
