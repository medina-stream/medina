import { dayId, parseDayId } from "./DayLabels.ts"

/** A fetch implementation, injected for deterministic tests. */
export type LifelogFetch = (input: URL, init?: RequestInit) => Promise<Response>

export interface LifelogMcpClientOptions {
  /** Medina's HTTP origin; defaults to the local server. */
  readonly baseUrl?: string
  /** Civil-day zone used to decide which 30 days are recent. */
  readonly timeZone?: string
  readonly fetch?: LifelogFetch
  readonly now?: () => Date
}

export interface LifelogDaySummary {
  readonly day: string
  readonly status: "available" | "pending" | "missing"
  readonly summary: string | null
}

export interface LifelogDayReport {
  readonly day: string
  readonly generatedAt: string
  readonly report: string
}

type JournalResponse = {
  readonly day: string
  readonly generatedAt: string
  readonly report: string
}

const defaultBaseUrl = () => `http://127.0.0.1:${process.env.PORT ?? "8000"}`

const configuredUrl = (value: string): URL => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`LIFELOG_URL must be an absolute URL, got ${JSON.stringify(value)}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("LIFELOG_URL must use http or https")
  }
  return url
}

const validateTimeZone = (timeZone: string) => {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone }).format()
  } catch {
    throw new Error(`invalid lifelog time zone: ${timeZone}`)
  }
}

const civilToday = (now: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now)
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value
  return `${part("year")}-${part("month")}-${part("day")}`
}

const priorDay = (day: string, offset: number): string => {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - offset)
  return date.toISOString().slice(0, 10)
}

const summaryFromReport = (report: string): string | null => {
  const summary = report.split("\n").find((line) => line.trim())?.trim()
  return summary || null
}

/**
 * Read-only client behind the MCP tools. It deliberately uses Medina's
 * cached HTTP journal endpoint, so asking an agent about a day never invokes
 * an LLM or starts pipeline work.
 */
export const makeLifelogMcpClient = (options: LifelogMcpClientOptions = {}) => {
  const origin = configuredUrl(options.baseUrl ?? process.env.LIFELOG_URL ?? defaultBaseUrl())
  const timeZone = options.timeZone ?? process.env.LIFELOG_TIME_ZONE ?? process.env.HOME_TZ ?? "UTC"
  validateTimeZone(timeZone)
  const request = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())

  const get = async (day: string): Promise<Response> => {
    const parsed = parseDayId(day)
    if (parsed === null) throw new Error("day must be YYYY-MM-DD")
    const url = new URL(`/journal/${dayId(parsed)}`, origin)
    let response: Response
    try {
      response = await request(url)
    } catch (error) {
      throw new Error(`could not reach lifelog at ${origin.origin}: ${String(error)}`)
    }
    if (!response.ok && response.status !== 202 && response.status !== 404) {
      const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 240)
      throw new Error(`lifelog returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`)
    }
    return response
  }

  return {
    async listRecentDays(): Promise<readonly LifelogDaySummary[]> {
      const today = civilToday(now(), timeZone)
      return Promise.all(Array.from({ length: 30 }, async (_, offset) => {
        const day = priorDay(today, offset)
        const response = await get(day)
        if (response.status === 202) return { day, status: "pending", summary: null }
        if (response.status === 404) return { day, status: "missing", summary: null }
        const journal = await response.json() as JournalResponse
        return { day, status: "available", summary: summaryFromReport(journal.report) }
      }))
    },

    async getDaySummary(day: string): Promise<LifelogDayReport | null> {
      const response = await get(day)
      if (response.status === 202 || response.status === 404) return null
      const journal = await response.json() as JournalResponse
      return { day: journal.day, generatedAt: journal.generatedAt, report: journal.report }
    }
  }
}
