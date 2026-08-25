export type Ingest = {
  id: string;
  key: string;
  filename: string;
  contentType: string;
  size: number;
  receivedAt: string;
  metadata: Record<string, string>;
};

type IngestAttributes = Omit<Ingest, "id" | "key" | "size" | "receivedAt">;

export async function createIngest(env: Env, body: ArrayBuffer, attributes: IngestAttributes): Promise<Ingest> {
  const ingest: Ingest = {
    ...attributes,
    id: crypto.randomUUID(),
    key: "",
    size: body.byteLength,
    receivedAt: new Date().toISOString(),
  };
  ingest.key = `in/${ingest.id}`;
  await env.ARTIFACTS.put(ingest.key, body, {
    httpMetadata: { contentType: ingest.contentType },
    customMetadata: { filename: ingest.filename, receivedAt: ingest.receivedAt },
  });
  return ingest;
}
