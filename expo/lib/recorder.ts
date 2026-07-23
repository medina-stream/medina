import {
  AudioModule,
  RecordingPresets,
  type RecordingStatus,
  setAudioModeAsync,
  requestRecordingPermissionsAsync,
} from "expo-audio";
import { File } from "expo-file-system";
import { Platform } from "react-native";
import { getRecordingsDir } from "./constants";
import { ensureDir, addToQueue } from "./storage";
import { processQueue } from "./uploader";
import {
  notifyRecordingFailed,
  notifyRecordingStarted,
  notifyRecordingStopped,
  requestNotificationPermission,
} from "./notifications";

type AudioRecorder = InstanceType<typeof AudioModule.AudioRecorder> & {
  addListener: (
    eventName: "recordingStatusUpdate",
    listener: (status: RecordingStatus) => void
  ) => { remove: () => void };
};
type RecordingListener = (state: RecordingState) => void;

export type RecordingState = {
  isRecording: boolean;
  isTransitioning: boolean;
  currentFilename: string | null;
  lastError: string | null;
  durationMs: number;
  startedAt: string | null;
};

let currentRecorder: AudioRecorder | null = null;
let currentFilename: string | null = null;
let currentStartsAt: string | null = null;
let sessionStartsAt: string | null = null;
let lastError: string | null = null;
let isTransitioning = false;
let recorderStatusSubscription: { remove: () => void } | null = null;
let lastFinalizedSourceUri: string | null = null;
let desiredRecording = false;
let requestedStop = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let durationPollInterval: ReturnType<typeof setInterval> | null = null;
let currentRecorderDurationMs = 0;
let completedSessionDurationMs = 0;
const listeners = new Set<RecordingListener>();

// Web-specific state
let webMediaRecorder: MediaRecorder | null = null;
let webChunks: Blob[] = [];
let webStream: MediaStream | null = null;
let webRecordingStartTime: number | null = null;

function getWebMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

function getWebExtension(mimeType: string): string {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "mp4";
  return "webm";
}

function makeFilename(startsAt: string = new Date().toISOString()): string {
  return `recording-${startsAt.replace(/:/g, "-")}.m4a`;
}

function getSnapshot(): RecordingState {
  return {
    isRecording: desiredRecording,
    isTransitioning,
    currentFilename,
    lastError,
    startedAt: desiredRecording ? sessionStartsAt : null,
    durationMs: desiredRecording
      ? completedSessionDurationMs + currentRecorderDurationMs
      : 0,
  };
}

function emitState(): void {
  const snapshot = getSnapshot();
  for (const listener of listeners) {
    listener(snapshot);
  }
}

