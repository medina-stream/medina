import { Hono } from "hono";
import { cors } from "hono/cors";

import type { Bucket } from "../lib/bucket";
import { createArtifactResolver } from "../lib/artifact-bun";
import { createEvent, getEvents } from "../lib/event";
import { getIntervalBucketKey, listIntervals } from "../resources/interval";
import { getGpsJsonKey, getGpsMarkdownKey, gpsDefinition } from "../resources/gps";
import { PLACES_KEY, parsePlacesMarkdown, readPlaces } from "../resources/places";
import { getGpsMapImageKey, getGpsMapSvgKey, gpsMapImageDefinition, gpsMapSvgDefinition } from "../resources/gps-map";
import { intervalsDefinition } from "../resources/intervals";
import { createIngestService, createPresignIngestUpload, isIngestMetadataError } from "../lib/ingest";
import { ensureTriageWork } from "../resources/triage-work";
import "../resources/triage-handler-audio";
import "../resources/triage-handler-gps-hour";
import { fingerprintDependencies, getDependencySetHash, getMaterializationFreshness, onResourceWarning, readMaterializationReceipt, runResource, type ResourceDependencyFingerprint, type ResourceDefinition } from "../lib/resource";
import { getStatus } from "../lib/status";
import { getChunkFormatFromKey, getRecordings } from "../resources/recording";
import { getPodcastFeedKey, podcastFeedDefinition } from "../resources/podcast";
import { isDayTranscriptFinal, isDayTranscriptId, listTranscripts, materializeDayTranscripts, readDayTranscripts } from "../resources/transcripts";
import { createSpeaker, deleteSpeaker, deleteSpeakerSample, listSpeakers, readSpeaker, updateSpeaker, writeSpeakerSample } from "../resources/speakers";
import { materializeTodos } from "../resources/todos";
import { createStreamMiddleware, getMedinaContext, getRequestBucket } from "./stream-middleware";
import { type BucketCredentials } from "#lib/stream";
import { getRequestPublicBase } from "./public-base";
import { createAgentsDocs } from "./agent-docs";
import { createApiDocs } from "./api-docs";
import { createServiceWorkerResponse } from "./service-worker";
import { streams as configuredStreams } from "../medina.config";
import { appIconOutputs } from "../resources/app-icon";
import { mountResource } from "./resource-mount";
import {
  buildAuthorizationUrl,
  consumePendingState,
  createPendingState,
  exchangeAuthorizationCode,
  fetchUserEmail,
  refreshAccessToken,
  googleDriveScopes,
} from "../lib/gdrive";
import {
  createSource,
  deleteSourceConfig,
  ensureSourcesMigrated,
  getSourceDefinition,
  listSourceConfigs,
  readSourceConfig,
  sourceConfigKey,
  toPublicSourceConfig,
  updateSourceConfig,
  writeSourceConfig,
  type SourceConfig,
} from "../lib/source";
import { syncAllSources, syncOneSourceById } from "../resources/source";
import "../resources/source-gdrive";
import "../resources/source-filesystem";

export const streams = configuredStreams;

const app = new Hono();
export default app;
export type ApiType = typeof app;

onResourceWarning(({ definition, inputKey, warning }) => {
  createEvent({
    code: warning.code,
    inputKey,
    message: warning.message,
    resource: definition.name,
    type: "resource.degraded",
  });
});

async function createResourceHeadResponse(bucketInstance: Bucket, resourceKey: string, planResource: (bucketInstance: Bucket) => Promise<{ definition: Pick<ResourceDefinition<unknown>, "name" | "version">; dependencies: ResourceDependencyFingerprint[] }>) {
  const outputExists = await bucketInstance.exists(resourceKey);
  const receipt = await readMaterializationReceipt(bucketInstance, resourceKey);
  const headers = new Headers();
  headers.set("x-medina-resource-key", resourceKey);
  headers.set("x-medina-resource-exists", String(outputExists));
  if (receipt?.warnings?.length) {
    headers.set("x-medina-resource-degraded", receipt.warnings.map((warning) => warning.code).join(","));
  }

  try {
    const planned = await planResource(bucketInstance);
    const dependencySetHash = await getDependencySetHash(planned.dependencies);
    const freshness = getMaterializationFreshness({
      currentDependencies: planned.dependencies,
      currentDependencySetHash: dependencySetHash,
      definition: planned.definition,
      outputExists,
      receipt,
    });
    headers.set("x-medina-resource-fresh", String(freshness.fresh));
    if (!freshness.fresh) headers.set("x-medina-resource-stale-reason", freshness.reason);
  } catch (error) {
    headers.set("x-medina-resource-fresh", "false");
    headers.set("x-medina-resource-stale-reason", "plan-error");
    headers.set("x-medina-resource-error", error instanceof Error ? error.message : String(error));
  }

  return new Response(null, { headers, status: outputExists ? 200 : 404 });
}

