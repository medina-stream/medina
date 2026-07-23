import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEventStore } from "./event";
mock.restore();

const dataDir = mkdtempSync(join(tmpdir(), "medina-event-test-"));
const db = new Database(join(dataDir, "medina.db"), { create: true });
const { createEvent, getEvents, subscribeToEvents } = createEventStore({
  channelName: `medina.events.${Date.now()}`,
  db,
});

describe("event store", () => {
  beforeEach(() => {
    db.exec("DELETE FROM events");
  });

  test("createEvent persists JSON payloads and returns recent events first", () => {
    const first = createEvent({
      type: "first",
      source: "test",
    });
    const second = createEvent({
      type: "second",
      nested: {
        ok: true,
      },
    });

    const events = getEvents();

    expect(events[0]).toEqual(second);
    expect(events[1]).toEqual(first);
    expect(events[0]?.data).toEqual({
      type: "second",
      nested: {
        ok: true,
      },
    });
  });

  test("subscribeToEvents receives created events over BroadcastChannel", async () => {
    const received = new Promise<unknown>((resolve) => {
      const unsubscribe = subscribeToEvents((event) => {
        unsubscribe();
        resolve(event);
      });
    });

    const created = createEvent({
      type: "broadcast-test",
    });

    expect(await received).toEqual(created);
  });
});
