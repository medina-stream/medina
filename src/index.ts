import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

const defaultDirectory = "/home/exedev/medina-data/google-drive";
const sourceName = "directory";

type DirectoryEntry = {
  path: string;
  size: number;
  modifiedAt: string;
};

type SourceState = {
  directory: string;
  refreshEverySeconds: number;
  head: { key: string; refreshId: string } | null;
  lastRefreshedAt: string | null;
};

type StreamState = {
  sources: Record<string, SourceState>;
};

type DirectoryRefresh = {
  id: string;
  source: string;
  directory: string;
  refreshEverySeconds: number;
  files: DirectoryEntry[];
};

type DirectoryArtifact = {
  source: string;
  directory: string;
  refreshEverySeconds: number;
  refreshedAt: string;
  files: DirectoryEntry[];
  filesCount: number;
  totalBytes: number;
};

function defaultSource(): SourceState {
  return {
    directory: defaultDirectory,
    refreshEverySeconds: 3600,
    head: null,
    lastRefreshedAt: null,
  };
}

function normalizeSource(source: Partial<SourceState> | undefined): SourceState {
  return { ...defaultSource(), ...source };
}

export class Stream extends DurableObject<Env> {
  async state(): Promise<StreamState> {
    const stored = await this.ctx.storage.get<Partial<StreamState>>("state");
    return { sources: { ...stored?.sources, [sourceName]: normalizeSource(stored?.sources?.[sourceName]) } };
  }

  async source(name: string): Promise<SourceState | null> {
    return (await this.state()).sources[name] ?? null;
  }

  async configureSource(name: string, directory: string, refreshEverySeconds: number): Promise<SourceState> {
    const state = await this.state();
    const source = { ...normalizeSource(state.sources[name]), directory, refreshEverySeconds };
    await this.ctx.storage.put("state", { sources: { ...state.sources, [name]: source } });
    return source;
  }

  async publishSource(name: string, head: SourceState["head"], refreshedAt: string): Promise<SourceState> {
    const state = await this.state();
    const source = { ...normalizeSource(state.sources[name]), head, lastRefreshedAt: refreshedAt };
    await this.ctx.storage.put("state", { sources: { ...state.sources, [name]: source } });
    return source;
  }
}

export class DirectoryRefreshWorkflow extends WorkflowEntrypoint<Env, DirectoryRefresh> {
  async run(event: WorkflowEvent<DirectoryRefresh>, step: WorkflowStep) {
    const artifact = await step.do("condense directory", async () => {
      const files = event.payload.files
        .filter((file) => file.path && file.size >= 0 && !file.path.startsWith("/") && !file.path.includes(".."))
        .sort((a, b) => a.path.localeCompare(b.path));
      return {
        source: event.payload.source,
        directory: event.payload.directory,
        refreshEverySeconds: event.payload.refreshEverySeconds,
        refreshedAt: new Date().toISOString(),
        files,
        filesCount: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      } satisfies DirectoryArtifact;
    });

    const key = `artifacts/${event.payload.source}/${event.payload.id}.json`;
    await step.do("write artifact", async () => {
      await this.env.ARTIFACTS.put(key, JSON.stringify(artifact), {
        httpMetadata: { contentType: "application/json" },
      });
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

function stream(env: Env) {
  return env.STREAM.getByName("default");
}

async function sourceProduct(env: Env, name: string): Promise<Response> {
  const source = await stream(env).source(name);
  if (!source) return Response.json({ error: "Unknown source." }, { status: 404 });
  if (!source.head) return Response.json({ product: null, source, message: "No directory artifact yet." });

  const artifact = await env.ARTIFACTS.get(source.head.key);
  if (!artifact) return Response.json({ product: null, message: "Artifact is missing." }, { status: 500 });
  return Response.json(await artifact.json<DirectoryArtifact>());
}

function validSourceConfig(body: { directory?: unknown; refreshEverySeconds?: unknown }): body is {
  directory: string;
  refreshEverySeconds: number;
} {
  return (
    typeof body.directory === "string" &&
    typeof body.refreshEverySeconds === "number" &&
    Number.isInteger(body.refreshEverySeconds) &&
    body.refreshEverySeconds > 0
  );
}

function validEntries(value: unknown): value is DirectoryEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (file) =>
        typeof file === "object" &&
        file !== null &&
        typeof file.path === "string" &&
        typeof file.size === "number" &&
        typeof file.modifiedAt === "string",
    )
  );
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") return sourceProduct(env, sourceName);
    if (request.method === "GET" && url.pathname === "/state") return Response.json(await stream(env).state());
    if (request.method === "GET" && url.pathname === `/sources/${sourceName}`) {
      return Response.json(await stream(env).source(sourceName));
    }

    if (request.method === "PUT" && url.pathname === `/sources/${sourceName}`) {
      const body = await request.json<{ directory?: unknown; refreshEverySeconds?: unknown }>();
      if (!validSourceConfig(body)) {
        return Response.json({ error: "directory and positive integer refreshEverySeconds are required" }, { status: 400 });
      }
      return Response.json(await stream(env).configureSource(sourceName, body.directory, body.refreshEverySeconds));
    }

    if (request.method === "POST" && url.pathname === `/sources/${sourceName}/refresh`) {
      const body = await request.json<{ files?: unknown }>();
      if (!validEntries(body.files)) return Response.json({ error: "files must be a directory entry array" }, { status: 400 });

      const source = await stream(env).source(sourceName);
      if (!source) return Response.json({ error: "Unknown source." }, { status: 404 });
      const refresh = {
        id: crypto.randomUUID(),
        source: sourceName,
        directory: source.directory,
        refreshEverySeconds: source.refreshEverySeconds,
        files: body.files,
      };
      const instance = await env.DIRECTORY_REFRESH.create({ id: refresh.id, params: refresh });
      return Response.json({ id: instance.id }, { status: 202 });
    }

    const workflow = url.pathname.match(/^\/workflows\/([^/]+)$/);
    if (request.method === "GET" && workflow) {
      const instance = await env.DIRECTORY_REFRESH.get(decodeURIComponent(workflow[1]));
      return Response.json(await instance.status());
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
