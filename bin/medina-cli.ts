#!/usr/bin/env bun

// Medina CLI.
//
// Uses the Medina SDK for HTTP behavior, then adds Unix-friendly parsing,
// output formatting, capture helpers, and process integration.
//
// Design contract:
//   - stdout is data only. Status, HTTP lines, progress, errors → stderr.
//   - List output is line-oriented TSV when possible.
//   - URLs are the first column. They are semantic Medina paths like /020260521.
//   - Times use ISO 8601 / Temporal-friendly intervals (e.g. 2026-05-21T00:00:00Z/P1D).
//   - For structured JSON, fetch the corresponding .json URL with curl.
//
// Exit codes:
//   0  success (including empty results)
//   1  operational/server error
//   2  CLI usage error
//   3  auth / permission denied
//   4  not found

import { unlink } from "node:fs/promises";
import path from "node:path";
import { createMedinaClient } from "../server/sdk";

type CaptureCommand = { args: string[]; cmd: string };

const EXIT_OK = 0;
const EXIT_ERR = 1;
const EXIT_USAGE = 2;
const EXIT_AUTH = 3;
const EXIT_NOT_FOUND = 4;

function die(code: number, message?: string): never {
  if (message) process.stderr.write(`${message}\n`);
  process.exit(code);
}

function usage() {
  process.stderr.write(`medina — personal context CLI

Usage:
  medina                                         GET /status.json
  medina status
  medina days [<spec>]                           TSV: url\tinterval\tduration\tsummary
  medina intervals [<spec>]                      alias for: days
  medina day [<spec>]                            fetch one day as JSON
  medina latest                                  most recent day as TSV
  medina show <url>                              markdown view of an interval
  medina open <url>                              open the URL in a browser
  medina in [--wait] <file> [<file>...]          ingest one or more files
  medina capture                                 record audio and ingest

Generic HTTP:
  medina get <path|url> [--query k=v]...
  medina post <path|url> [--json <json>|--data <s>|--file <path>]
  medina put <path|url> [--json <json>|--data <s>|--file <path>]
  medina delete <path|url>
  medina req <METHOD> <path|url> [body flags] [--header k:v]... [--query k=v]...

Specs accepted by days / day / intervals / show / open:
  today | yesterday
  N | -N | Nd                       N days ago
  YYYY-MM-DD                        specific date
  YYYYMMDD | YYYYYMMDD              day id (5-digit year is canonical)
  P30D | P7D | P1D                  ISO 8601 duration (used by days/intervals)

Global flags (any position):
  -u, --base <url>          Override base URL (else MEDINA_ROOT, then localhost)
      --token <token>       Bearer token (else MEDINA_TOKEN)
      --login <email>       Inject Tailscale-User-Login header
  -q, --quiet               Suppress the HTTP status line on stderr
      --header              Repeated columns header on list output

For structured JSON, fetch the corresponding .json URL directly:
  curl "$MEDINA_ROOT/020260521.json"
`);
}

// ---------- global option parsing ----------

type GlobalOptions = {
  baseUrl?: string;
  login?: string;
  quiet: boolean;
  showHeader: boolean;
  token?: string;
};

function extractGlobals(argv: string[]): { rest: string[]; opts: GlobalOptions } {
  const opts: GlobalOptions = { quiet: false, showHeader: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-u" || a === "--base" || a === "--base-url") { opts.baseUrl = argv[++i]; continue; }
    if (a.startsWith("--base=")) { opts.baseUrl = a.slice("--base=".length); continue; }
    if (a === "--login") { opts.login = argv[++i]; continue; }
    if (a.startsWith("--login=")) { opts.login = a.slice("--login=".length); continue; }
    if (a === "--token") { opts.token = argv[++i]; continue; }
    if (a.startsWith("--token=")) { opts.token = a.slice("--token=".length); continue; }
    if (a === "-q" || a === "--quiet") { opts.quiet = true; continue; }
    if (a === "--header") { opts.showHeader = true; continue; }
    rest.push(a);
  }
  return { rest, opts };
}