function createRecordingChunkResponse(bucketInstance: Bucket, key: string) {
  return (async () => {
    if (!(await bucketInstance.exists(key))) return null;
    const data = await bucketInstance.readArrayBuffer(key);
    const { contentType } = getChunkFormatFromKey(key);
    return new Response(data, {
      headers: {
        "content-type": contentType,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  })();
}

function normalizeUploadedIngestKey(value: string | null) {
  if (!value) return null;
  return value.startsWith("in/") ? value : `in/${value}`;
}

function getUploadedIngestKey(event: Record<string, unknown>) {
  const directKey = typeof event.ingestKey === "string" ? event.ingestKey : null;
  const directId = typeof event.ingestId === "string" ? event.ingestId : null;
  const data = event.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : null;
  const nestedKey = typeof data?.key === "string" ? data.key : null;
  const nestedIngestKey = typeof data?.ingestKey === "string" ? data.ingestKey : null;
  const nestedId = typeof data?.ingestId === "string" ? data.ingestId : null;
  return normalizeUploadedIngestKey(directKey ?? nestedIngestKey ?? nestedKey ?? directId ?? nestedId);
}

function toPresignConfig(credentials: BucketCredentials) {
  return {
    accessKeyId: credentials.accessKeyId,
    bucket: credentials.bucketName,
    endpoint: credentials.endpoint,
    forcePathStyle: credentials.forcePathStyle === undefined ? undefined : String(credentials.forcePathStyle),
    region: credentials.region,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
  };
}

function createRequestIngestService(c: { get: (key: string) => unknown; req: { raw: Request; url: string } }) {
  const context = getMedinaContext(c);
  const bucketInstance = context.bucket;
  const credentials = context.bucketCredentials;
  return createIngestService({
    artifacts: createArtifactResolver({ bucket: bucketInstance, workerId: `server:${process.pid}` }),
    bucket: bucketInstance,
    directUploadAction: (ingestId) => new URL(`/in/${ingestId}`, getRequestPublicBase(c)).toString(),
    onStoredIngest: async ({ key }) => {
      await ensureTriageWork({ bucket: bucketInstance, ingestKey: key });
    },
    presignIngestUpload: createPresignIngestUpload(credentials ? toPresignConfig(credentials) : null),
  });
}

app.use("*", cors());
app.use("*", createStreamMiddleware(streams));

mountResource(app, appIconOutputs, { prefix: "", public: true });

app.get("/status.json", (c) => {
  const context = getMedinaContext(c);
  return c.json(getStatus(c.req.url, context.currentUser, {
    bucketAccessible: context.bucketAccessible,
    bucketId: context.bucketId,
  }));
});
function redirect(c: any, location: string) {
  return c.redirect(location, 301);
}

app.get("/agents.md", (c) => c.text(createAgentsDocs(getRequestPublicBase(c)), 200, { "content-type": "text/markdown; charset=utf-8" }));
for (const path of ["/agent", "/agent.md", "/skill", "/skill.md", "/SKILL.md"] as const) {
  app.get(path, (c) => redirect(c, "/agents.md"));
}
for (const path of ["/api", "/API", "/API.md", "/docs"] as const) {
  app.get(path, (c) => redirect(c, "/api.md"));
}

app.get("/api.md", (c) => c.text(createApiDocs(getRequestPublicBase(c)), 200, { "content-type": "text/markdown; charset=utf-8" }));
app.get("/sw.js", () => createServiceWorkerResponse());
app.get("/manifest.json", (c) => {
  const context = getMedinaContext(c);
  const name = context.site.name || context.site.host || "Medina";
  const startUrl = new URL("/app", getRequestPublicBase(c)).toString();
  return c.json({
    id: "/",
    name,
    short_name: name,
    description: context.site.description ?? "Medina stream",
    start_url: startUrl,
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#0f172a",
    theme_color: "#0f172a",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-monochrome.svg", sizes: "any", type: "image/svg+xml", purpose: "monochrome" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }, 200, {
    "cache-control": "no-cache",
    "content-type": "application/manifest+json; charset=utf-8",
  });
});
app.get("/recordings.json", async (c) => c.json(await getRecordings({ bucket: getRequestBucket(c) })));
app.get("/podcast.xml", async (c) => {
  const bucketInstance = getRequestBucket(c);
  const key = getPodcastFeedKey();
  await runResource(podcastFeedDefinition, { bucket: bucketInstance, inputKey: key });
  const [data, stats] = await Promise.all([
    bucketInstance.readArrayBuffer(key),
    bucketInstance.stat(key),
  ]);
  return new Response(data, {
    headers: {
      "cache-control": "no-cache",
      "content-type": stats.type ?? "application/rss+xml; charset=utf-8",
    },
  });
});
app.get("/todos.json", async (c) => c.json(await materializeTodos({ bucket: getRequestBucket(c) })));

app.get("/speakers.json", async (c) => c.json(await listSpeakers({ bucket: getRequestBucket(c) })));

app.post("/speakers", async (c) => {
  const body = await c.req.json<{ name?: unknown; notes?: unknown }>().catch(() => null);
  const name = typeof body?.name === "string" ? body.name : "";
  const notes = typeof body?.notes === "string" ? body.notes : undefined;
  try {
    return c.json(await createSpeaker({ bucket: getRequestBucket(c), name, notes }), 201);
  } catch (error) {
    return c.json({ error: "bad_request", message: (error as Error).message }, 400);
  }
});

app.get("/speakers/:id", async (c) => {
  try {
    const speaker = await readSpeaker({ bucket: getRequestBucket(c), id: c.req.param("id") });
    return speaker ? c.json(speaker) : c.json({ error: "not_found" }, 404);
  } catch (error) {
    return c.json({ error: "bad_request", message: (error as Error).message }, 400);
  }
});

app.put("/speakers/:id", async (c) => {
  const body = await c.req.json<{ name?: unknown; notes?: unknown }>().catch(() => null);
  const name = typeof body?.name === "string" ? body.name : "";
  const notes = typeof body?.notes === "string" ? body.notes : undefined;
  try {
    const speaker = await updateSpeaker({ bucket: getRequestBucket(c), id: c.req.param("id"), name, notes });
    return speaker ? c.json(speaker) : c.json({ error: "not_found" }, 404);
  } catch (error) {
    return c.json({ error: "bad_request", message: (error as Error).message }, 400);
  }
});

app.delete("/speakers/:id", async (c) => {
  try {
    await deleteSpeaker({ bucket: getRequestBucket(c), id: c.req.param("id") });
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ error: "bad_request", message: (error as Error).message }, 400);
  }
});

app.post("/speakers/:id/samples", async (c) => {
  const contentType = c.req.header("content-type") ?? "application/octet-stream";
  const disposition = c.req.header("content-disposition") ?? "";
  const dispositionName = disposition.match(/filename="?([^";]+)"?/)?.[1];
  const filename = c.req.query("filename") ?? dispositionName ?? `sample-${Date.now()}.ogg`;
  try {
    const speaker = await writeSpeakerSample({
      bucket: getRequestBucket(c),
      contentType,
      data: await c.req.arrayBuffer(),
      filename,
      id: c.req.param("id"),
    });
    return speaker ? c.json(speaker, 201) : c.json({ error: "not_found" }, 404);
  } catch (error) {
    return c.json({ error: "bad_request", message: (error as Error).message }, 400);
  }
});