function clearRestartTimer(): void {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function detachRecorder(recorder?: AudioRecorder | null): void {
  if (recorderStatusSubscription) {
    recorderStatusSubscription.remove();
    recorderStatusSubscription = null;
  }
  if (!recorder || recorder === currentRecorder) {
    currentRecorder = null;
    currentFilename = null;
    currentStartsAt = null;
  }
}

function resetSessionDuration(): void {
  completedSessionDurationMs = 0;
  currentRecorderDurationMs = 0;
  sessionStartsAt = null;
}

function stopDurationPolling(): void {
  if (durationPollInterval) {
    clearInterval(durationPollInterval);
    durationPollInterval = null;
  }
}

function refreshRecorderDuration(): void {
  if (Platform.OS === "web") {
    if (webRecordingStartTime !== null && desiredRecording) {
      currentRecorderDurationMs = Date.now() - webRecordingStartTime;
      emitState();
    } else {
      currentRecorderDurationMs = 0;
      stopDurationPolling();
      emitState();
    }
    return;
  }

  if (!currentRecorder) {
    currentRecorderDurationMs = 0;
    stopDurationPolling();
    emitState();
    return;
  }

  try {
    const status = currentRecorder.getStatus();
    currentRecorderDurationMs = Math.max(
      currentRecorderDurationMs,
      status.durationMillis ?? 0
    );
    emitState();
  } catch {
    // Ignore transient native status lookup failures; the watchdog handles restarts.
  }
}

function startDurationPolling(): void {
  stopDurationPolling();
  refreshRecorderDuration();
  durationPollInterval = setInterval(refreshRecorderDuration, 1000);
}

function setLastError(message: string | null): void {
  lastError = message;
  emitState();
}

function finalizeChunkFile(sourceUri: string, filename: string, startsAt?: string | null): void {
  if (!sourceUri || sourceUri === lastFinalizedSourceUri) {
    return;
  }

  lastFinalizedSourceUri = sourceUri;

  const sourceFile = new File(sourceUri);
  sourceFile.move(getRecordingsDir());
  sourceFile.rename(filename);
  addToQueue({
    uri: sourceFile.uri,
    filename,
    ...(startsAt ? { startsAt } : {}),
    status: "pending",
    sizeBytes: sourceFile.size ?? 0,
    uploadedBytes: 0,
  });
  emitState();
  void processQueue();
}

function handleRecorderStatus(status: RecordingStatus): void {
  if (status.hasError && status.error) {
    setLastError(status.error);
  }

  if (!status.isFinished) {
    return;
  }

  const startsAt = currentStartsAt || new Date().toISOString();
  const filename = currentFilename ?? makeFilename(startsAt);
  const finishedDurationMs = currentRecorderDurationMs;
  stopDurationPolling();
  detachRecorder();
  if (status.url) {
    finalizeChunkFile(status.url, filename, startsAt);
  }

  currentRecorderDurationMs = 0;

  if (desiredRecording && !requestedStop) {
    completedSessionDurationMs += finishedDurationMs;
    emitState();
    scheduleRecorderRestart();
    return;
  }

  resetSessionDuration();
  emitState();
}

export function subscribeRecordingState(listener: RecordingListener): () => void {
  listeners.add(listener);
  listener(getSnapshot());
  return () => {
    listeners.delete(listener);
  };
}

export function getRecordingState(): RecordingState {
  return getSnapshot();
}

export async function startRecording(): Promise<void> {
  if (desiredRecording || isTransitioning) {
    return;
  }

  isTransitioning = true;
  desiredRecording = true;
  requestedStop = false;
  resetSessionDuration();
  sessionStartsAt = new Date().toISOString();
  setLastError(null);
  emitState();

  if (Platform.OS !== "web") {
    ensureDir();
  }

  try {
    if (Platform.OS === "web") {
      await beginRecordingSessionWeb();
      void notifyRecordingStarted();
    } else {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) throw new Error("Microphone permission denied");

      if (Platform.OS === "android") {
        const notificationPermission = await requestNotificationPermission();
        if (!notificationPermission.enabled) {
          throw new Error(
            "Notification permission denied. Android background recording needs notifications enabled."
          );
        }
      }

      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
        allowsBackgroundRecording: true,
      });

      await beginRecordingSession();
      void notifyRecordingStarted();
    }
  } catch (error) {
    void notifyRecordingFailed((error as Error).message);
    desiredRecording = false;
    requestedStop = false;
    resetSessionDuration();
    setLastError((error as Error).message);
    throw error;
  } finally {
    isTransitioning = false;
    emitState();
  }
}

async function beginRecordingSession(): Promise<void> {
  const recorder = new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY);
  const startsAt = new Date().toISOString();
  recorderStatusSubscription?.remove();
  recorderStatusSubscription = recorder.addListener(
    "recordingStatusUpdate",
    handleRecorderStatus
  );
  try {
    await recorder.prepareToRecordAsync();
    recorder.record();
    currentRecorder = recorder;
    currentStartsAt = startsAt;
    currentFilename = makeFilename(startsAt);
    currentRecorderDurationMs = 0;
    clearRestartTimer();
    startDurationPolling();
    emitState();
  } catch (error) {
    detachRecorder(recorder);
    throw error;
  }
}

