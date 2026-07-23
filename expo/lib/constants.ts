import { Platform } from "react-native";

export const UPLOAD_INTERVAL_MS = 60 * 1000;
export const QUEUE_FILE_NAME = "queue.json";

let _recordingsDir: import("expo-file-system").Directory | null = null;

export function getRecordingsDir(): import("expo-file-system").Directory {
  if (Platform.OS === "web") throw new Error("expo-file-system not available on web");
  if (!_recordingsDir) {
    const { Directory, Paths } = require("expo-file-system");
    _recordingsDir = new Directory(Paths.document, "recordings");
  }
  return _recordingsDir!;
}
