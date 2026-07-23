export const CHUNK_DURATION_SECONDS = 600;

export type ChunkWindow = {
  chunkId: string;
  endTime: Date;
  leadingSilenceSeconds: number;
  outputKey: string;
  recordingAudioDurationSeconds: number;
  recordingAudioOffsetSeconds: number;
  startTime: Date;
};

function padPart(value: number, length: number) {
  return String(value).padStart(length, "0");
}

export function getChunkId(time: Date): string {
  const minutes = Math.floor(time.getUTCMinutes() / 10) * 10;
  return [
    padPart(time.getUTCFullYear(), 5),
    padPart(time.getUTCMonth() + 1, 2),
    padPart(time.getUTCDate(), 2),
    padPart(time.getUTCHours(), 2),
    padPart(minutes, 2),
  ].join("");
}

export function parseChunkId(chunkId: string): { endTime: Date; startTime: Date } {
  if (!/^\d{13}$/.test(chunkId)) {
    throw new Error(`Invalid chunk id: ${chunkId}`);
  }
  const startMs = Date.UTC(
    Number(chunkId.slice(0, 5)),
    Number(chunkId.slice(5, 7)) - 1,
    Number(chunkId.slice(7, 9)),
    Number(chunkId.slice(9, 11)),
    Number(chunkId.slice(11, 13)),
  );
  return {
    endTime: new Date(startMs + CHUNK_DURATION_SECONDS * 1000),
    startTime: new Date(startMs),
  };
}

export function getChunkKey(chunkId: string, recordingId: string): string {
  return `chunks/${chunkId}/${recordingId}.ogg`;
}

// Returns the set of 10-minute clock-aligned windows a recording spans, with
// enough info to produce each chunk via ffmpeg (silence-pad + seek + trim).
export function getChunkWindows(
  recordingId: string,
  recordingStart: Date,
  durationSeconds: number,
): ChunkWindow[] {
  if (durationSeconds <= 0) return [];

  const chunkMs = CHUNK_DURATION_SECONDS * 1000;
  const recordingStartMs = recordingStart.getTime();
  const recordingEndMs = recordingStartMs + durationSeconds * 1000;
  const firstChunkStartMs = Math.floor(recordingStartMs / chunkMs) * chunkMs;
  const windows: ChunkWindow[] = [];

  for (let chunkStartMs = firstChunkStartMs; chunkStartMs < recordingEndMs; chunkStartMs += chunkMs) {
    const chunkEndMs = chunkStartMs + chunkMs;
    const leadingSilenceSeconds = Math.max(0, (recordingStartMs - chunkStartMs) / 1000);
    const audioOffsetSeconds = Math.max(0, (chunkStartMs - recordingStartMs) / 1000);
    const audioEndMs = Math.min(recordingEndMs, chunkEndMs);
    const audioDurationSeconds = Math.max(0, (audioEndMs - Math.max(recordingStartMs, chunkStartMs)) / 1000);
    const chunkId = getChunkId(new Date(chunkStartMs));

    windows.push({
      chunkId,
      endTime: new Date(chunkEndMs),
      leadingSilenceSeconds,
      outputKey: getChunkKey(chunkId, recordingId),
      recordingAudioDurationSeconds: audioDurationSeconds,
      recordingAudioOffsetSeconds: audioOffsetSeconds,
      startTime: new Date(chunkStartMs),
    });
  }

  return windows;
}