app.delete("/speakers/:id/samples/:sampleName", async (c) => {
  try {
    const speaker = await deleteSpeakerSample({ bucket: getRequestBucket(c), id: c.req.param("id"), sampleName: c.req.param("sampleName") });
    return speaker ? c.json(speaker) : c.json({ error: "not_found" }, 404);
  } catch (error) {
    return c.json({ error: "bad_request", message: (error as Error).message }, 400);
  }
});

app.get("/speakers/:id/samples/:sampleName", async (c) => {
  const bucketInstance = getRequestBucket(c);
  try {
    const key = `speakers/${c.req.param("id")}/${c.req.param("sampleName")}`;
    if (!(await bucketInstance.exists(key))) return c.notFound();
    const [data, stats] = await Promise.all([bucketInstance.readArrayBuffer(key), bucketInstance.stat(key)]);
    return new Response(data, { headers: { "content-type": stats.type ?? "application/octet-stream" } });
  } catch {
    return c.notFound();
  }
});

app.get("/transcripts.json", async (c) => {
  const fromRaw = c.req.query("from");
  const toRaw = c.req.query("to");
  const from = fromRaw ? new Date(fromRaw) : undefined;
  const to = toRaw ? new Date(toRaw) : undefined;

  if (from && Number.isNaN(from.getTime())) {
    return c.json({ error: "bad_request", message: "Invalid from timestamp." }, 400);
  }
  if (to && Number.isNaN(to.getTime())) {
    return c.json({ error: "bad_request", message: "Invalid to timestamp." }, 400);
  }

  return c.json(await listTranscripts({ bucket: getRequestBucket(c), from, to }));
});
app.get("/transcripts/:dayAsset", async (c) => {
  const dayAsset = c.req.param("dayAsset");
  const dayId = dayAsset.replace(/\.json$/, "");
  if (!isDayTranscriptId(dayId)) {
    return c.json({ error: "bad_request", message: "Invalid transcript day id." }, 400);
  }

  const bucket = getRequestBucket(c);
  const transcripts = await readDayTranscripts(dayId, { bucket })
    ?? await materializeDayTranscripts(dayId, { bucket });

  return c.json(transcripts, 200, {
    "cache-control": isDayTranscriptFinal(dayId, new Date())
      ? "public, max-age=86400, stale-while-revalidate=604800"
      : "no-cache",
    "content-type": "application/json; charset=utf-8",
  });
});
app.get("/intervals.json", async (c) => c.json(await listIntervals({ bucket: getRequestBucket(c) })));
app.get("/events.json", (c) => {
  const rawLimit = Number(c.req.query("limit"));
  return c.json(getEvents(Number.isFinite(rawLimit) ? rawLimit : undefined));
});
app.post("/events", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ ok: true });

  const sourceEvent = createEvent(body);

  if (body.type === "ingest-uploaded") {
    const ingestKey = getUploadedIngestKey(body);
    if (ingestKey) {
      await ensureTriageWork({ bucket: getRequestBucket(c), ingestKey }).catch((error) => {
        console.error("failed to create triage work", error);
      });
    }
  }

  return c.json({ ok: true, eventId: sourceEvent.id });
});

