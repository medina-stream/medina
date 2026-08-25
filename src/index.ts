import { Hono } from "hono";
import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

const defaultDirectory = "/home/exedev/medina-data/google-drive-rethink";
const directorySourceName = "directory";

type DirectoryEntry = { path: string; size: number; modifiedAt: string };
type ArtifactHead = { key: string; refreshId: string };
type SourceState = {
  directory: string;
  refreshEverySeconds: number;
  head: ArtifactHead | null;
  lastRefreshedAt: string | null;
};
type IngestSummary = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  hash: string;
  triageKey: string;
  status: "accepted" | "retained";
  triagedAt: string;
};
type StreamState = {
  sources: Record<string, SourceState>;
  ingests: { count: number; accepted: number; retained: number; last: IngestSummary | null };
};
type DirectoryRefresh = {
  id: string;
  source: string;
  directory: string;
  refreshEverySeconds: number;
  files: DirectoryEntry[];
};
type DirectoryArtifact = DirectoryRefresh & {
  refreshedAt: string;
  filesCount: number;
  totalBytes: number;
};
type Ingest = {
  id: string;
  key: string;
  filename: string;
  contentType: string;
  size: number;
  receivedAt: string;
  metadata: Record<string, string>;
};
type Triage = IngestSummary & {
  receivedAt: string;
  detectedType: string;
  signals: string[];
  metadata: Record<string, string>;
};

function defaultSource(): SourceState {
  return { directory: defaultDirectory, refreshEverySeconds: 3600, head: null, lastRefreshedAt: null };
}

function normalizeSource(source: Partial<SourceState> | undefined): SourceState {
  return { ...defaultSource(), ...source };
}

function defaultIngests() {
  return { count: 0, accepted: 0, retained: 0, last: null };
}

export class Stream extends DurableObject<Env> {
  async state(): Promise<StreamState> {
    const stored = await this.ctx.storage.get<Partial<StreamState>>("state");
    return {
      sources: { ...stored?.sources, [directorySourceName]: normalizeSource(stored?.sources?.[directorySourceName]) },
      ingests: { ...defaultIngests(), ...stored?.ingests },
    };
  }

  async source(name: string): Promise<SourceState | null> {
    return (await this.state()).sources[name] ?? null;
  }

  async configureSource(name: string, directory: string, refreshEverySeconds: number): Promise<SourceState> {
    const state = await this.state();
    const source = { ...normalizeSource(state.sources[name]), directory, refreshEverySeconds };
    await this.ctx.storage.put("state", { ...state, sources: { ...state.sources, [name]: source } });
    return source;
  }

  async publishSource(name: string, head: ArtifactHead, refreshedAt: string): Promise<SourceState> {
    const state = await this.state();
    const source = { ...normalizeSource(state.sources[name]), head, lastRefreshedAt: refreshedAt };
    await this.ctx.storage.put("state", { ...state, sources: { ...state.sources, [name]: source } });
    return source;
  }

  async commitTriage(summary: IngestSummary): Promise<IngestSummary> {
    const state = await this.state();
    const ingests = {
      count: state.ingests.count + 1,
      accepted: state.ingests.accepted + (summary.status === "accepted" ? 1 : 0),
      retained: state.ingests.retained + (summary.status === "retained" ? 1 : 0),
      last: summary,
    };
    await this.ctx.storage.put("state", { ...state, ingests });
    return summary;
  }
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
      await this.env.ARTIFACTS.put(key, JSON.stringify(artifact), { httpMetadata: { contentType: "application/json" } });
      return { key };
    });
    return step.do("publish artifact", async () => {
      const source = await this.env.STREAM.getByName("default").publishSource(
        event.payload.source,
        { key, refreshId: event.payload.id },
        artifact.refreshedAt,
      );
      return { head: source.head };
    });
  }
}

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function detectType(bytes: Uint8Array, declared: string) {
  const text = new TextDecoder().decode(bytes.slice(0, 32));
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WAVE") return "audio/wav";
  if (text.startsWith("ID3")) return "audio/mpeg";
  if (text.startsWith("OggS")) return "audio/ogg";
  if (text.startsWith("\u0089PNG")) return "image/png";
  if (text.startsWith("%PDF")) return "application/pdf";
  if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) return "application/json";
  if (bytes.slice(4, 8).every((byte, index) => "ftyp".charCodeAt(index) === byte)) return "audio/mp4";
  return declared || "application/octet-stream";
}

function triageSignals(ingest: Ingest, detectedType: string, hash: string) {
  const signals: string[] = [];
  if (ingest.size === 0) signals.push("empty");
  if (/\.(exe|dll|bat|cmd|sh|ps1)$/i.test(ingest.filename)) signals.push("executable-name");
  if (ingest.filename.includes("..") || /[\\/]/.test(ingest.filename)) signals.push("unsafe-filename");
  if (ingest.contentType && ingest.contentType !== "application/octet-stream" && ingest.contentType !== detectedType) {
    signals.push("declared-type-mismatch");
  }
  if (/^0+$/.test(hash)) signals.push("impossible-hash");
  return signals;
}

