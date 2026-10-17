#!/usr/bin/env bun
/**
 * Read-only MCP bridge for a running Medina lifelog.
 *
 * Stdout is reserved for JSON-RPC; diagnostics must remain on stderr.
 */
import { McpServer } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { z } from "zod"
import { makeLifelogMcpClient } from "../lib/lifelog/Mcp.ts"

const client = makeLifelogMcpClient()
const server = new McpServer({ name: "medina-lifelog", version: "0.1.0" })

server.registerTool(
  "list_recent_days",
  {
    title: "List recent lifelog days",
    description: "List the last 30 civil days in the lifelog, newest first. Each available day includes its one-line journal summary; missing or still-pending days are identified explicitly.",
    inputSchema: z.object({})
  },
  async () => {
    const days = await client.listRecentDays()
    return {
      content: [{ type: "text", text: JSON.stringify(days, null, 2) }],
      structuredContent: { days }
    }
  }
)

server.registerTool(
  "get_day_summary",
  {
    title: "Get a day's lifelog summary",
    description: "Get the complete generated daily journal report for one civil day. The report begins with the short summary, followed by a concise chronology.",
    inputSchema: z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")
        .describe("Civil day in the lifelog's configured time zone, for example 2026-09-08")
    })
  },
  async ({ day }) => {
    const summary = await client.getDaySummary(day)
    if (summary === null) {
      return {
        content: [{ type: "text", text: `No completed journal is available for ${day} yet.` }],
        structuredContent: { day, status: "unavailable" }
      }
    }
    return {
      content: [{ type: "text", text: summary.report }],
      structuredContent: summary
    }
  }
)

server.registerTool(
  "list_stars",
  {
    title: "List a day's stars",
    description: "List the authored stars (named time intervals) overlapping one civil day in the lifelog's configured time zone, oldest first. Stars are ephemeral by default — an absent star may have expired, not never existed.",
    inputSchema: z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")
        .describe("Civil day in the lifelog's configured time zone, for example 2026-09-08")
    })
  },
  async ({ day }) => {
    const stars = await client.listStars(day)
    return {
      content: [{ type: "text", text: JSON.stringify(stars, null, 2) }],
      structuredContent: { stars }
    }
  }
)

server.registerTool(
  "get_star",
  {
    title: "Get one star",
    description: "Get one authored star by id: its interval, name, note, visibility and retention. Returns an unavailable status when no such star exists (any more).",
    inputSchema: z.object({
      id: z.string().describe("The star's id, as returned by list_stars")
    })
  },
  async ({ id }) => {
    const star = await client.getStar(id)
    if (star === null) {
      return {
        content: [{ type: "text", text: `No star ${id} is available.` }],
        structuredContent: { id, status: "unavailable" }
      }
    }
    return {
      content: [{ type: "text", text: JSON.stringify(star, null, 2) }],
      structuredContent: star
    }
  }
)

await server.connect(new StdioServerTransport())
