// Basic medina.config.ts template: one stream with one S3-compatible bucket and one default user.
// Copy to ./medina.config.ts or let scripts/ensure-streams-config.ts do it.

import type { Stream } from "./lib/stream";
import { userFromEnv } from "./lib/user";

function firstEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
}

function requireEnv(name: string) {
  const value = firstEnv(name);
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

export const streams: Stream[] = [
  {
    host: new URL(requireEnv("MEDINA_ROOT")).host.split(":", 1)[0]!,
    hostAliases: (process.env.MEDINA_HOST_ALIASES ?? "").split(",").map((host) => host.trim()).filter(Boolean),
    description: process.env.MEDINA_STREAM_DESCRIPTION,
    buckets: {
      default: {
        bucketName: requireEnv("S3_BUCKET"),
        endpoint: firstEnv("S3_ENDPOINT"),
        region: firstEnv("S3_REGION") ?? "auto",
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        sessionToken: process.env.S3_SESSION_TOKEN,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true" || undefined,
      },
    },
    users: [userFromEnv()],
  },
];
