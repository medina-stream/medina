export type Ingest = {
  id: string;
  key: string;
  filename: string;
  contentType: string;
  size: number;
  receivedAt: string;
  metadata: Record<string, string>;
};

type IngestAttributes = Omit<Ingest, "id" | "key" | "size" | "receivedAt"> & { id?: string; size?: number };

export async function createIngest(env: Env, body: ArrayBuffer | ReadableStream<Uint8Array>, attributes: IngestAttributes): Promise<Ingest> {
  const ingest: Ingest = {
    filename: attributes.filename,
    contentType: attributes.contentType,
    metadata: attributes.metadata,
    id: attributes.id ?? crypto.randomUUID(),
    key: "",
    size: attributes.size ?? 0,
    receivedAt: new Date().toISOString(),
  };
  ingest.key = `in/${ingest.id}`;
  await env.ARTIFACTS.put(ingest.key, body, {
    httpMetadata: { contentType: ingest.contentType },
    customMetadata: { filename: ingest.filename, receivedAt: ingest.receivedAt },
  });
  return ingest;
}