function resolveBaseUrl(opts: GlobalOptions, trailing?: string): string {
  if (opts.baseUrl) return opts.baseUrl.replace(/\/$/, "");
  if (trailing && /^https?:\/\//.test(trailing)) return trailing.replace(/\/$/, "");
  if (process.env.MEDINA_ROOT) return process.env.MEDINA_ROOT.replace(/\/$/, "");
  const port = process.env.PORT ?? "3002";
  return `http://localhost:${port}`;
}

function createClient(opts: GlobalOptions, trailing?: string) {
  return createMedinaClient({
    baseUrl: resolveBaseUrl(opts, trailing),
    tailscaleLogin: opts.login,
    token: opts.token,
  });
}

function authHeaders(opts: GlobalOptions): Record<string, string> {
  return createClient(opts).authHeaders();
}

function resolveUrl(target: string, base: string, query?: Array<[string, string]>): URL {
  const url = /^https?:\/\//.test(target)
    ? new URL(target)
    : new URL(`/${target.replace(/^\/+/, "")}`, base);
  if (query) for (const [k, v] of query) url.searchParams.append(k, v);
  return url;
}

function exitCodeFromStatus(status: number): number {
  if (status === 401) return EXIT_AUTH;
  if (status === 403) return EXIT_AUTH;
  if (status === 404) return EXIT_NOT_FOUND;
  return EXIT_ERR;
}

// ---------- day / interval helpers ----------

export function dayIdForDate(date: Date): string {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${String(y).padStart(5, "0")}${mo}${d}`;
}

export function dateForDayId(id: string): Date {
  const y = parseInt(id.slice(0, 5), 10);
  const mo = parseInt(id.slice(5, 7), 10);
  const d = parseInt(id.slice(7, 9), 10);
  return new Date(Date.UTC(y, mo - 1, d));
}

// Resolve a single-day spec to a 9-char day id.
export function resolveDaySpec(spec?: string, now: Date = new Date()): string {
  if (!spec || spec === "today") return dayIdForDate(now);
  if (spec === "yesterday") {
    const d = new Date(now); d.setUTCDate(d.getUTCDate() - 1); return dayIdForDate(d);
  }
  // Raw day ids: check before the bare-integer days-ago branch.
  if (/^\d{9}$/.test(spec)) return spec;
  if (/^\d{8}$/.test(spec)) return `0${spec}`;
  const iso = spec.match(/^(\d{4,5})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]!.padStart(5, "0")}${iso[2]}${iso[3]}`;
  const ago = spec.match(/^-?(\d+)d?$/);
  if (ago) {
    const n = parseInt(ago[1]!, 10);
    const d = new Date(now); d.setUTCDate(d.getUTCDate() - n); return dayIdForDate(d);
  }
  throw new Error(`Unrecognized day spec: ${spec}`);
}

// Resolve a list spec to an integer count of days.
export function resolveDayCount(spec?: string): number {
  if (!spec) return 7;
  if (spec === "today") return 1;
  if (spec === "yesterday") return 2;
  const iso = spec.match(/^P(\d+)D$/);
  if (iso) return parseInt(iso[1]!, 10);
  const d = spec.match(/^(\d+)d?$/);
  if (d) return parseInt(d[1]!, 10);
  throw new Error(`Unrecognized duration spec: ${spec}`);
}

export function dayIntervalIso(id: string): string {
  const date = dateForDayId(id);
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${String(y).padStart(4, "0")}-${mo}-${d}T00:00:00Z/P1D`;
}

export function dayUrlPath(id: string): string {
  return `/${id}`;
}

// Treat "a path that starts with / and looks like a day URL" or a bare day spec.
function normalizeDayRef(input: string): string {
  const m = input.match(/^\/(\d{9})$/);
  if (m) return m[1]!;
  if (/^\d{9}$/.test(input)) return input;
  return resolveDaySpec(input);
}

// ---------- generic HTTP ----------

type ReqOptions = {
  method: string;
  target: string;
  headers: Record<string, string>;
  query: Array<[string, string]>;
  body?: BodyInit;
  trailingBase?: string;
};

function parseReqArgs(method: string, args: string[]): ReqOptions {
  const opts: ReqOptions = { method: method.toUpperCase(), target: "", headers: {}, query: [] };
  const positional: string[] = [];
  let jsonBody: string | undefined;
  let rawBody: string | undefined;
  let fileBody: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") { jsonBody = args[++i]; continue; }
    if (a === "--data" || a === "-d") { rawBody = args[++i]; continue; }
    if (a === "--file" || a === "-F") { fileBody = args[++i]; continue; }
    if (a === "--header" || a === "-H") {
      const h = args[++i] ?? "";
      const idx = h.indexOf(":");
      if (idx > 0) opts.headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
      continue;
    }
    if (a === "--query" || a === "-Q") {
      const q = args[++i] ?? "";
      const idx = q.indexOf("=");
      opts.query.push(idx > 0 ? [q.slice(0, idx), q.slice(idx + 1)] : [q, ""]);
      continue;
    }
    if (a === "-X" || a === "--request") { opts.method = (args[++i] ?? "GET").toUpperCase(); continue; }
    positional.push(a);
  }
  if (positional.length === 0) throw new Error("Missing path/url argument.");
  opts.target = positional[0]!;
  if (positional.length > 1 && /^https?:\/\//.test(positional[positional.length - 1]!)) {
    opts.trailingBase = positional[positional.length - 1];
  }
  if (jsonBody !== undefined) {
    opts.body = jsonBody;
    opts.headers["content-type"] ??= "application/json";
  } else if (rawBody !== undefined) {
    opts.body = rawBody;
  } else if (fileBody !== undefined) {
    opts.body = fileBody === "-" ? (Bun.stdin as unknown as BodyInit) : (Bun.file(fileBody) as unknown as BodyInit);
  }
  return opts;
}

async function runRequest(opts: ReqOptions, globals: GlobalOptions) {
  const base = resolveBaseUrl(globals, opts.trailingBase);
  const url = resolveUrl(opts.target, base, opts.query);
  const client = createClient(globals, opts.trailingBase);
  const res = await client.request(url.toString(), { method: opts.method, headers: opts.headers, body: opts.body });
  if (!globals.quiet) {
    process.stderr.write(`${opts.method} ${url} → ${res.status} ${res.statusText}\n`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const text = await res.text();
    try {
      process.stdout.write(JSON.stringify(JSON.parse(text), null, 2) + "\n");
    } catch {
      process.stdout.write(text);
      if (text && !text.endsWith("\n")) process.stdout.write("\n");
    }
  } else if (ct.startsWith("text/") || ct === "" || ct.includes("charset")) {
    const text = await res.text();
    process.stdout.write(text);
    if (text && !text.endsWith("\n")) process.stdout.write("\n");
  } else {
    const buf = new Uint8Array(await res.arrayBuffer());
    process.stdout.write(buf);
  }
  if (!res.ok) process.exit(exitCodeFromStatus(res.status));
}

async function fetchJson<T = unknown>(target: string, globals: GlobalOptions): Promise<T> {
  const base = resolveBaseUrl(globals);
  const url = resolveUrl(target, base);
  const client = createClient(globals);
  const res = await client.request(url.toString(), { headers: { accept: "application/json" } });
  if (!res.ok) {
    process.stderr.write(`GET ${url} → ${res.status} ${res.statusText}\n`);
    process.exit(exitCodeFromStatus(res.status));
  }
  return (await res.json()) as T;
}

// ---------- formatters ----------

type DayJson = {
  coverageSeconds?: number;
  durationSeconds?: number;
  endTime?: string;
  id: string;
  key?: string;
  length?: string;
  recordings?: Array<{
    id: string;
    chunks?: Array<{ key: string; url: string; durationSeconds?: number | null }>;
    durationSeconds?: number | null;
    startTime?: string | null;
  }>;
  startTime?: string;
  summary?: string;
};

function tsv(...cols: Array<string | number | null | undefined>): string {
  return cols.map((c) => {
    if (c === null || c === undefined) return "";
    return String(c).replace(/[\t\r\n]/g, " ");
  }).join("\t");
}

function formatIsoDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.round(seconds);
  const days = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (days > 0 && h === 0 && m === 0 && s === 0) return `P${days}D`;
  let out = "P";
  if (days > 0) out += `${days}D`;
  let t = "";
  if (h > 0) t += `${h}H`;
  if (m > 0) t += `${m}M`;
  if (s > 0 || t === "") t += `${s}S`;
  return `${out}T${t}`;
}

function dayRowFromJson(day: DayJson): string {
  const id = day.id;
  return tsv(
    dayUrlPath(id),
    dayIntervalIso(id),
    day.length ?? formatIsoDuration(day.durationSeconds) ?? "P1D",
    day.summary ?? "",
  );
}

function dayRowFromId(id: string, summary = ""): string {
  return tsv(dayUrlPath(id), dayIntervalIso(id), "P1D", summary);
}

function maybeHeader(globals: GlobalOptions, ...cols: string[]) {
  if (globals.showHeader) process.stdout.write(tsv(...cols) + "\n");
}

// ---------- commands: days / intervals / day / latest / show / open ----------

async function cmdDays(restArgs: string[], globals: GlobalOptions) {
  let count: number;
  try { count = resolveDayCount(restArgs[0]); } catch (e) { die(EXIT_USAGE, (e as Error).message); }
  // Try server first: /intervals.json lists already-materialized ones.
  const available = await fetchJson<Array<{ id: string }>>("/intervals.json", globals).catch((): Array<{ id: string }> => []);
  const availableIds = new Set(available.map((a) => a.id));

  const now = new Date();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now); d.setUTCDate(d.getUTCDate() - i);
    ids.push(dayIdForDate(d));
  }

  maybeHeader(globals, "url", "interval", "duration", "summary");
  for (const id of ids) {
    if (!availableIds.has(id)) {
      // Day not materialized: emit a row anyway so the agent can attempt to drill in.
      process.stdout.write(dayRowFromId(id) + "\n");
      continue;
    }
    // Fetch the day to get coverage / summary if any.
    const day = await fetchJson<DayJson>(`/${id}.json`, globals).catch(() => null);
    if (!day) { process.stdout.write(dayRowFromId(id) + "\n"); continue; }
    process.stdout.write(dayRowFromJson(day) + "\n");
  }
}

async function cmdDay(restArgs: string[], globals: GlobalOptions) {
  let id: string;
  try { id = restArgs[0] ? normalizeDayRef(restArgs[0]) : resolveDaySpec(); }
  catch (e) { die(EXIT_USAGE, (e as Error).message); }
  await runRequest({ method: "GET", target: `/${id}.json`, headers: {}, query: [] }, globals);
}

async function cmdLatest(_restArgs: string[], globals: GlobalOptions) {
  const list = await fetchJson<Array<{ id: string }>>("/intervals.json", globals);
  const first = list[0];
  if (!first) return; // empty results = exit 0
  const day = await fetchJson<DayJson>(`/${first.id}.json`, globals).catch(() => null);
  maybeHeader(globals, "url", "interval", "duration", "summary");
  process.stdout.write((day ? dayRowFromJson(day) : dayRowFromId(first.id)) + "\n");
}

async function cmdShow(restArgs: string[], globals: GlobalOptions) {
  if (!restArgs[0]) die(EXIT_USAGE, "Usage: medina show <url|day-spec>");
  let id: string;
  try { id = normalizeDayRef(restArgs[0]); } catch (e) { die(EXIT_USAGE, (e as Error).message); }
  const day = await fetchJson<DayJson>(`/${id}.json`, globals);
  const iso = dayIntervalIso(id);
  const cov = formatIsoDuration(day.coverageSeconds ?? 0);
  const recordings = day.recordings ?? [];
  const out: string[] = [];
  out.push(`# ${iso}`);
  out.push("");
  if (day.summary) { out.push(day.summary); out.push(""); }
  out.push(`- Coverage: ${cov || "PT0S"} / P1D`);
  out.push(`- Recordings: ${recordings.length}`);
  out.push("");
  if (recordings.length > 0) {
    out.push("## Recordings");
    for (const r of recordings) {
      const dur = formatIsoDuration(r.durationSeconds ?? null);
      const chunkCount = r.chunks?.length ?? 0;
      const start = r.startTime ?? "unknown start";
      out.push(`- ${r.id} — ${start} — ${dur} — ${chunkCount} chunk${chunkCount === 1 ? "" : "s"}`);
    }
    out.push("");
  }
  out.push("## Links");
  out.push(`- JSON: /${id}.json`);
  process.stdout.write(out.join("\n") + "\n");
}

async function cmdOpen(restArgs: string[], globals: GlobalOptions) {
  if (!restArgs[0]) die(EXIT_USAGE, "Usage: medina open <url|day-spec>");
  const arg = restArgs[0];
  const base = resolveBaseUrl(globals);
  let url: string;
  if (/^https?:\/\//.test(arg)) {
    url = arg;
  } else if (arg.startsWith("/")) {
    url = `${base}${arg}`;
  } else {
    let id: string;
    try { id = normalizeDayRef(arg); } catch (e) { die(EXIT_USAGE, (e as Error).message); }
    url = `${base}/${id}`;
  }
  process.stdout.write(`${url}\n`);
  const cmds = [
    { cmd: "xdg-open", args: [url] },
    { cmd: "open", args: [url] },
  ];
  for (const { cmd, args } of cmds) {
    try {
      const proc = Bun.spawn([cmd, ...args], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      const code = await proc.exited;
      if (code === 0) return;
    } catch {}
  }
  process.stderr.write("No browser opener found (tried xdg-open, open).\n");
  process.exit(EXIT_ERR);
}

// ---------- ingest ----------

function getMimeType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".m4a": return "audio/mp4";
    case ".mp3": return "audio/mpeg";
    case ".mp4": return "audio/mp4";
    case ".ogg": return "audio/ogg";
    case ".wav": return "audio/wav";
    case ".webm": return "audio/webm";
    default: return "application/octet-stream";
  }
}

