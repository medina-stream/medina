import { File } from "expo-file-system";
import * as Network from "expo-network";
import { Platform } from "react-native";
import { UPLOAD_INTERVAL_MS } from "./constants";
import {
  addUploadHistory,
  loadQueue,
  removeFromQueue,
  resetStaleUploads,
  updateEntryProgress,
  updateEntryStatus,
} from "./storage";
import { requestIngestForm, notifyUploadFinished } from "./medina";
import { getMedinaAuthHeaders } from "./settings";
import { notifyUploadComplete, notifyUploadFailed } from "./notifications";

let uploadInterval: ReturnType<typeof setInterval> | null = null;
let uploading = false;
let rerunRequested = false;
let activeUpload:
  | {
      uri: string;
      xhr: XMLHttpRequest;
    }
  | null = null;

async function isWifi(): Promise<boolean> {
  if (Platform.OS === "web") return true;
  const state = await Network.getNetworkStateAsync();
  return state.type === Network.NetworkStateType.WIFI && !!state.isConnected;
}

async function uploadFileWithProgress(
  uri: string,
  action: string,
  file: { arrayBuffer(): Promise<ArrayBuffer>; type?: string; size?: number | null },
  headers: Record<string, string> = {},
  method = "PUT",
): Promise<boolean> {
  const body = await file.arrayBuffer();

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let lastProgressWriteAt = 0;
    let lastProgressBytes = 0;
    activeUpload = { uri, xhr };

    xhr.open(method.toUpperCase(), action);
    let hasContentTypeHeader = false;
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
      if (key.toLowerCase() === "content-type") {
        hasContentTypeHeader = true;
      }
    }
    if (!hasContentTypeHeader) {
      xhr.setRequestHeader("Content-Type", file.type || "audio/mp4");
    }

    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : file.size ?? 0;
      const now = Date.now();
      const shouldWrite =
        event.loaded >= total ||
        event.loaded === 0 ||
        now - lastProgressWriteAt >= 250 ||
        event.loaded - lastProgressBytes >= 256 * 1024;

      if (!shouldWrite) {
        return;
      }

      lastProgressWriteAt = now;
      lastProgressBytes = event.loaded;
      updateEntryProgress(uri, event.loaded, total);
    };

    xhr.onerror = () => {
      reject(new Error("Upload request failed"));
    };

    // Aborts are always intentional (retryUpload) — resolve false so the
    // queue re-picks the item without logging a spurious error.
    xhr.onabort = () => {
      resolve(false);
    };

    xhr.ontimeout = () => {
      reject(new Error("Upload timed out"));
    };

    xhr.onload = () => {
      resolve(xhr.status >= 200 && xhr.status < 300);
    };

    xhr.onloadend = () => {
      if (activeUpload?.xhr === xhr) {
        activeUpload = null;
      }
    };

    try {
      // React Native XHR reliably handles raw binary bodies here; passing the
      // expo-file-system File object directly produced invalid uploads.
      xhr.send(body);
    } catch (error) {
      if (activeUpload?.xhr === xhr) {
        activeUpload = null;
      }
      reject(error);
    }
  });
}

async function uploadOne(uri: string, filename: string, startsAt?: string): Promise<boolean> {
  try {
    const isBlob = uri.startsWith("blob:");
    const file = isBlob ? await fetch(uri).then((r) => r.blob()) : new File(uri);
    const sizeBytes = file.size ?? 0;
    updateEntryStatus(uri, "uploading");
    updateEntryProgress(uri, 0, sizeBytes);

    const contentType = file.type || (isBlob ? "audio/webm" : "audio/mp4");
    const metadata = {
      ...(startsAt ? { "created-at": startsAt } : {}),
      "source-device": Platform.OS,
    };
    const form = await requestIngestForm({ filename, contentType, metadata });
    updateEntryStatus(uri, "uploading", { ingestId: form.ingestId, ingestKey: form.key });

    const ok = await uploadFileWithProgress(
      uri,
      form.form.action,
      file,
      {
        ...(form.form.headers || {}),
        ...getMedinaAuthHeaders(),
      },
      form.form.method || "PUT",
    );
    if (!ok) {
      const message = "Upload request was not accepted by the server.";
      updateEntryStatus(uri, "failed", { error: message });
      void notifyUploadFailed(filename, message);
      return false;
    }

    await notifyUploadFinished(form.ingestId, { ingestKey: form.key, sizeBytes, filename });
    updateEntryStatus(uri, "uploaded", { ingestId: form.ingestId, ingestKey: form.key });
    addUploadHistory({
      completedAt: new Date().toISOString(),
      filename,
      ingestId: form.ingestId,
      ingestKey: form.key,
      sizeBytes,
      startsAt,
    });
    void notifyUploadComplete(filename);
    if (isBlob) URL.revokeObjectURL(uri);
    return true;
  } catch (e) {
    console.error("[uploader] uploadOne error:", e);
    const message = e instanceof Error ? e.message : String(e);
    try { updateEntryStatus(uri, "failed", { error: message }); } catch {}
    void notifyUploadFailed(filename, message);
    return false;
  }
}

async function runQueue(force: boolean): Promise<void> {
  if (uploading) {
    rerunRequested = true;
    return;
  }
  uploading = true;

  try {
    if (!force) {
      const wifi = await isWifi();
      if (!wifi) {
        console.log("[uploader] skipping: not on wifi");
        return;
      }
    }

    const queue = loadQueue();
    console.log("[uploader] queue length:", queue.length);
    for (const entry of queue) {
      if (entry.status === "uploading" || entry.status === "uploaded") continue;
      if (!force && entry.status === "failed") continue;
      if (!force && !(await isWifi())) break;
      const ok = await uploadOne(entry.uri, entry.filename, entry.startsAt);
      console.log("[uploader]", entry.filename, ok ? "uploaded" : "failed");
    }
  } finally {
    uploading = false;
    if (rerunRequested) {
      rerunRequested = false;
      void runQueue(force);
    }
  }
}

export async function processQueue(): Promise<void> {
  return runQueue(false);
}

export async function forceProcessQueue(): Promise<void> {
  return runQueue(true);
}

export function startUploadLoop(): void {
  if (uploadInterval) return;
  resetStaleUploads();
  processQueue();
  uploadInterval = setInterval(processQueue, UPLOAD_INTERVAL_MS);
}

export function stopUploadLoop(): void {
  if (uploadInterval) {
    clearInterval(uploadInterval);
    uploadInterval = null;
  }
}

export function retryUpload(uri: string): void {
  updateEntryStatus(uri, "pending");
  updateEntryProgress(uri, 0);
  if (activeUpload?.uri === uri) {
    activeUpload.xhr.abort();
  }
  void processQueue();
}
