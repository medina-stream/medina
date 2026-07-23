import type { MiddlewareHandler } from "hono";
import {
  streamFromRequest,
  authorizeStreamRequest,
  streamMatchesHost,
  hostFromRequest,
  type BucketCredentials,
  type Stream,
} from "#lib/stream";
import type { Bucket } from "#lib/bucket";
import { userFromRequest, type CurrentUser } from "#lib/user";
import { getBucketHealthForStream } from "./bucket-health";
import { getBucketForStream, toBucketId } from "./stream-bucket";

export type MedinaRequestContext = {
  bucket: Bucket;
  bucketAccessible?: boolean;
  bucketCredentials: BucketCredentials;
  bucketId: string | null;
  currentUser: CurrentUser | null;
  site: {
    description?: string;
    host: string;
    name?: string;
  };
};

export function getMedinaContext(c: { get: (key: string) => unknown }): MedinaRequestContext {
  const context = c.get("medina");
  if (!context) throw new Error("No Medina request context is selected for this request.");
  return context as MedinaRequestContext;
}

export function getRequestBucket(c: { get: (key: string) => unknown }): Bucket {
  return getMedinaContext(c).bucket;
}

export function isStreamHostAllowed(host: string | null, streams: Stream[]): boolean {
  if (!host || streams.length === 0) return false;
  return streams.some((stream) => streamMatchesHost(stream, host));
}

const UNAUTHENTICATED_PATHS = new Set(["/", "/agent", "/agent.md", "/agents.md", "/api", "/api.md", "/API", "/API.md", "/docs", "/home.json", "/manifest.json", "/skill", "/skill.md", "/SKILL.md", "/status.json", "/sw.js"]);

export function registerPublicPaths(paths: string[]) {
  for (const path of paths) UNAUTHENTICATED_PATHS.add(path);
}

export function getPublicPaths(): ReadonlySet<string> {
  return UNAUTHENTICATED_PATHS;
}

export function createStreamMiddleware(streams: Stream[]): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const isUnauthenticatedPath = UNAUTHENTICATED_PATHS.has(url.pathname);
    const host = hostFromRequest(c.req.raw);

    if (!isStreamHostAllowed(host, streams)) {
      return c.json({ error: "not_found", message: "Host not recognized." }, 404);
    }

    const stream = streamFromRequest(c.req.raw, streams);
    if (!stream) {
      return c.json({ error: "not_found", message: "No stream is configured for this host." }, 404);
    }

    if (!isUnauthenticatedPath) {
      const decision = authorizeStreamRequest(stream, c.req.raw);
      if (!decision.allowed) {
        return c.json({
          error: decision.status === 403 ? "forbidden" : decision.status === 500 ? "server_error" : "unauthorized",
          message: decision.message ?? "Request is not authorized for this stream.",
        }, decision.status ?? 401);
      }
    }

    const credentials = stream.buckets.default ?? Object.values(stream.buckets)[0];
    if (!credentials) {
      return c.json({ error: "server_error", message: "Stream has no bucket configured." }, 500);
    }

    const bucketHealth = getBucketHealthForStream(stream);
    const context: MedinaRequestContext = {
      bucket: getBucketForStream(stream),
      bucketAccessible: bucketHealth?.accessible,
      bucketCredentials: credentials,
      bucketId: bucketHealth?.bucketId ?? toBucketId(credentials),
      currentUser: userFromRequest(c.req.raw, stream.users),
      site: {
        description: stream.description,
        host: stream.host,
        name: stream.name,
      },
    };
    c.set("medina", context);
    c.set("bucket", context.bucket);
    c.set("bucketId", context.bucketId);

    await next();
  };
}
