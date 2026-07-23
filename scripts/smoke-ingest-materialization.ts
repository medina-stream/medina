#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { generateAudioFixture, type AudioFixtureResult } from "../resources/audio-fixture";

class SmokeError extends Error {}

const defaultBaseUrl = `http://127.0.0.1:${process.env.PORT ?? "3002"}`;
const defaultLogin = "dev@example.com";
const pollTimeoutMs = 90_000;
const pollIntervalMs = 2_000;

type Json = Record<string, unknown>;

type IngestDestination = {
  action: string;
  headers: Record<string, string>;
  ingestId: string;
  key: string;
  method: string;
};

type Recording = {
  chunks?: Array<{ url?: string }>;
  id: string;
  startTime?: string | null;
};

type IntervalRef = {
  id: string;
  key: string;
  kind: string;
};

function usage() {
  console.error(`Usage:
  bun scripts/smoke-ingest-materialization.ts [--base-url <url>] [--login <email>] [--timeout-ms <ms>]

Runs an end-to-end dev smoke test:
  audio fixture -> POST /in -> PUT upload -> POST /events ingest-uploaded -> poll read models.

Environment:
  MEDINA_SMOKE_BASE_URL      default ${defaultBaseUrl}
  MEDINA_SMOKE_LOGIN         default ${defaultLogin} (sent only as Tailscale-User-Login)
  MEDINA_SMOKE_TIMEOUT_MS    default ${pollTimeoutMs}
`);
}

function requireValue(argv: string[], index: number, flag: string) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new SmokeError(`Missing value for ${flag}.`);
  }
  return value;
}