app.get("/sources.json", async (c) => {
  const bucketInstance = getRequestBucket(c);
  await ensureSourcesMigrated(bucketInstance);
  const configs = await listSourceConfigs(bucketInstance);
  return c.json({ sources: await Promise.all(configs.map((config) => toPublicSourceConfig(bucketInstance, config))) });
});

app.get("/sources/:file{.+\\.json}", async (c) => {
  const bucketInstance = getRequestBucket(c);
  const id = c.req.param("file").slice(0, -".json".length);
  const config = await readSourceConfig(bucketInstance, id);
  if (!config) return c.json({ error: "not_found", message: `No source with id ${id}.` }, 404);
  return c.json(await toPublicSourceConfig(bucketInstance, config));
});

app.put("/sources/:id", async (c) => {
  const bucketInstance = getRequestBucket(c);
  const id = c.req.param("id");
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "bad_request", message: "JSON body required." }, 400);
  const existing = await readSourceConfig(bucketInstance, id);
  if (!existing) return c.json({ error: "not_found", message: `No source with id ${id}.` }, 404);
  if (existing.type !== "google-drive") return c.json({ error: "forbidden", message: "This source is managed by the Medina instance." }, 403);
  const patch = {
    ...(typeof body.folderId === "string" ? { folderId: body.folderId } : {}),
    ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    ...(Array.isArray(body.extensions) && body.extensions.every((item) => typeof item === "string") ? { extensions: body.extensions } : {}),
  };
  try {
    getSourceDefinition(existing.type)?.validate({ ...existing, ...patch });
    const updated = await updateSourceConfig(bucketInstance, id, patch);
    return c.json(await toPublicSourceConfig(bucketInstance, updated));
  } catch (error) {
    return c.json({ error: "not_found", message: (error as Error).message }, 404);
  }
});

