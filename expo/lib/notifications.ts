import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

export type NotificationPermissionState = "granted" | "denied" | "undetermined" | "unsupported";

export type MedinaNotificationStatus = {
  permission: NotificationPermissionState;
  enabled: boolean;
  lastError: string | null;
};

type NotificationStatusListener = (status: MedinaNotificationStatus) => void;

const channelId = "medina";
const uploadNotificationCooldownMs = 30000;
const listeners = new Set<NotificationStatusListener>();
let initialized = false;
let permission: NotificationPermissionState = "undetermined";
let lastError: string | null = null;
let lastUploadNotificationAt = 0;

function isSupportedPlatform(): boolean {
  return Platform.OS === "android" || Platform.OS === "web";
}

function normalizePermission(status: Notifications.NotificationPermissionsStatus): NotificationPermissionState {
  if (status.granted || status.status === "granted") return "granted";
  if (status.status === "denied") return "denied";
  return "undetermined";
}

function getSnapshot(): MedinaNotificationStatus {
  const supported = isSupportedPlatform();
  return {
    permission: supported ? permission : "unsupported",
    enabled: supported && permission === "granted",
    lastError,
  };
}

function emitStatus(): void {
  const snapshot = getSnapshot();
  for (const listener of listeners) listener(snapshot);
}

async function syncPermission(): Promise<NotificationPermissionState> {
  if (!isSupportedPlatform()) {
    permission = "unsupported";
    emitStatus();
    return permission;
  }

  try {
    const status = await Notifications.getPermissionsAsync();
    permission = normalizePermission(status);
    lastError = null;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }

  emitStatus();
  return permission;
}

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(channelId, {
    name: "Medina",
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 180, 120, 180],
    lightColor: "#4aa8ff",
    showBadge: true,
  });
}

export function getNotificationStatus(): MedinaNotificationStatus {
  return getSnapshot();
}

export function subscribeNotificationStatus(listener: NotificationStatusListener): () => void {
  listeners.add(listener);
  listener(getSnapshot());
  void refreshNotificationStatus();
  return () => {
    listeners.delete(listener);
  };
}

export async function initializeNotifications(): Promise<void> {
  if (initialized || !isSupportedPlatform()) return;
  initialized = true;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });

  await ensureChannel();
  await syncPermission();
}

export async function refreshNotificationStatus(): Promise<MedinaNotificationStatus> {
  if (!initialized) await initializeNotifications();
  await syncPermission();
  return getSnapshot();
}

export async function requestNotificationPermission(): Promise<MedinaNotificationStatus> {
  if (!isSupportedPlatform()) {
    permission = "unsupported";
    emitStatus();
    return getSnapshot();
  }

  if (!initialized) await initializeNotifications();

  try {
    const status = await Notifications.requestPermissionsAsync({ android: {} });
    permission = normalizePermission(status);
    lastError = null;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }

  emitStatus();
  return getSnapshot();
}

export async function notifyRecordingStarted(): Promise<void> {
  await showLocalNotification({
    identifier: "recording-started",
    title: "Medina is logging",
    body: "Audio logging has started.",
    data: { medinaType: "recording-started" },
    sticky: Platform.OS === "android",
  });
}

export async function notifyRecordingStopped(): Promise<void> {
  await dismissPresentedNotification("recording-started");
  await showLocalNotification({
    identifier: "recording-stopped",
    title: "Medina logging stopped",
    body: "Your latest recording is queued for upload.",
    data: { medinaType: "recording-stopped" },
  });
}

export async function notifyRecordingFailed(message: string): Promise<void> {
  await dismissPresentedNotification("recording-started");
  await showLocalNotification({
    identifier: "recording-failed",
    title: "Medina recording needs attention",
    body: message,
    data: { medinaType: "recording-failed" },
  });
}

export async function notifyUploadComplete(filename: string): Promise<void> {
  const now = Date.now();
  if (now - lastUploadNotificationAt < uploadNotificationCooldownMs) return;
  lastUploadNotificationAt = now;

  await showLocalNotification({
    title: "Medina upload complete",
    body: filename,
    data: { medinaType: "upload-complete", filename },
  });
}

export async function notifyUploadFailed(filename: string, message: string): Promise<void> {
  await showLocalNotification({
    title: "Medina upload failed",
    body: `${filename}: ${message}`,
    data: { medinaType: "upload-failed", filename },
  });
}

async function showLocalNotification(input: {
  body: string;
  data?: Record<string, unknown>;
  identifier?: string;
  sticky?: boolean;
  title: string;
}): Promise<void> {
  if (!isSupportedPlatform()) return;
  if (!initialized) await initializeNotifications();

  const currentPermission = await syncPermission();
  if (currentPermission !== "granted") return;

  try {
    if (Platform.OS === "web") {
      showWebNotification(input.title, input.body);
    } else {
      await Notifications.scheduleNotificationAsync({
        identifier: input.identifier,
        content: {
          title: input.title,
          body: input.body,
          data: input.data,
          sound: false,
          sticky: input.sticky,
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 1, channelId },
      });
    }
    lastError = null;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }

  emitStatus();
}

function showWebNotification(title: string, body: string): void {
  const WebNotification = globalThis.Notification;
  if (typeof WebNotification === "undefined") throw new Error("Browser notifications are unavailable.");
  new WebNotification(title, {
    body,
    silent: true,
  });
}

async function dismissPresentedNotification(identifier: string): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.dismissNotificationAsync(identifier);
  } catch {}
}