// Parse timestamp from filenames like:
//   sco-lifelog-020260515T060242.m4a  (5-digit year)
//   sco-lifelog2-20260415T211011.mp3  (4-digit year)
function parseFilenameCreatedAt(filename: string): string | undefined {
  const base = path.basename(filename);
  let match = base.match(/(\d{5})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (match) {
    const [, y, mo, d, h, mi, s] = match;
    return `${parseInt(y!, 10)}-${mo}-${d}T${h}:${mi}:${s}Z`;
  }
  match = base.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (match) {
    const [, y, mo, d, h, mi, s] = match;
    return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  }
  return undefined;
}

type EventResponse = { eventId?: string; ok?: boolean };

type IngestResult = {
  contentType: string;
  eventId: string;
  fileName: string;
  ingestId: string;
  key: string;
};

function eventMatchesIngest(data: unknown, ingestKey: string, ingestId: string, type: string) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const obj = data as Record<string, unknown>;
  return obj.type === type && (obj.ingestKey === ingestKey || obj.ingestId === ingestId);
}

async function waitForMaterialization(_base: string, globals: GlobalOptions, result: IngestResult) {
  const deadline = Date.now() + Number(process.env.MEDINA_CLI_WAIT_TIMEOUT_MS ?? 30 * 60 * 1000);
  let lastStatus = "waiting";

  while (Date.now() < deadline) {
    const events = await fetchJson<Array<{ data: Record<string, unknown> }>>("/events.json?limit=100", globals);
    const failed = events.find((event) => eventMatchesIngest(event.data, result.key, result.ingestId, "materialization.failed"));
    if (failed) throw new Error(`Materialization failed for ${result.key}: ${JSON.stringify(failed.data)}`);

    const succeeded = events.find((event) => eventMatchesIngest(event.data, result.key, result.ingestId, "materialization.succeeded"));
    if (succeeded) {
      process.stderr.write(`materialization succeeded for ${result.key}\n`);
      return;
    }

    const started = events.find((event) => eventMatchesIngest(event.data, result.key, result.ingestId, "materialization.started"));
    if (started && lastStatus !== "started") {
      lastStatus = "started";
      process.stderr.write(`materialization started for ${result.key}\n`);
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error(`Timed out waiting for materialization of ${result.key}`);
}

async function ingestFile(filePath: string, base: string, globals: GlobalOptions): Promise<IngestResult> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) throw new Error(`File not found: ${filePath}`);

  const fileName = path.basename(filePath);
  const type = getMimeType(filePath);
  const createdAt = parseFilenameCreatedAt(fileName) ?? new Date().toISOString();
  const client = createMedinaClient({
    baseUrl: base,
    tailscaleLogin: globals.login,
    token: globals.token,
  });
  const dest = await client.createIngestDestination({
    createdAt,
    fileName,
    metadata: {
      "recording-started-at": createdAt,
      source: "bin/medina-cli",
    },
    type,
  });
  await client.uploadToDestination(dest, file as unknown as BodyInit);
  const event = await client.notifyUploadFinished({
    contentType: type,
    filename: fileName,
    ingestId: dest.ingestId,
    ingestKey: dest.key,
    source: "bin/medina-cli",
  }) as EventResponse;

  const result = {
    contentType: type,
    eventId: event.eventId ?? "",
    fileName,
    ingestId: dest.ingestId,
    key: dest.key,
  };
  process.stdout.write(tsv(result.key, result.ingestId, result.contentType, result.fileName, result.eventId) + "\n");
  return result;
}

