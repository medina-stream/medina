import { Hono } from "hono";
import { createIngest } from "../lib/ingest";
import { stream } from "../lib/stream";
import { GdriveSource, ingestGdriveFile } from "../resources/GdriveSource";
import { startTriage, triageArtifact } from "../resources/Triage";

const app = new Hono<{ Bindings: Env }>();

function metadata(request: Request) {
  return Object.fromEntries([...request.headers].filter(([name]) => name.startsWith("x-medina-")));
}

app.get("/", async (c) => {
  const last = (await stream(c.env).state()).ingests.last;
  return c.json(last ? await triageArtifact(c.env, last.triageKey) : { product: null, message: "No triaged ingest yet." });
});

app.get("/state", async (c) => c.json(await stream(c.env).state()));

app.get("/sources/gdrive", (c) => c.json(GdriveSource));

app.post("/ingests", async (c) => {
  const body = await c.req.raw.arrayBuffer();
  if (!body.byteLength) return c.json({ error: "ingest body is required" }, 400);
  const ingest = await createIngest(c.env, body, {
    filename: c.req.header("x-medina-filename") ?? "upload.bin",
    contentType: c.req.header("content-type") ?? "application/octet-stream",
    metadata: metadata(c.req.raw),
  });
  const workflow = await startTriage(c.env, ingest);
  return c.json({ id: workflow.id, key: ingest.key, status: "triage-pending" }, 202);
});

app.post("/sources/gdrive", async (c) => {
  const body = await c.req.raw.arrayBuffer();
  if (!body.byteLength) return c.json({ error: "ingest body is required" }, 400);
  return c.json(await ingestGdriveFile(c.env, body, {
    filename: c.req.header("x-medina-filename") ?? "upload.bin",
    contentType: c.req.header("content-type") ?? "application/octet-stream",
    metadata: { ...metadata(c.req.raw), "x-medina-source": "gdrive" },
  }), 202);
});

app.get("/ingests/:id", async (c) => {
  const triage = await triageArtifact(c.env, `triage/${c.req.param("id")}.json`);
  return triage ? c.json(triage) : c.json({ error: "Unknown ingest." }, 404);
});

app.get("/workflows/:id", async (c) => c.json(await (await c.env.TRIAGE.get(c.req.param("id"))).status()));

export { Stream } from "../lib/stream";
export { Triage } from "../resources/Triage";
export default app;
