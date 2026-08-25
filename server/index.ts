import { Hono } from "hono";
import { stream } from "../lib/stream";
import { rootArtifact } from "../resources/Root";

const app = new Hono<{ Bindings: Env }>();

app.get("/", async (c) => {
  const head = (await stream(c.env).state()).root.head;
  return c.json(head ? await rootArtifact(c.env, head.key) : { items: [] });
});

export { Stream } from "../lib/stream";
export { GdriveSource, GdriveIngest } from "../resources/GdriveSource";
export { Root } from "../resources/Root";
export { Triage } from "../resources/Triage";
export default {
  fetch: app.fetch,
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(env.GDRIVE_SOURCE.create({ params: {} }));
  },
};
