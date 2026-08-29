export type Ingest = {
  id: string;
  key: string;
  filename: string;
  contentType: string;
  size: number;
  receivedAt: string;
  capturedAt: string;
  metadata: Record<string, string>;
};

type IngestAttributes = Omit<Ingest, "id" | "key" | "size" | "receivedAt" | "capturedAt"> & { id?: string; size?: number };

/**
 * When the content was recorded, as opposed to when Medina received it. Source
 * filenames carry `...YYYYMMDDThhmmss...`; the source's modified time and the
 * receipt time are progressively weaker fallbacks.
 */
export function captureTime(attributes: { filename: string; receivedAt: string; metadata: Record<string, string> }) {
  const stamp = attributes.filename.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (stamp) {
    const [, year, month, day, hour, minute, second] = stamp;
    return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  }
  return (attributes.metadata["x-medina-gdrive-modified-at"] ?? attributes.receivedAt).replace(/(\.\d+)?Z$/, "");
}

/** The calendar day a capture belongs to, in the capture's own local time. */
export function captureDay(capturedAt: string) {
  return capturedAt.slice(0, 10);
}

export async function createIngest(env: Env, body: ArrayBuffer | ReadableStream<Uint8Array>, attributes: IngestAttributes): Promise<Ingest> {
  const ingest: Ingest = {
    filename: attributes.filename,
    contentType: attributes.contentType,
    metadata: attributes.metadata,
    id: attributes.id ?? crypto.randomUUID(),
    key: "",
    size: attributes.size ?? 0,
    receivedAt: new Date().toISOString(),
    capturedAt: "",
  };
  ingest.capturedAt = captureTime(ingest);
  ingest.key = `in/${ingest.id}`;
  await env.ARTIFACTS.put(ingest.key, body, {
    httpMetadata: { contentType: ingest.contentType },
    customMetadata: { filename: ingest.filename, receivedAt: ingest.receivedAt, capturedAt: ingest.capturedAt },
  });
  return ingest;
}
