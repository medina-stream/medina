import { Hono } from "hono";
import { directoryArtifact, directorySource, mountDirectorySdr } from "./sdr/directory";
import { mountTriageSdr, triageArtifact } from "./sdr/triage";
import { stream } from "./stream";

const app = new Hono<{ Bindings: Env }>();

app.get("/", async (c) => {
  const state = await stream(c.env).state();
  if (state.ingests.last) return c.json(await triageArtifact(c.env, state.ingests.last.triageKey));
  const source = await directorySource(c.env);
  if (!source.head) return c.json({ product: null, message: "No artifact yet." });
  return c.json(await directoryArtifact(c.env, source.head));
});

app.get("/state", async (c) => c.json(await stream(c.env).state()));

mountDirectorySdr(app);
mountTriageSdr(app);

app.get("/workflows/:id", async (c) => {
  const id = c.req.param("id");
  const ingest = await c.env.INGEST.get(id);
  const status = await ingest.status();
  if (status.status !== "unknown") return c.json(status);
  const refresh = await c.env.DIRECTORY_REFRESH.get(id);
  return c.json(await refresh.status());
});

export { DirectoryRefreshWorkflow } from "./sdr/directory";
export { IngestWorkflow } from "./sdr/triage";
export { Stream } from "./stream";
export default app;
