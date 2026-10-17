import { describe, expect, test } from "bun:test"
import { type LifelogDayTranscript, type LifelogStar, makeLifelogMcpClient } from "./Mcp.ts"

const journal = (day: string, report = "Walked by the bay.\n\n## 9:00–10:00 — Outside\nWalked.") => ({
  version: "journal-v12",
  day,
  inputHash: "hash",
  transcriptKeys: [],
  model: null,
  generatedAt: "2026-01-01T12:00:00Z",
  status: "completed",
  report
})

describe("lifelog MCP client", () => {
  test("lists the latest 30 civil days in the configured lifelog zone", async () => {
    const requested: string[] = []
    const client = makeLifelogMcpClient({
      baseUrl: "http://lifelog.test:8000/ignored-path",
      timeZone: "America/Los_Angeles",
      now: () => new Date("2026-01-01T01:00:00Z"),
      fetch: async (input) => {
        requested.push(new URL(input.toString()).pathname)
        return Response.json(journal("2025-12-31"))
      }
    })

    const days = await client.listRecentDays()

    expect(days).toHaveLength(30)
    expect(days[0]).toEqual({ day: "2025-12-31", status: "available", summary: "Walked by the bay." })
    expect(days[29]?.day).toBe("2025-12-02")
    expect(requested).toHaveLength(30)
    expect(requested.slice(0, 2)).toEqual(["/journal/020251231", "/journal/020251230"])
  })

  test("distinguishes missing and pending days without treating them as errors", async () => {
    const client = makeLifelogMcpClient({
      baseUrl: "http://lifelog.test",
      fetch: async (input) => {
        const path = new URL(input.toString()).pathname
        if (path.endsWith("20260902")) return Response.json({ status: "pending" }, { status: 202 })
        return new Response("not found", { status: 404 })
      }
    })

    expect(await client.getDaySummary("2026-09-02")).toBeNull()
    expect(await client.getDaySummary("2026-09-01")).toBeNull()
  })

  test("returns a complete report for a completed day", async () => {
    const client = makeLifelogMcpClient({
      baseUrl: "http://lifelog.test",
      fetch: async () => Response.json(journal("2026-09-01", "A focused day.\n\n## Home\nWorked."))
    })

    await expect(client.getDaySummary("2026-09-01")).resolves.toEqual({
      day: "2026-09-01",
      generatedAt: "2026-01-01T12:00:00Z",
      report: "A focused day.\n\n## Home\nWorked."
    })
  })

  test("lists a day's stars and reads one star by id", async () => {
    const star: LifelogStar = {
      id: "abc",
      startUtc: "2026-09-01T17:55:00.000Z",
      endUtc: "2026-09-01T18:00:00.000Z",
      name: "vet call",
      note: null,
      visibility: "private",
      retentionSeconds: 3600,
      createdAt: "2026-09-01T18:00:05.000Z",
      createdVia: "voice"
    }
    const requested: string[] = []
    const client = makeLifelogMcpClient({
      baseUrl: "http://lifelog.test",
      fetch: async (input) => {
        const path = new URL(input.toString()).pathname
        requested.push(path)
        if (path === "/stars/020260901") return Response.json([star])
        if (path === "/star/abc") return Response.json(star)
        return new Response("not found", { status: 404 })
      }
    })

    await expect(client.listStars("2026-09-01")).resolves.toEqual([star])
    await expect(client.getStar("abc")).resolves.toEqual(star)
    await expect(client.listStars("2026-09-02")).resolves.toEqual([])
    await expect(client.getStar("gone")).resolves.toBeNull()
    expect(requested).toEqual(["/stars/020260901", "/star/abc", "/stars/020260902", "/star/gone"])
  })

  test("reads a day's transcripts through the GetDayTranscripts RPC", async () => {
    const recordings: LifelogDayTranscript[] = [{
      captureId: "capture-1",
      startTime: "2026-09-01T16:00:00",
      timeZone: "America/Los_Angeles",
      turns: [
        { speaker: null, startMs: 0, endMs: 2400, text: "star the last 5 minutes" },
        { speaker: "speaker_B", startMs: 3000, endMs: 5100, text: "did it file?" }
      ]
    }]
    const sent: Array<{ path: string; body: unknown }> = []
    const client = makeLifelogMcpClient({
      baseUrl: "http://lifelog.test",
      fetch: async (input, init) => {
        const path = new URL(input.toString()).pathname
        const line = String(init?.body ?? "").trim()
        const message = line ? JSON.parse(line) as { _tag: string; id: number; tag: string; payload: { day: string } } : null
        sent.push({ path, body: message })
        if (path !== "/rpc" || message?.tag !== "GetDayTranscripts") {
          return new Response("not found", { status: 404 })
        }
        if (message.payload.day === "2026-09-03") {
          const failure = {
            _tag: "Exit",
            requestId: message.id,
            exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { message: "no such day" } }] }
          }
          return new Response(`${JSON.stringify(failure)}\n`, { headers: { "content-type": "application/ndjson" } })
        }
        const success = { _tag: "Exit", requestId: message.id, exit: { _tag: "Success", value: recordings } }
        return new Response(`${JSON.stringify(success)}\n`, { headers: { "content-type": "application/ndjson" } })
      }
    })

    await expect(client.getDayTranscripts("2026-09-01")).resolves.toEqual(recordings)
    expect(sent).toEqual([{
      path: "/rpc",
      body: { _tag: "Request", id: 0, tag: "GetDayTranscripts", payload: { day: "2026-09-01" }, headers: [] }
    }])
    await expect(client.getDayTranscripts("2026-09-03")).rejects.toThrow("no such day")
    await expect(client.getDayTranscripts("09/01/2026")).rejects.toThrow("day must be YYYY-MM-DD")
  })
})
