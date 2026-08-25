import { DurableObject } from "cloudflare:workers";

export type ArtifactHead = { key: string; refreshId: string };
export type SourceState = {
  directory: string;
  refreshEverySeconds: number;
  head: ArtifactHead | null;
  lastRefreshedAt: string | null;
};
export type IngestSummary = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  hash: string;
  triageKey: string;
  status: "accepted" | "retained";
  triagedAt: string;
};
export type StreamState = {
  sources: Record<string, SourceState>;
  ingests: { count: number; accepted: number; retained: number; last: IngestSummary | null };
};

function defaultIngests() {
  return { count: 0, accepted: 0, retained: 0, last: null };
}

export class Stream extends DurableObject<Env> {
  async state(): Promise<StreamState> {
    const stored = await this.ctx.storage.get<Partial<StreamState>>("state");
    return { sources: stored?.sources ?? {}, ingests: { ...defaultIngests(), ...stored?.ingests } };
  }

  async source(name: string): Promise<SourceState | null> {
    return (await this.state()).sources[name] ?? null;
  }

  async configureSource(name: string, source: SourceState): Promise<SourceState> {
    const state = await this.state();
    await this.ctx.storage.put("state", { ...state, sources: { ...state.sources, [name]: source } });
    return source;
  }

  async publishSource(name: string, head: ArtifactHead, refreshedAt: string): Promise<SourceState> {
    const state = await this.state();
    const source = state.sources[name];
    if (!source) throw new Error(`Unknown source ${name}`);
    const next = { ...source, head, lastRefreshedAt: refreshedAt };
    await this.ctx.storage.put("state", { ...state, sources: { ...state.sources, [name]: next } });
    return next;
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

export function stream(env: Env) {
  return env.STREAM.getByName("default");
}
