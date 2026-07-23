import { Platform } from "react-native";
import { getMedinaAuthHeaders, getServerUrl } from "./settings";

export type PlaybackChunk = {
  startSeconds: number; // seconds from interval start
  url: string;          // relative, e.g. /recordings/id/chunk-000.ogg
};

export type PlaybackTarget = {
  chunks: PlaybackChunk[];
  durationSeconds: number;
  id: string;
  label: string;
  startTime?: string;
};

export type PlaybackState = {
  current: PlaybackTarget | null;
  isPlaying: boolean;
  playhead: number;
};

type PlaybackListener = (state: PlaybackState) => void;

const listeners = new Set<PlaybackListener>();

let state: PlaybackState = {
  current: null,
  isPlaying: false,
  playhead: 0,
};

// Web audio
let audio: HTMLAudioElement | null = null;
let activeChunkIndex = -1;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let loadGeneration = 0;
const fetchedAudioUrls = new Map<string, string>();

function clampPlayhead(seconds: number, durationSeconds: number): number {
  const nextSeconds = Number.isFinite(seconds) ? seconds : 0;
  const nextDuration = Number.isFinite(durationSeconds) ? durationSeconds : 0;
  return Math.max(0, Math.min(nextSeconds, nextDuration));
}

function resolveUrl(url: string): string {
  return url.startsWith("/") ? `${getServerUrl()}${url}` : url;
}

async function getPlayableUrl(url: string): Promise<string> {
  const resolved = resolveUrl(url);
  if (resolved.startsWith("blob:") || resolved.startsWith("data:")) {
    return resolved;
  }

  const cached = fetchedAudioUrls.get(resolved);
  if (cached) {
    return cached;
  }

  const response = await fetch(resolved, {
    headers: getMedinaAuthHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Audio fetch failed ${response.status} for ${resolved}`);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  fetchedAudioUrls.set(resolved, objectUrl);
  return objectUrl;
}

function revokeFetchedAudioUrls(): void {
  for (const url of fetchedAudioUrls.values()) {
    URL.revokeObjectURL(url);
  }
  fetchedAudioUrls.clear();
}

function emit(): void {
  const snap = { ...state };
  for (const listener of listeners) listener(snap);
}

function stopTick(): void {
  if (!tickTimer) return;
  clearInterval(tickTimer);
  tickTimer = null;
}

function startTick(): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    if (!audio || !state.current || !state.isPlaying) {
      stopTick();
      return;
    }
    const chunkStart = state.current.chunks[activeChunkIndex]?.startSeconds ?? 0;
    state = { ...state, playhead: chunkStart + audio.currentTime };
    emit();
  }, 100);
}

function ensureAudio(): HTMLAudioElement {
  if (audio) return audio;

  audio = new Audio();
  audio.onended = () => {
    if (!state.current) return;
    const next = activeChunkIndex + 1;
    if (next < state.current.chunks.length) {
      loadChunk(state.current, next, 0, true);
    } else {
      state = { ...state, isPlaying: false, playhead: state.current.durationSeconds };
      stopTick();
      emit();
    }
  };
  audio.onerror = () => {
    console.error("[playback] audio error", audio?.error);
  };
  return audio;
}

function loadChunk(target: PlaybackTarget, index: number, offsetInChunk: number, play: boolean): void {
  if (Platform.OS !== "web") return;
  const chunk = target.chunks[index];
  if (!chunk) return;

  const generation = ++loadGeneration;
  activeChunkIndex = index;

  void (async () => {
    try {
      const nextAudio = ensureAudio();
      const url = await getPlayableUrl(chunk.url);
      if (generation !== loadGeneration) return;

      if (nextAudio.src !== url) {
        nextAudio.src = url;
        nextAudio.load();
      }

      nextAudio.currentTime = isFinite(offsetInChunk) ? offsetInChunk : 0;

      if (play) {
        await nextAudio.play();
        if (generation !== loadGeneration) return;
        state = { ...state, current: target, isPlaying: true };
        startTick();
        emit();
      }
    } catch (e) {
      if (generation !== loadGeneration) return;
      console.error("[playback] play failed", e);
      state = { ...state, current: target, isPlaying: false };
      stopTick();
      emit();
    }
  })();
}

function findChunk(target: PlaybackTarget, seconds: number): { index: number; offset: number } {
  const chunks = target.chunks;
  let index = 0;
  for (let i = 0; i < chunks.length; i++) {
    if ((chunks[i]?.startSeconds ?? Infinity) <= seconds) index = i;
    else break;
  }
  const offset = Math.max(0, seconds - (chunks[index]?.startSeconds ?? 0));
  return { index, offset };
}

export function subscribePlaybackState(listener: PlaybackListener): () => void {
  listeners.add(listener);
  listener({ ...state });
  return () => { listeners.delete(listener); };
}

export function getPlaybackState(): PlaybackState {
  return state;
}

export function seekPlayback(target: PlaybackTarget, seconds: number): void {
  const playhead = clampPlayhead(seconds, target.durationSeconds);
  const isCurrent = state.current?.id === target.id;
  const shouldPlay = isCurrent ? state.isPlaying : false;

  if (target.chunks.length === 0 || Platform.OS !== "web") {
    state = { current: target, isPlaying: shouldPlay, playhead };
    emit();
    return;
  }

  const { index, offset } = findChunk(target, playhead);
  state = { current: target, isPlaying: shouldPlay, playhead };
  emit();
  loadChunk(target, index, offset, shouldPlay);
}

export function togglePlayback(target: PlaybackTarget): void {
  const isCurrent = state.current?.id === target.id;

  if (!isCurrent) {
    // Start from beginning
    state = { current: target, isPlaying: false, playhead: 0 };
    if (Platform.OS === "web" && target.chunks.length > 0) {
      loadChunk(target, 0, 0, true);
    } else {
      state = { ...state, isPlaying: true };
      emit();
    }
    return;
  }

  const nextPlayhead = state.playhead >= target.durationSeconds ? 0 : state.playhead;

  if (state.isPlaying) {
    audio?.pause();
    stopTick();
    state = { ...state, isPlaying: false, playhead: nextPlayhead };
    emit();
  } else {
    if (nextPlayhead === 0 && state.playhead >= target.durationSeconds) {
      loadChunk(target, 0, 0, true);
    } else {
      const { index, offset } = findChunk(target, nextPlayhead);
      loadChunk(target, index, offset, true);
    }
  }
}

export function skipPlayback(seconds: number): void {
  if (!state.current) return;
  const next = clampPlayhead(state.playhead + seconds, state.current.durationSeconds);
  seekPlayback(state.current, next);
  if (state.isPlaying) {
    const { index, offset } = findChunk(state.current, next);
    loadChunk(state.current, index, offset, true);
  }
}

export function clearPlayback(): void {
  loadGeneration += 1;
  audio?.pause();
  stopTick();
  if (audio) { audio.src = ""; }
  revokeFetchedAudioUrls();
  state = { current: null, isPlaying: false, playhead: 0 };
  emit();
}
