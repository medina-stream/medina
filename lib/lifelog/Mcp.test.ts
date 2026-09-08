import { describe, expect, test } from "bun:test"
import { makeLifelogMcpClient } from "./Mcp.ts"

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
})