function parseArgs(argv: string[]) {
  const options = {
    baseUrl: process.env.MEDINA_SMOKE_BASE_URL ?? defaultBaseUrl,
    login: process.env.MEDINA_SMOKE_LOGIN ?? defaultLogin,
    timeoutMs: Number(process.env.MEDINA_SMOKE_TIMEOUT_MS ?? pollTimeoutMs),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--base-url":
        options.baseUrl = requireValue(argv, ++i, arg);
        break;
      case "--login":
        options.login = requireValue(argv, ++i, arg);
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(requireValue(argv, ++i, arg));
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
        break;
      default:
        throw new SmokeError(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new SmokeError(`Invalid timeout: ${options.timeoutMs}`);
  }

  return options;
}

function log(message: string) {
  console.log(`[smoke] ${message}`);
}

function smokeHeaders(login: string, extra?: HeadersInit) {
  return {
    "Tailscale-User-Login": login,
    ...extra,
  };
}

async function requestJson<T>(url: string, init: RequestInit & { login: string }): Promise<T> {
  const { login, headers, ...rest } = init;
  const response = await fetch(url, {
    ...rest,
    headers: smokeHeaders(login, headers),
  });
  const text = await response.text();

  if (!response.ok) {
    throw new SmokeError(`${rest.method ?? "GET"} ${url} failed: ${response.status} ${response.statusText}\n${text}`);
  }

  return text ? JSON.parse(text) as T : {} as T;
}

function jsonArray(value: unknown, label: string): Json[] {
  if (!Array.isArray(value)) throw new SmokeError(`${label} did not return an array.`);
  return value as Json[];
}

async function generateFixture(outDir: string): Promise<AudioFixtureResult> {
  log("generating unique audio fixture");
  const result = generateAudioFixture({
    outDir,
    prefix: "smoke-ingest",
  });
  if (!result.outputPath || !existsSync(result.outputPath)) {
    throw new SmokeError(`Fixture generator did not create ${result.outputPath}`);
  }
  log(`fixture ${result.outputPath.split("/").at(-1)} signature=${result.signature}`);
  return result;
}

function getDayId(dateIso: string) {
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) throw new SmokeError(`Invalid date: ${dateIso}`);
  return [
    String(date.getUTCFullYear()).padStart(5, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("");
}

function findRecording(recordings: Recording[], createdAt: string) {
  const targetMs = new Date(createdAt).getTime();
  if (!Number.isFinite(targetMs)) return null;

  return recordings.find((recording) => {
    if (!recording.startTime) return false;
    const startMs = new Date(recording.startTime).getTime();
    return Number.isFinite(startMs) && Math.abs(startMs - targetMs) <= 5_000;
  }) ?? null;
}

function findInterval(intervals: IntervalRef[], id: string) {
  return intervals.find((interval) => interval.id === id && interval.key === `intervals/${id}.json`);
}

async function poll<T>(description: string, timeoutMs: number, check: () => Promise<T | null>) {
  const started = Date.now();
  let lastError: unknown = null;

  while (Date.now() - started < timeoutMs) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(pollIntervalMs);
  }

  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new SmokeError(`Timed out after ${timeoutMs}ms waiting for ${description}.${detail}`);
}

async function main() {
  const options = parseArgs(Bun.argv.slice(2));
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const tempDir = await mkdtemp(resolve(tmpdir(), "medina-smoke-"));

  try {
    log(`base ${baseUrl}`);

    const status = await requestJson<Json>(`${baseUrl}/status.json`, { login: options.login });
    if (status.ok !== true) throw new SmokeError(`/status.json returned ok=${String(status.ok)}`);
    log("status ok");

    const beforeIntervals = jsonArray(
      await requestJson<unknown>(`${baseUrl}/intervals.json`, { login: options.login }),
      "/intervals.json",
    ) as IntervalRef[];
    log(`intervals before=${beforeIntervals.length}`);

    const fixture = await generateFixture(tempDir);
    const originalFilename = fixture.outputPath.split("/").at(-1) ?? "smoke.wav";
    const createdAt = new Date().toISOString();
    const intervalId = getDayId(createdAt);

    log("creating ingest destination");
    const destination = await requestJson<IngestDestination>(`${baseUrl}/in`, {
      login: options.login,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "audio/wav",
        metadata: {
          "sdk-version": "medina-smoke-runner/1",
          "original-filename": originalFilename,
          "created-at": createdAt,
          "recording-started-at": createdAt,
          source: "medina-smoke-runner",
          "fixture-signature": fixture.signature,
        },
      }),
    });

    if (!destination.ingestId || !destination.key?.startsWith("in/")) {
      throw new SmokeError(`Unexpected ingest destination: ${JSON.stringify(destination)}`);
    }
    log(`ingest ${destination.key}`);

    log("uploading audio bytes");
    const bytes = await readFile(fixture.outputPath);
    const uploadUrl = new URL(destination.action);
    if (uploadUrl.pathname === `/${destination.key}`) {
      const base = new URL(baseUrl);
      uploadUrl.protocol = base.protocol;
      uploadUrl.host = base.host;
      uploadUrl.pathname = `/in/${destination.ingestId}`;
    }
    const uploadResponse = await fetch(uploadUrl, {
      method: destination.method,
      headers: smokeHeaders(options.login, destination.headers),
      body: bytes,
    });
    const uploadText = await uploadResponse.text();
    if (!uploadResponse.ok) {
      throw new SmokeError(`Upload failed: ${uploadResponse.status} ${uploadResponse.statusText}\n${uploadText}`);
    }
    const uploadResult = JSON.parse(uploadText) as { key?: string };
    if (uploadResult.key !== destination.key) {
      throw new SmokeError(`Upload stored unexpected key: ${JSON.stringify(uploadResult)}`);
    }
    log(`uploaded ${bytes.byteLength} bytes`);

    log("posting ingest-uploaded event");
    await requestJson<Json>(`${baseUrl}/events`, {
      login: options.login,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "ingest-uploaded",
        ingestId: destination.ingestId,
        ingestKey: destination.key,
        contentType: "audio/wav",
        fixtureSignature: fixture.signature,
        createdAt,
      }),
    });

    log(`polling materialization for interval ${intervalId}`);
    const materialized = await poll("recording and interval materialization", options.timeoutMs, async () => {
      const [recordings, intervals] = await Promise.all([
        requestJson<Recording[]>(`${baseUrl}/recordings.json`, { login: options.login }),
        requestJson<IntervalRef[]>(`${baseUrl}/intervals.json`, { login: options.login }),
      ]);
      const recording = findRecording(recordings, createdAt);
      const interval = findInterval(intervals, intervalId);
      if (!recording || !interval) return null;

      const intervalBody = await requestJson<{ recordings?: Recording[] }>(`${baseUrl}/${intervalId}.json`, { login: options.login });
      const intervalHasRecording = intervalBody.recordings?.some((intervalRecording) => intervalRecording.id === recording.id);
      if (!intervalHasRecording) return null;

      return { recording, interval, intervalBody, recordings, intervals };
    });

    log(`recording ${materialized.recording.id}`);
    log(`intervals after=${materialized.intervals.length}`);
    log(`${intervalId}.json includes smoke recording`);

    const chunkUrl = materialized.recording.chunks?.[0]?.url;
    if (!chunkUrl) throw new SmokeError("Smoke recording has no chunk URL.");
    const chunkResponse = await fetch(`${baseUrl}${chunkUrl}`, {
      headers: smokeHeaders(options.login),
    });
    if (!chunkResponse.ok) {
      throw new SmokeError(`Chunk fetch failed: ${chunkResponse.status} ${chunkResponse.statusText}`);
    }
    const chunkType = chunkResponse.headers.get("content-type") ?? "";
    if (!chunkType.includes("audio/")) {
      throw new SmokeError(`Chunk content-type was not audio/*: ${chunkType}`);
    }
    log(`chunk HTTP ok content-type=${chunkType}`);

    console.log(JSON.stringify({
      ok: true,
      ingestKey: destination.key,
      intervalId,
      recordingId: materialized.recording.id,
      fixtureSignature: fixture.signature,
      intervalsBefore: beforeIntervals.length,
      intervalsAfter: materialized.intervals.length,
    }, null, 2));
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(error instanceof SmokeError ? 2 : 1);
});
