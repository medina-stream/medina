import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

type Input = {
  id: string;
  text: string;
};

type Artifact = {
  inputId: string;
  text: string;
  words: number;
  uniqueWords: string[];
};

type StreamState = {
  inputs: number;
  head: { key: string; inputId: string } | null;
};

export class Stream extends DurableObject<Env> {
  async state(): Promise<StreamState> {
    return (await this.ctx.storage.get<StreamState>("state")) ?? { inputs: 0, head: null };
  }

  async publish(head: StreamState["head"]): Promise<StreamState> {
    const state = await this.state();
    const next = { inputs: state.inputs + 1, head };
    await this.ctx.storage.put("state", next);
    return next;
  }
}

export class IngestWorkflow extends WorkflowEntrypoint<Env, Input> {
  async run(event: WorkflowEvent<Input>, step: WorkflowStep) {
    const artifact = await step.do("condense input", async () => {
      const text = event.payload.text.trim().replace(/\s+/g, " ");
      const words = text ? text.split(" ") : [];
      return {
        inputId: event.payload.id,
        text,
        words: words.length,
        uniqueWords: [...new Set(words.map((word) => word.toLowerCase()))].sort(),
      } satisfies Artifact;
    });

    const key = `artifacts/${event.payload.id}.json`;
    await step.do("write artifact", async () => {
      await this.env.ARTIFACTS.put(key, JSON.stringify(artifact), {
        httpMetadata: { contentType: "application/json" },
      });
      return { key };
    });

    return step.do("publish artifact", async () => {
      const state = await this.env.STREAM.getByName("default").publish({
        key,
        inputId: event.payload.id,
      });
      return { head: state.head };
    });
  }
}

function stream(env: Env) {
  return env.STREAM.getByName("default");
}

async function product(env: Env): Promise<Response> {
  const state = await stream(env).state();
  if (!state.head) return Response.json({ product: null, message: "No artifact yet." });

  const artifact = await env.ARTIFACTS.get(state.head.key);
  if (!artifact) return Response.json({ product: null, message: "Artifact is missing." }, { status: 500 });
  return Response.json(await artifact.json<Artifact>());
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") return product(env);
    if (request.method === "GET" && url.pathname === "/state") return Response.json(await stream(env).state());

    if (request.method === "POST" && url.pathname === "/inputs") {
      const body = await request.json<{ text?: unknown }>();
      if (typeof body.text !== "string") return Response.json({ error: "text must be a string" }, { status: 400 });

      const input = { id: crypto.randomUUID(), text: body.text };
      const instance = await env.INGEST.create({ id: input.id, params: input });
      return Response.json({ id: instance.id }, { status: 202 });
    }

    const workflow = url.pathname.match(/^\/workflows\/([^/]+)$/);
    if (request.method === "GET" && workflow) {
      const instance = await env.INGEST.get(decodeURIComponent(workflow[1]));
      return Response.json(await instance.status());
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
