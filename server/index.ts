import { Hono } from "hono";
import { stream } from "../lib/stream";
import { triageArtifact } from "../resources/Triage";

const app = new Hono<{ Bindings: Env }>();

app.get("/", async (c) => {
  const last = (await stream(c.env).state()).ingests.last;
  return c.json(last ? await triageArtifact(c.env, last.triageKey) : { product: null, message: "No triaged ingest yet." });
});

app.get("/state", async (c) => c.json(await stream(c.env).state()));

app.get("/ingests/:id", async (c) => {
  const triage = await triageArtifact(c.env, `triage/${c.req.param("id")}.json`);
  return triage ? c.json(triage) : c.json({ error: "Unknown ingest." }, 404);
});

export { Stream } from "../lib/stream";
export { GdriveSource, GdriveIngest } from "../resources/GdriveSource";
export { Triage } from "../resources/Triage";
export default {
  fetch: app.fetch,
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(env.GDRIVE_SOURCE.create({ params: {} }));
  },
};
