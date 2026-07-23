import type { Stream, BucketCredentials } from "#lib/stream";
import { ensureStreamPreferences } from "#lib/stream";
import { isValidUser } from "#lib/user";
import { bucketForCredentials, getBucketForStream, toBucketId } from "./stream-bucket";

export type BucketHealthResult = {
  accessible: boolean;
  bucketId: string | null;
  credentialsId: string | number;
  error?: string;
};

export type StreamHealthResult = {
  buckets: BucketHealthResult[];
  healthy: boolean;
  host: string;
  validUsers: number;
};

export type StreamsHealthResult = {
  healthy: boolean;
  streams: StreamHealthResult[];
};

async function checkBucketHealth(credentials: BucketCredentials): Promise<BucketHealthResult> {
  const bucketId = toBucketId(credentials);
  if (process.env.MEDINA_SKIP_BUCKET_HEALTH === "true") {
    return { accessible: true, bucketId, credentialsId: credentials.id };
  }
  try {
    const bucket = bucketForCredentials(credentials);
    // Try to list the bucket with a small limit to verify connectivity
    await bucket.list({ prefix: "__health_check_nonexistent__" });
    return {
      accessible: true,
      bucketId,
      credentialsId: credentials.id,
    };
  } catch (error) {
    return {
      accessible: false,
      bucketId,
      credentialsId: credentials.id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function checkStreamHealth(stream: Stream): Promise<StreamHealthResult> {
  const bucketResults = await Promise.all(
    Object.values(stream.buckets).map((b) => checkBucketHealth(b))
  );
  const validUsers = stream.users.filter(isValidUser).length;
  return {
    buckets: bucketResults,
    healthy: bucketResults.some((r) => r.accessible) && validUsers > 0,
    host: stream.host,
    validUsers,
  };
}

export async function checkStreamsHealth(streams: Stream[]): Promise<StreamsHealthResult> {
  if (streams.length === 0) {
    return { healthy: false, streams: [] };
  }

  const streamResults = await Promise.all(streams.map(checkStreamHealth));
  return {
    healthy: streamResults.some((s) => s.healthy),
    streams: streamResults,
  };
}

export async function validateStreamsOnStartup(streams: Stream[]): Promise<void> {
  if (streams.length === 0) {
    console.error("[startup] FATAL: No streams configured.");
    process.exit(1);
  }

  console.log(`[startup] Validating ${streams.length} stream(s)...`);

  const health = await checkStreamsHealth(streams);

  for (const streamResult of health.streams) {
    const bucketSummary = streamResult.buckets
      .map((b) => {
        const status = b.accessible ? "✓" : "✗";
        const detail = b.error ? ` (${b.error})` : "";
        return `${status} ${b.bucketId ?? "unknown"}${detail}`;
      })
      .join(", ");
    
    const streamStatus = streamResult.healthy ? "✓" : "✗";
    console.log(`[startup] ${streamStatus} Stream ${streamResult.host}: ${bucketSummary}; users=${streamResult.validUsers}`);
  }

  const validCount = health.streams.filter((s) => s.healthy).length;
  if (validCount === 0) {
    console.error("[startup] FATAL: At least one stream must have >0 working buckets and >0 valid users. Server cannot start.");
    console.error("[startup] For local development, configure an S3-compatible bucket. Garage setup tips: docs/garage.md");
    console.error("[startup] Required default-template storage variables: S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.");
    process.exit(1);
  }

  try {
    if (process.env.MEDINA_SKIP_BUCKET_HEALTH !== "true") await Promise.all(streams.map(async (stream) => {
      const preferences = await ensureStreamPreferences(getBucketForStream(stream));
      stream.preferences = preferences;
      stream.name = preferences.name;
    }));
  } catch (error) {
    console.error(`[startup] FATAL: Could not load medina.conf: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  console.log(`[startup] ✓ ${validCount}/${streams.length} stream(s) have working buckets and users.`);

  // Store validated health state
  setStreamsHealthState(health);
}

// In-memory health state cache
let healthState: StreamsHealthResult | null = null;

export function setStreamsHealthState(state: StreamsHealthResult): void {
  healthState = state;
}

export function getStreamsHealthState(): StreamsHealthResult | null {
  return healthState;
}

export function getStreamHealthState(host: string): StreamHealthResult | null {
  if (!healthState) return null;
  return healthState.streams.find((s) => s.host === host) ?? null;
}

export function getBucketHealthForStream(stream: Stream): BucketHealthResult | null {
  const streamHealth = getStreamHealthState(stream.host);
  if (!streamHealth) return null;
  return streamHealth.buckets[0] ?? null;
}
