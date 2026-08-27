import { Hono } from "hono";
import { stream } from "../lib/stream";
import { EasyVoice } from "../resources/EasyVoice";
import { Root, rootArtifact } from "../resources/Root";
import { Triage } from "../resources/Triage";
import { SourceIngest, SourceRefresh } from "../workflows/Source";

const app = new Hono<{ Bindings: Env }>();

app.get("/", async (c) => {
  const head = (await stream(c.env).state()).root.head;
  return c.json(head ? await rootArtifact(c.env, head.key) : { items: [] });
});

export { Stream } from "../lib/stream";
export { AssemblyAITranscript } from "../resources/AssemblyAITranscript";
export { Journal } from "../resources/Journal";
export { Root } from "../resources/Root";
export { Triage } from "../resources/Triage";
export { SourceIngest, SourceRefresh } from "../workflows/Source";
export default {
  fetch: app.fetch,
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(env.SOURCE_REFRESH.create({ params: EasyVoice(env) }));
  },
};