export class IngestWorkflow extends WorkflowEntrypoint<Env, Ingest> {
  async run(event: WorkflowEvent<Ingest>, step: WorkflowStep) {
    const triage = await step.do("triage ingest", async () => {
      const object = await this.env.ARTIFACTS.get(event.payload.key);
      if (!object) throw new Error(`Missing ingest artifact ${event.payload.key}`);
      const body = await object.arrayBuffer();
      const hash = hex(await crypto.subtle.digest("SHA-256", body));
      const detectedType = detectType(new Uint8Array(body), event.payload.contentType);
      const signals = triageSignals(event.payload, detectedType, hash);
      const status = signals.includes("executable-name") || signals.includes("unsafe-filename") ? "retained" : "accepted";
      const triagedAt = new Date().toISOString();
      const triageKey = `triage/${event.payload.id}.json`;
      const result: Triage = {
        id: event.payload.id,
        filename: event.payload.filename,
        contentType: event.payload.contentType,
        size: event.payload.size,
        hash,
        triageKey,
        status,
        triagedAt,
        receivedAt: event.payload.receivedAt,
        detectedType,
        signals,
        metadata: event.payload.metadata,
      };
      await this.env.ARTIFACTS.put(triageKey, JSON.stringify(result), { httpMetadata: { contentType: "application/json" } });
      return result;
    });
    return step.do("route triage", async () => {
      const summary = await this.env.STREAM.getByName("default").commitTriage(triage);
      return { id: summary.id, status: summary.status, triageKey: summary.triageKey };
    });
  }
}

function stream(env: Env) {
  return env.STREAM.getByName("default");
}

async function jsonArtifact<T>(env: Env, key: string) {
  const object = await env.ARTIFACTS.get(key);
  return object ? object.json<T>() : null;
}

function sourceConfig(body: { directory?: unknown; refreshEverySeconds?: unknown }): body is { directory: string; refreshEverySeconds: number } {
  return typeof body.directory === "string" && typeof body.refreshEverySeconds === "number" && Number.isInteger(body.refreshEverySeconds) && body.refreshEverySeconds > 0;
}

function directoryEntries(value: unknown): value is DirectoryEntry[] {
  return Array.isArray(value) && value.every((file) => typeof file === "object" && file !== null && typeof file.path === "string" && typeof file.size === "number" && typeof file.modifiedAt === "string");
}

function ingestMetadata(request: Request) {
  return Object.fromEntries([...request.headers].filter(([name]) => name.startsWith("x-medina-")));
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", async (c) => {
  const state = await stream(c.env).state();
  if (state.ingests.last) return c.json(await jsonArtifact<Triage>(c.env, state.ingests.last.triageKey));
  const source = state.sources[directorySourceName];
  if (!source.head) return c.json({ product: null, message: "No artifact yet." });
  return c.json(await jsonArtifact<DirectoryArtifact>(c.env, source.head.key));
});

app.get("/state", async (c) => c.json(await stream(c.env).state()));
app.get(`/sources/${directorySourceName}`, async (c) => c.json(await stream(c.env).source(directorySourceName)));

app.put(`/sources/${directorySourceName}`, async (c) => {
  const body = await c.req.json<{ directory?: unknown; refreshEverySeconds?: unknown }>();
  if (!sourceConfig(body)) return c.json({ error: "directory and positive integer refreshEverySeconds are required" }, 400);
  return c.json(await stream(c.env).configureSource(directorySourceName, body.directory, body.refreshEverySeconds));
});

app.post(`/sources/${directorySourceName}/refresh`, async (c) => {
  const body = await c.req.json<{ files?: unknown }>();
  if (!directoryEntries(body.files)) return c.json({ error: "files must be a directory entry array" }, 400);
  const source = await stream(c.env).source(directorySourceName);
  if (!source) return c.json({ error: "Unknown source." }, 404);
  const refresh: DirectoryRefresh = {
    id: crypto.randomUUID(),
    source: directorySourceName,
    directory: source.directory,
    refreshEverySeconds: source.refreshEverySeconds,
    files: body.files,
  };
  const instance = await c.env.DIRECTORY_REFRESH.create({ id: refresh.id, params: refresh });
  return c.json({ id: instance.id }, 202);
});

app.post("/ingests", async (c) => {
  const body = await c.req.raw.arrayBuffer();
  if (!body.byteLength) return c.json({ error: "ingest body is required" }, 400);
  const ingest: Ingest = {
    id: crypto.randomUUID(),
    key: "",
    filename: c.req.header("x-medina-filename") ?? "upload.bin",
    contentType: c.req.header("content-type") ?? "application/octet-stream",
    size: body.byteLength,
    receivedAt: new Date().toISOString(),
    metadata: ingestMetadata(c.req.raw),
  };
  ingest.key = `in/${ingest.id}`;
  await c.env.ARTIFACTS.put(ingest.key, body, {
    httpMetadata: { contentType: ingest.contentType },
    customMetadata: { filename: ingest.filename, receivedAt: ingest.receivedAt },
  });
  const instance = await c.env.INGEST.create({ id: ingest.id, params: ingest });
  return c.json({ id: instance.id, key: ingest.key, status: "triage-pending" }, 202);
});

app.get("/ingests/:id", async (c) => {
  const triage = await jsonArtifact<Triage>(c.env, `triage/${c.req.param("id")}.json`);
  return triage ? c.json(triage) : c.json({ error: "Unknown ingest." }, 404);
});

app.get("/workflows/:id", async (c) => {
  const id = c.req.param("id");
  const ingest = await c.env.INGEST.get(id);
  const status = await ingest.status();
  if (status.status !== "unknown") return c.json(status);
  const refresh = await c.env.DIRECTORY_REFRESH.get(id);
  return c.json(await refresh.status());
});

export default app;
