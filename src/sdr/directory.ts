import type { Hono } from "hono";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { readJson, writeJson } from "../lib/artifact";
import { type ArtifactHead, type SourceState, stream } from "../stream";

const sourceName = "directory";
const defaultDirectory = "/home/exedev/medina-data/google-drive-rethink";

export type DirectoryEntry = { path: string; size: number; modifiedAt: string };
type DirectoryRefresh = {
  id: string;
  source: string;
  directory: string;
  refreshEverySeconds: number;
  files: DirectoryEntry[];
};
export type DirectoryArtifact = DirectoryRefresh & {
  refreshedAt: string;
  filesCount: number;
  totalBytes: number;
};

function defaultSource(): SourceState {
  return { directory: defaultDirectory, refreshEverySeconds: 3600, head: null, lastRefreshedAt: null };
}

export async function directorySource(env: Env) {
  const current = await stream(env).source(sourceName);
  return current ?? stream(env).configureSource(sourceName, defaultSource());
}

function validConfig(body: { directory?: unknown; refreshEverySeconds?: unknown }): body is { directory: string; refreshEverySeconds: number } {
  return typeof body.directory === "string" && typeof body.refreshEverySeconds === "number" && Number.isInteger(body.refreshEverySeconds) && body.refreshEverySeconds > 0;
}

function validEntries(value: unknown): value is DirectoryEntry[] {
  return Array.isArray(value) && value.every((file) => typeof file === "object" && file !== null && typeof file.path === "string" && typeof file.size === "number" && typeof file.modifiedAt === "string");
}

export class DirectoryRefreshWorkflow extends WorkflowEntrypoint<Env, DirectoryRefresh> {
  async run(event: WorkflowEvent<DirectoryRefresh>, step: WorkflowStep) {
    const artifact = await step.do("condense directory", async () => {
      const files = event.payload.files
        .filter((file) => file.path && file.size >= 0 && !file.path.startsWith("/") && !file.path.includes(".."))
        .sort((a, b) => a.path.localeCompare(b.path));
      return {
        ...event.payload,
        refreshedAt: new Date().toISOString(),
        files,
        filesCount: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      } satisfies DirectoryArtifact;
    });
    const key = `artifacts/${event.payload.source}/${event.payload.id}.json`;
    await step.do("write artifact", async () => {
      await writeJson(this.env.ARTIFACTS, key, artifact);
      return { key };
    });
    return step.do("publish artifact", async () => {
      const source = await stream(this.env).publishSource(event.payload.source, { key, refreshId: event.payload.id }, artifact.refreshedAt);
      return { head: source.head };
    });
  }
}

export async function directoryArtifact(env: Env, head: ArtifactHead) {
  return readJson<DirectoryArtifact>(env.ARTIFACTS, head.key);
}

export function mountDirectorySdr(app: Hono<{ Bindings: Env }>) {
  app.get(`/sources/${sourceName}`, async (c) => c.json(await directorySource(c.env)));

  app.put(`/sources/${sourceName}`, async (c) => {
    const body = await c.req.json<{ directory?: unknown; refreshEverySeconds?: unknown }>();
    if (!validConfig(body)) return c.json({ error: "directory and positive integer refreshEverySeconds are required" }, 400);
    const source = { ...(await directorySource(c.env)), directory: body.directory, refreshEverySeconds: body.refreshEverySeconds };
    return c.json(await stream(c.env).configureSource(sourceName, source));
  });

  app.post(`/sources/${sourceName}/refresh`, async (c) => {
    const body = await c.req.json<{ files?: unknown }>();
    if (!validEntries(body.files)) return c.json({ error: "files must be a directory entry array" }, 400);
    const source = await directorySource(c.env);
    const refresh: DirectoryRefresh = {
      id: crypto.randomUUID(),
      source: sourceName,
      directory: source.directory,
      refreshEverySeconds: source.refreshEverySeconds,
      files: body.files,
    };
    const instance = await c.env.DIRECTORY_REFRESH.create({ id: refresh.id, params: refresh });
    return c.json({ id: instance.id }, 202);
  });
}