async function finishRecordingSession(): Promise<void> {
  if (!currentRecorder) return;
  const recorder = currentRecorder;
  const startsAt = currentStartsAt || new Date().toISOString();
  const filename = currentFilename ?? makeFilename(startsAt);
  const finishedDurationMs = currentRecorderDurationMs;
  currentRecorder = null;
  currentFilename = null;
  currentStartsAt = null;
  stopDurationPolling();
  currentRecorderDurationMs = 0;

  try {
    await recorder.stop();
  } catch {
    detachRecorder(recorder);
    return;
  }

  const sourceUri = recorder.uri;
  detachRecorder(recorder);
  if (!sourceUri) {
    emitState();
    return;
  }

  completedSessionDurationMs += finishedDurationMs;
  finalizeChunkFile(sourceUri, filename, startsAt);
}

async function beginRecordingSessionWeb(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  webStream = stream;
  webChunks = [];
  webRecordingStartTime = Date.now();

  const mimeType = getWebMimeType();
  const recorder = mimeType
    ? new MediaRecorder(stream, { mimeType })
    : new MediaRecorder(stream);
  webMediaRecorder = recorder;

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) webChunks.push(e.data);
  };

  recorder.onerror = () => {
    setLastError("MediaRecorder error");
  };

  const startsAt = new Date().toISOString();
  currentStartsAt = startsAt;
  currentFilename = makeFilename(startsAt);

  recorder.start();
  clearRestartTimer();
  startDurationPolling();
  emitState();
}

async function finishRecordingSessionWeb(): Promise<void> {
  const recorder = webMediaRecorder;
  const stream = webStream;
  const startsAt = currentStartsAt || new Date().toISOString();

  webMediaRecorder = null;
  webStream = null;
  webRecordingStartTime = null;
  currentStartsAt = null;
  currentFilename = null;
  stopDurationPolling();

  if (!recorder) return;

  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
    recorder.stop();
  });

  const chunks = webChunks;
  webChunks = [];

  stream?.getTracks().forEach((t) => t.stop());

  if (chunks.length === 0) return;

  const actualMimeType = recorder.mimeType || "audio/webm";
  const ext = getWebExtension(actualMimeType);
  const filename = makeFilename(startsAt).replace(".m4a", `.${ext}`);
  const blob = new Blob(chunks, { type: actualMimeType });

  addToQueue({
    uri: URL.createObjectURL(blob),
    filename,
    startsAt,
    status: "pending",
    sizeBytes: blob.size,
    uploadedBytes: 0,
  });
  void processQueue();
}

function scheduleRecorderRestart(delayMs = 1000): void {
  if (!desiredRecording || currentRecorder || restartTimer) {
    return;
  }

  restartTimer = setTimeout(async () => {
    restartTimer = null;

    if (!desiredRecording || currentRecorder) {
      return;
    }

    try {
      await beginRecordingSession();
      setLastError(null);
    } catch (error) {
      setLastError((error as Error).message);
      scheduleRecorderRestart(Math.min(delayMs * 2, 30000));
    }
  }, delayMs);
}

export async function stopRecording(): Promise<void> {
  if ((!desiredRecording && !currentRecorder) || isTransitioning) {
    return;
  }

  isTransitioning = true;
  desiredRecording = false;
  requestedStop = true;
  emitState();

  clearRestartTimer();

  try {
    if (Platform.OS === "web") {
      await finishRecordingSessionWeb();
    } else {
      await finishRecordingSession();
      await setAudioModeAsync({
        allowsRecording: false,
        allowsBackgroundRecording: false,
      });
    }
    void notifyRecordingStopped();
  } catch (error) {
    void notifyRecordingFailed((error as Error).message);
    setLastError((error as Error).message);
    throw error;
  } finally {
    requestedStop = false;
    resetSessionDuration();
    stopDurationPolling();
    isTransitioning = false;
    emitState();
  }
}

export function isRecording(): boolean {
  return desiredRecording;
}