async function cmdIn(restArgs: string[], globals: GlobalOptions) {
  if (restArgs.length === 0) die(EXIT_USAGE);
  const wait = restArgs.includes("--wait");
  const args = restArgs.filter((arg) => arg !== "--wait");
  const last = args[args.length - 1]!;
  const hasUrl = /^https?:\/\//.test(last);
  const files = hasUrl ? args.slice(0, -1) : args;
  const base = resolveBaseUrl(globals, hasUrl ? last : undefined);
  if (files.length === 0) die(EXIT_USAGE);
  if (globals.showHeader) process.stdout.write(tsv("key", "ingest_id", "content_type", "filename", "event_id") + "\n");
  for (const filePath of files) {
    const name = path.basename(filePath);
    process.stderr.write(`ingesting ${name} … `);
    try {
      const result = await ingestFile(filePath, base, globals);
      process.stderr.write("uploaded and queued\n");
      if (wait) {
        await waitForMaterialization(base, globals, result);
      }
    } catch (e) {
      process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = EXIT_ERR;
    }
  }
}

// ---------- capture ----------

export function createCaptureFilePath(extension = ".wav"): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `/tmp/medina-capture-${stamp}${extension}`;
}

export function getCaptureCommands(outputPath: string): CaptureCommand[] {
  const override = process.env.MEDINA_RECORDER?.trim();
  if (override) {
    const [cmd, ...args] = override.split(/\s+/).filter(Boolean);
    return [{ cmd: cmd!, args: [...args, outputPath] }];
  }
  return [
    { cmd: "arecord", args: ["-f", "cd", "-t", "wav", outputPath] },
    { cmd: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-f", "alsa", "-i", "default", "-ac", "1", "-ar", "16000", "-y", outputPath] },
    { cmd: "rec", args: ["-c", "1", "-r", "16000", outputPath] },
    { cmd: "sox", args: ["-d", "-c", "1", "-r", "16000", outputPath] },
  ];
}

export function parseCaptureArgs(args: string[]): { baseUrl?: string; speakText?: string } {
  let baseUrl: string | undefined;
  let speakText: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--speak") { speakText = args[++i]; continue; }
    if (a.startsWith("--speak=")) { speakText = a.slice("--speak=".length); continue; }
    if (a.startsWith("--")) throw new Error(`Unknown capture option: ${a}`);
    baseUrl = a;
  }
  return { baseUrl, speakText };
}

