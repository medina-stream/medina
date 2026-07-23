export interface Segment {
  id: string;
  audioUrl: string;
}

export interface Note {
  id: string;
  segmentId: string;
  type: string;
  message: string;
  start: number;
}

export interface RecordingChunk {
  contentType: string;
  durationSeconds: number | null;
  format: string;
  key: string;
  ordinal: number;
  url?: string;
}

export interface RecordingPlaylist {
  chunks: RecordingChunk[];
  format: string;
}

export interface Recording {
  chunks: RecordingChunk[];
  durationSeconds: number | null;
  id: string;
  startTime: string | null;
}

export interface MedinaResponse<T> extends Response {
  json(): Promise<T>;
}

export type IngestMetadata = Record<string, string>;

export interface IngestDestination {
  action: string;
  headers: Record<string, string>;
  ingestId: string;
  key: string;
  metadata: IngestMetadata;
  method: string;
}

export interface MedinaClientOptions {
  baseUrl?: string;
  tailscaleLogin?: string;
  token?: string;
}

export interface MedinaSdk {
  api: {
    notes: {
      $get(): Promise<MedinaResponse<Note[]>>;
    };
    segments: {
      $get(): Promise<MedinaResponse<Segment[]>>;
    };
    recordings: {
      $get(): Promise<MedinaResponse<Recording[]>>;
    };
    in: {
      $get(): Promise<MedinaResponse<IngestDestination>>;
      $post(args: { json: { metadata?: IngestMetadata; type: string } }): Promise<MedinaResponse<IngestDestination>>;
    };
  };
  authHeaders(): Record<string, string>;
  baseUrl: string;
  connectEvents(): WebSocket;
  createIngestDestination(options: { createdAt?: string; fileName?: string; metadata?: IngestMetadata; type: string }): Promise<IngestDestination>;
  getAgentsGuide(): Promise<Response>;
  getApiDocs(): Promise<Response>;
  getEvents(limit?: number): Promise<unknown[]>;
  getInterval(id: string): Promise<unknown>;
  getIntervals(): Promise<unknown[]>;
  getRecordings(): Promise<unknown[]>;
  getSkill(): Promise<Response>;
  getStatus(): Promise<unknown>;
  getTodos(): Promise<unknown>;
  getTranscripts(query?: { from?: string; to?: string }): Promise<unknown[]>;
  json<T = unknown>(target: string, init?: RequestInit): Promise<T>;
  notifyUploadFinished(input: { contentType?: string; filename?: string; ingestId: string; ingestKey?: string; sizeBytes?: number; source?: string }): Promise<{ eventId?: string; ok?: boolean }>;
  request(target: string, init?: RequestInit): Promise<Response>;
  uploadIngest(options: { body: BodyInit; createdAt?: string; fileName?: string; metadata?: IngestMetadata; notify?: boolean; type: string }): Promise<{
    ingestId: string;
    key: string;
    metadata: IngestMetadata;
  }>;
  uploadToDestination(destination: IngestDestination, body: BodyInit): Promise<Response>;
}

export declare function createMedinaClient(baseUrl?: string | MedinaClientOptions): MedinaSdk;
