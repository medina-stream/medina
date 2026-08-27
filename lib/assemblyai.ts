export type AssemblyAIUtterance = {
  speaker?: string;
  start: number;
  end: number;
  text: string;
  confidence?: number;
};

export type AssemblyAITranscript = {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  text?: string;
  utterances?: AssemblyAIUtterance[];
  error?: string | null;
};

type CreateTranscript = {
  audio_url: string;
  speech_models: ["universal-3-5-pro"];
  speaker_labels: boolean;
  language_detection: boolean;
};

function endpoint(env: Env, path: string) {
  return `${env.ASSEMBLYAI_API_URL.replace(/\/$/, "")}${path}`;
}

function headers(env: Env, contentType?: string) {
  return {
    ...(env.ASSEMBLYAI_API_KEY ? { authorization: env.ASSEMBLYAI_API_KEY } : {}),
    ...(contentType ? { "content-type": contentType } : {}),
  };
}

async function error(response: Response) {
  const body = await response.text();
  return `AssemblyAI request failed: ${response.status}${body ? ` ${body}` : ""}`;
}

export async function uploadToAssemblyAI(env: Env, audio: ReadableStream<Uint8Array>) {
  const response = await fetch(endpoint(env, "/v2/upload"), {
    method: "POST",
    headers: headers(env, "application/octet-stream"),
    body: audio,
  });
  if (!response.ok) throw new Error(await error(response));
  const payload = await response.json<{ upload_url?: string }>();
  if (!payload.upload_url) throw new Error("AssemblyAI upload response was missing upload_url");
  return payload.upload_url;
}

export async function createAssemblyAITranscript(env: Env, request: CreateTranscript) {
  const response = await fetch(endpoint(env, "/v2/transcript"), {
    method: "POST",
    headers: headers(env, "application/json"),
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(await error(response));
  return response.json<AssemblyAITranscript>();
}

export async function getAssemblyAITranscript(env: Env, id: string) {
  const response = await fetch(endpoint(env, `/v2/transcript/${encodeURIComponent(id)}`), { headers: headers(env) });
  if (!response.ok) throw new Error(await error(response));
  return response.json<AssemblyAITranscript>();
}