export async function readProcessOutput(proc: { stdout: ReadableStream<Uint8Array> | null }): Promise<Uint8Array> {
  const stream = proc.stdout;
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

async function trySpawn(commands: Array<{ cmd: string; args: string[] }>): Promise<void> {
  let lastErr: unknown = null;
  for (const { cmd, args } of commands) {
    try {
      const proc = Bun.spawn([cmd, ...args], { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
      const code = await proc.exited;
      if (code === 0) return;
      lastErr = new Error(`${cmd} exited ${code}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error("No usable command found.");
}

async function captureAudio(outputPath: string) {
  process.stderr.write(`Capturing audio to ${outputPath}. Press Ctrl+C to stop.\n`);
  await trySpawn(getCaptureCommands(outputPath));
}

async function captureAndIngest(args: { baseUrl?: string; speakText?: string }, globals: GlobalOptions) {
  if (args.speakText) die(EXIT_USAGE, "--speak is not available in the standalone CLI.");
  const base = resolveBaseUrl(globals, args.baseUrl);
  const outputPath = createCaptureFilePath(".wav");
  try {
    await captureAudio(outputPath);
    const file = Bun.file(outputPath);
    if (!(await file.exists())) throw new Error(`Capture failed to create ${outputPath}.`);
    if (typeof file.size === "number" && file.size === 0) throw new Error("Captured audio file is empty.");
    process.stderr.write(`Captured audio to ${outputPath}. Ingesting…\n`);
    await ingestFile(outputPath, base, globals);
  } finally {
    await unlink(outputPath).catch(() => {});
  }
}

// ---------- main ----------

export async function main(argv = Bun.argv.slice(2)) {
  const { rest, opts: globals } = extractGlobals(argv);
  const [command, ...restArgs] = rest;

  if (!command) {
    await runRequest({ method: "GET", target: "/status.json", headers: {}, query: [] }, globals);
    return;
  }

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      usage();
      return;
    case "status":
      await runRequest({ method: "GET", target: "/status.json", headers: {}, query: [] }, globals);
      return;
    case "days":
    case "intervals":
      await cmdDays(restArgs, globals);
      return;
    case "day":
      await cmdDay(restArgs, globals);
      return;
    case "latest":
      await cmdLatest(restArgs, globals);
      return;
    case "show":
      await cmdShow(restArgs, globals);
      return;
    case "open":
      await cmdOpen(restArgs, globals);
      return;
    case "in":
      await cmdIn(restArgs, globals);
      return;
    case "capture": {
      const captureOpts = parseCaptureArgs(restArgs);
      await captureAndIngest(captureOpts, globals);
      return;
    }
    case "get":
    case "post":
    case "put":
    case "delete":
      try { await runRequest(parseReqArgs(command, restArgs), globals); }
      catch (e) { die(EXIT_USAGE, e instanceof Error ? e.message : String(e)); }
      return;
    case "req": {
      const [methodArg, ...rest2] = restArgs;
      if (!methodArg) die(EXIT_USAGE);
      try { await runRequest(parseReqArgs(methodArg, rest2), globals); }
      catch (e) { die(EXIT_USAGE, e instanceof Error ? e.message : String(e)); }
      return;
    }
    default:
      if (command.startsWith("/") || /^https?:\/\//.test(command)) {
        await runRequest({ method: "GET", target: command, headers: {}, query: [] }, globals);
        return;
      }
      usage();
      process.exit(EXIT_USAGE);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exit(EXIT_ERR);
  });
}