app.delete("/sources/:id", async (c) => {
  const bucketInstance = getRequestBucket(c);
  await deleteSourceConfig(bucketInstance, c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/sources/:id/sync", async (c) => {
  const bucketInstance = getRequestBucket(c);
  const id = c.req.param("id");
  const config = await readSourceConfig(bucketInstance, id);
  if (!config) return c.json({ error: "not_found", message: `No source with id ${id}.` }, 404);
  try {
    const result = await syncOneSourceById({ bucket: bucketInstance, id });
    return c.json(result);
  } catch (error) {
    return c.json({ error: "sync_failed", message: (error as Error).message }, 502);
  }
});

app.post("/sources/sync", async (c) => {
  const bucketInstance = getRequestBucket(c);
  const results = await syncAllSources({ bucket: bucketInstance });
  return c.json({ results });
});

app.get("/connect/google", async (c) => {
  const bucketInstance = getRequestBucket(c);
  const folderId = c.req.query("folderId")?.trim() || "";
  const sourceId = c.req.query("sourceId")?.trim() || "";
  if (sourceId) {
    const existing = await readSourceConfig(bucketInstance, sourceId);
    if (!existing || existing.type !== "google-drive") {
      return c.json({ error: "not_found", message: `No google-drive source with id ${sourceId}.` }, 404);
    }
  }
  const state = await createPendingState(bucketInstance, sourceId ? { sourceId } : folderId ? { folderId } : {});
  const redirectUri = new URL("/connect/google/callback", getRequestPublicBase(c)).toString();
  const url = new URL(buildAuthorizationUrl(redirectUri));
  url.searchParams.set("state", state);
  return c.redirect(url.toString(), 302);
});

app.get("/connect/google/callback", async (c) => {
  const bucketInstance = getRequestBucket(c);
  const code = c.req.query("code");
  const state = c.req.query("state") ?? "";
  const oauthError = c.req.query("error");

  const appBase = new URL("/app/sources", getRequestPublicBase(c)).toString();
  if (oauthError) return c.redirect(`${appBase}?gdrive=error&message=${encodeURIComponent(oauthError)}`, 302);
  if (!code || !state) return c.redirect(`${appBase}?gdrive=error&message=missing-params`, 302);

  const payload = await consumePendingState(bucketInstance, state);
  if (!payload) return c.redirect(`${appBase}?gdrive=error&message=invalid-state`, 302);

  const redirectUri = new URL("/connect/google/callback", getRequestPublicBase(c)).toString();
  try {
    const { refreshToken, scope } = await exchangeAuthorizationCode({ code, redirectUri });
    const accessToken = await refreshAccessToken(refreshToken);
    const account = await fetchUserEmail(accessToken, fetch);
    const connectedAt = new Date().toISOString();
    if (payload.sourceId) {
      const existing = await readSourceConfig(bucketInstance, payload.sourceId);
      if (!existing || existing.type !== "google-drive") {
        return c.redirect(`${appBase}?gdrive=error&message=source-not-found`, 302);
      }
      await updateSourceConfig(bucketInstance, payload.sourceId, { refreshToken, scope, account, connectedAt });
      return c.redirect(`${appBase}/${payload.sourceId}?gdrive=connected`, 302);
    }
    const config: SourceConfig = {
      id: crypto.randomUUID(),
      type: "google-drive",
      enabled: true,
      extensions: [".m4a", ".mp3", ".mp4", ".ogg", ".wav", ".webm"],
      refreshToken,
      scope,
      account,
      ...(payload.folderId ? { folderId: payload.folderId } : {}),
      connectedAt,
    };
    await createSource(bucketInstance, config);
    return c.redirect(`${appBase}/${config.id}?gdrive=connected`, 302);
  } catch (err) {
    const message = (err as Error).message;
    return c.redirect(`${appBase}?gdrive=error&message=${encodeURIComponent(message)}`, 302);
  }
});


app.get("/places.md", async (c) => {
  const { markdown } = await readPlaces(getRequestBucket(c));
  return c.text(markdown, 200, {
    "cache-control": "no-cache",
    "content-type": "text/markdown; charset=utf-8",
  });
});

app.put("/places.md", async (c) => {
  const body = await c.req.text();
  const places = parsePlacesMarkdown(body);
  await getRequestBucket(c).write(PLACES_KEY, body, { type: "text/markdown; charset=utf-8" });
  return c.json({ ok: true, places: places.length });
});

app.get("/:intervalId/gps.md", async (c) => {
  const intervalId = c.req.param("intervalId");
  if (!/^\d{9}$/.test(intervalId)) return c.notFound();

  const bucketInstance = getRequestBucket(c);
  const key = getGpsMarkdownKey(intervalId);
  await runResource(gpsDefinition, { bucket: bucketInstance, inputKey: intervalId });

  if (!(await bucketInstance.exists(key))) return c.notFound();
  return c.text(await bucketInstance.readText(key), 200, {
    "cache-control": "no-cache",
    "content-type": "text/markdown; charset=utf-8",
  });
});

app.get("/:intervalId/gps.json", async (c) => {
  const intervalId = c.req.param("intervalId");
  if (!/^\d{9}$/.test(intervalId)) return c.notFound();

  const bucketInstance = getRequestBucket(c);
  const key = getGpsJsonKey(intervalId);
  await runResource(gpsDefinition, { bucket: bucketInstance, inputKey: intervalId });

  if (!(await bucketInstance.exists(key))) return c.notFound();
  return c.json(await bucketInstance.readJson(key), 200, {
    "cache-control": "no-cache",
    "content-type": "application/json; charset=utf-8",
  });
});


app.get("/:intervalId/map.png", async (c) => {
  const intervalId = c.req.param("intervalId");
  if (!/^\d{9}$/.test(intervalId)) return c.notFound();

  const bucketInstance = getRequestBucket(c);
  await runResource(gpsDefinition, { bucket: bucketInstance, inputKey: intervalId });

  const key = getGpsMapImageKey(intervalId);
  await runResource(gpsMapImageDefinition, { bucket: bucketInstance, inputKey: intervalId });

  if (!(await bucketInstance.exists(key))) return c.notFound();
  return new Response(await bucketInstance.readArrayBuffer(key), {
    headers: {
      "cache-control": "no-cache",
      "content-type": "image/png",
    },
  });
});

app.get("/:intervalId/map.svg", async (c) => {
  const intervalId = c.req.param("intervalId");
  if (!/^\d{9}$/.test(intervalId)) return c.notFound();

  const bucketInstance = getRequestBucket(c);
  await runResource(gpsDefinition, { bucket: bucketInstance, inputKey: intervalId });
  await runResource(gpsMapImageDefinition, { bucket: bucketInstance, inputKey: intervalId });

  const key = getGpsMapSvgKey(intervalId);
  await runResource(gpsMapSvgDefinition, { bucket: bucketInstance, inputKey: intervalId });

  if (!(await bucketInstance.exists(key))) return c.notFound();
  return c.text(await bucketInstance.readText(key), 200, {
    "cache-control": "no-cache",
    "content-type": "image/svg+xml; charset=utf-8",
  });
});

app.get("/:intervalAsset", async (c) => {
  const bucketInstance = getRequestBucket(c);
  const intervalAsset = c.req.param("intervalAsset");
  const match = intervalAsset.match(/^(\d{5}|\d{7}|\d{9})\.(json|md)$/);
  if (!match) {
    return c.notFound();
  }

  if (c.req.method === "HEAD") {
    const intervalId = match[1]!;
    const key = getIntervalBucketKey(intervalId);
    return await createResourceHeadResponse(bucketInstance, key, async (bucketInstance) => {
      const plan = await intervalsDefinition.plan({
        bucket: bucketInstance,
        force: false,
        inputKey: intervalId,
        now: new Date(),
      });
      return {
        definition: intervalsDefinition,
        dependencies: await fingerprintDependencies(bucketInstance, plan.dependencies),
      };
    });
  }

  const intervalId = match[1]!;
  const assetType = match[2]!;
  const key = getIntervalBucketKey(intervalId);
  if (!(await bucketInstance.exists(key))) {
    await runResource(intervalsDefinition, { bucket: bucketInstance, inputKey: intervalId });
    if (!(await bucketInstance.exists(key))) {
      return c.notFound();
    }
  }

  const interval = await bucketInstance.readJson<unknown>(key);
  if (assetType === "md") {
    const value = interval as { coverageSeconds?: unknown; durationSeconds?: unknown; endTime?: unknown; id?: unknown; length?: unknown; recordings?: unknown; startTime?: unknown };
    const recordings = Array.isArray(value.recordings) ? value.recordings.length : 0;
    const coverageSeconds = typeof value.coverageSeconds === "number" ? value.coverageSeconds : 0;
    const lines = [
      `# Interval ${value.id ?? intervalId}`,
      "",
      `Range: ${value.startTime ?? "unknown"} – ${value.endTime ?? "unknown"}`,
      `Length: ${value.length ?? "unknown"}`,
      `Duration: ${value.durationSeconds ?? "unknown"} seconds`,
      `Coverage: ${coverageSeconds} seconds`,
      `Recordings: ${recordings}`,
      "",
      coverageSeconds > 0 ? "Data is available for this interval." : "No data.",
      "",
    ];
    return c.text(lines.join("\n"), 200, {
      "cache-control": "no-cache",
      "content-type": "text/markdown; charset=utf-8",
    });
  }

  return c.json(interval, 200, {
    "cache-control": "no-cache",
    "content-type": "application/json; charset=utf-8",
  });
});

app.post("/in", async (c) => {
  const contentType = c.req.header("content-type") ?? "";

  try {
    if (contentType.toLowerCase().includes("application/json")) {
      const bodyText = await c.req.text();
      const parsedBody = JSON.parse(bodyText) as { metadata?: Record<string, string>; type?: unknown };
      if (typeof parsedBody.type === "string" && ("metadata" in parsedBody || "type" in parsedBody)) {
        const destination = await createRequestIngestService(c).getIngestDestination({
          metadata: parsedBody.metadata,
          type: parsedBody.type,
        });
        const ingestId = destination.key.replace(/^in\//, "");
        return c.json({
          ...destination,
          ingestId,
        });
      }

      return c.json(await createRequestIngestService(c).storeIncomingIngest(new Request(c.req.url, {
        body: bodyText,
        headers: c.req.raw.headers,
        method: "POST",
      })));
    }

    return c.json(await createRequestIngestService(c).storeIncomingIngest(c.req.raw));
  } catch (error) {
    if (isIngestMetadataError(error)) {
      return c.json({ error: "bad_request", message: error.message }, 400);
    }
    console.error("ingest request failed", error);
    return c.json({ error: "server_error", message: "Ingest request failed." }, 500);
  }
});

app.put("/in/:ingestId", async (c) => {
  const ingestId = c.req.param("ingestId");
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-medina-ingest-key", `in/${ingestId}`);
  const stored = await createRequestIngestService(c).storeIncomingIngest(new Request(c.req.url, {
    method: "PUT",
    headers,
    body: c.req.raw.body,
  }));
  return c.json({
    ingestId,
    key: stored.key,
    metadata: stored.metadata,
  });
});

app.get("/chunks/:chunkId/:file", async (c) => {
  const key = `chunks/${c.req.param("chunkId")}/${c.req.param("file")}`;
  return (await createRecordingChunkResponse(getRequestBucket(c), key)) ?? c.notFound();
});

app.get("/recordings/:id/:file", async (c) => {
  const key = `recordings/${c.req.param("id")}/${c.req.param("file")}`;
  return (await createRecordingChunkResponse(getRequestBucket(c), key)) ?? c.notFound();
});

app.get("/recordings/:id/manifest/:file", async (c) => {
  const key = `recordings/${c.req.param("id")}/manifest/${c.req.param("file")}`;
  return (await createRecordingChunkResponse(getRequestBucket(c), key)) ?? c.notFound();
});

app.get("/podcast/episodes/:file", async (c) => {
  const key = `podcast/episodes/${c.req.param("file")}`;
  return (await createRecordingChunkResponse(getRequestBucket(c), key)) ?? c.notFound();
});

