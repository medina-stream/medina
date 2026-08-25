import { DurableObject } from "cloudflare:workers";

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

type StreamState = {
  ingests: { count: number; accepted: number; retained: number; last: IngestSummary | null };
};

function initialState(): StreamState {
  return { ingests: { count: 0, accepted: 0, retained: 0, last: null } };
}

export class Stream extends DurableObject<Env> {
  async state(): Promise<StreamState> {
    const stored = await this.ctx.storage.get<Partial<StreamState>>("state");
    return { ingests: { ...initialState().ingests, ...stored?.ingests } };
  }

  async commitTriage(summary: IngestSummary): Promise<IngestSummary> {
    const state = await this.state();
    const ingests = {
      count: state.ingests.count + 1,
      accepted: state.ingests.accepted + (summary.status === "accepted" ? 1 : 0),
      retained: state.ingests.retained + (summary.status === "retained" ? 1 : 0),
      last: summary,
    };
    await this.ctx.storage.put("state", { ingests });
    return summary;
  }
}

export function stream(env: Env) {
  return env.STREAM.getByName("default");
}
