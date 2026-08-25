import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

type MaterializeParams = {
  resource: string;
};

type StreamState = {
  materializations: number;
};

export class Stream extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/state") return new Response("Not found", { status: 404 });

    const state = (await this.ctx.storage.get<StreamState>("state")) ?? { materializations: 0 };
    return Response.json(state);
  }

  async materialized(resource: string): Promise<StreamState> {
    const state = (await this.ctx.storage.get<StreamState>("state")) ?? { materializations: 0 };
    const next = { materializations: state.materializations + 1 };
    await this.ctx.storage.put("state", next);
    return next;
  }
}

export class MaterializeWorkflow extends WorkflowEntrypoint<Env, MaterializeParams> {
  async run(event: WorkflowEvent<MaterializeParams>, step: WorkflowStep) {
    return step.do(`materialize ${event.payload.resource}`, async () => {
      const stream = this.env.STREAM.getByName("default");
      const state = await stream.materialized(event.payload.resource);
      return { materializations: state.materializations };
    });
  }
}

function stream(env: Env) {
  return env.STREAM.getByName("default");
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        name: "Medina Workers rethink",
        endpoints: ["GET /state", "POST /materialize/:resource", "GET /workflows/:id"],
      });
    }

    if (request.method === "GET" && url.pathname === "/state") {
      return stream(env).fetch("https://stream/state");
    }

    const materialize = url.pathname.match(/^\/materialize\/([^/]+)$/);
    if (request.method === "POST" && materialize) {
      const resource = decodeURIComponent(materialize[1]);
      const instance = await env.MATERIALIZE.create({ params: { resource } });
      return Response.json({ id: instance.id, resource }, { status: 202 });
    }

    const workflow = url.pathname.match(/^\/workflows\/([^/]+)$/);
    if (request.method === "GET" && workflow) {
      const instance = await env.MATERIALIZE.get(decodeURIComponent(workflow[1]));
      return Response.json(await instance.status());
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
