import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { AppShell, SettingsBackButton } from "../components/MainNavigation";
import { Button, Card, Screen, SectionTitle } from "../components/ui";
import {
  loadQueue,
  loadUploadHistory,
  subscribeQueue,
  subscribeUploadHistory,
  type QueueEntry,
  type UploadHistoryEntry,
} from "../lib/storage";
import {
  getRecordingState,
  subscribeRecordingState,
  type RecordingState,
} from "../lib/recorder";
import { forceProcessQueue, retryUpload } from "../lib/uploader";
import { useTheme, type AppTheme } from "../lib/theme";

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = sizeBytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function uploadStatusTone(status: QueueEntry["status"]): "good" | "warning" | "danger" {
  if (status === "uploaded") return "good";
  if (status === "failed") return "danger";
  return "warning";
}

function StatusPill({ status, styles }: {
  status: QueueEntry["status"];
  styles: ReturnType<typeof createStyles>;
}) {
  const tone = uploadStatusTone(status);
  return (
    <View style={[styles.pill, styles[`${tone}Pill`]]}>
      <Text style={[styles.pillText, styles[`${tone}PillText`]]}>{status}</Text>
    </View>
  );
}

function StatRow({ label, value, styles }: {
  label: string;
  value: string;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

function RecordingRow({ entry, styles }: {
  entry: QueueEntry;
  styles: ReturnType<typeof createStyles>;
}) {
  const progress = entry.sizeBytes > 0
    ? Math.round(entry.uploadedBytes / entry.sizeBytes * 100)
    : 0;
  const detailParts = [
    formatFileSize(entry.sizeBytes),
    entry.startsAt ? formatTimestamp(entry.startsAt) : null,
    entry.status === "uploading" ? `${progress}%` : null,
  ].filter(Boolean);

  return (
    <View style={styles.recordingRow}>
      <View style={styles.recordingMain}>
        <Text style={styles.recordingTitle} numberOfLines={1}>{entry.filename}</Text>
        <Text style={styles.recordingMeta} numberOfLines={2}>{detailParts.join(" · ")}</Text>
        {entry.ingestKey ? <Text style={styles.recordingMeta} numberOfLines={1}>{entry.ingestKey}</Text> : null}
        {entry.lastError ? <Text style={styles.errorText} numberOfLines={2}>{entry.lastError}</Text> : null}
      </View>
      <View style={styles.recordingActions}>
        <StatusPill status={entry.status} styles={styles} />
        {entry.status === "failed" ? (
          <Button variant="secondary" style={styles.retryButton} onPress={() => retryUpload(entry.uri)}>Retry</Button>
        ) : null}
      </View>
    </View>
  );
}

export default function SyncScreen() {
  const theme = useTheme();
  const styles = createStyles(theme);
  const [forceUploading, setForceUploading] = useState(false);
  const [queue, setQueue] = useState<QueueEntry[]>(() => loadQueue());
  const [uploadHistory, setUploadHistory] = useState<UploadHistoryEntry[]>(() => loadUploadHistory());
  const [recording, setRecording] = useState<RecordingState>(() => getRecordingState());

  useEffect(() => {
    const unsubscribeQueue = subscribeQueue(setQueue);
    const unsubscribeHistory = subscribeUploadHistory(setUploadHistory);
    const unsubscribeRecording = subscribeRecordingState(setRecording);
    return () => {
      unsubscribeQueue();
      unsubscribeHistory();
      unsubscribeRecording();
    };
  }, []);

  const totalQueuedBytes = useMemo(
    () => queue.reduce((sum, item) => sum + item.sizeBytes, 0),
    [queue],
  );
  const uploadedBytes = useMemo(
    () => uploadHistory.reduce((sum, item) => sum + item.sizeBytes, 0),
    [uploadHistory],
  );
  const recordings = useMemo(
    () => [...queue].sort((left, right) => (right.createdAt ?? right.startsAt ?? "").localeCompare(left.createdAt ?? left.startsAt ?? "")),
    [queue],
  );

  async function handleUploadNow() {
    setForceUploading(true);
    try {
      await forceProcessQueue();
    } finally {
      setForceUploading(false);
    }
  }

  return (
    <AppShell>
      <Screen>
        <View style={styles.titleBlock}>
          <SettingsBackButton />
          <Text style={styles.title}>Sync state</Text>
          <Text style={styles.subtitle}>Local recordings, upload progress, and delivery history.</Text>
        </View>

        <Card style={styles.sectionCard}>
          <View style={styles.sectionHeaderRow}>
            <SectionTitle>Recordings</SectionTitle>
            <Button
              variant="secondary"
              onPress={handleUploadNow}
              disabled={forceUploading || queue.every((item) => item.status === "uploaded")}
            >
              {forceUploading ? "Working…" : "Upload now"}
            </Button>
          </View>
          <View style={styles.recordingsList}>
            {recordings.length === 0 ? (
              <Text style={styles.helpText}>No uploads yet.</Text>
            ) : recordings.map((entry) => (
              <RecordingRow key={entry.uri} entry={entry} styles={styles} />
            ))}
          </View>
        </Card>

        <Card style={styles.sectionCard}>
          <SectionTitle>Storage and delivery</SectionTitle>
          <View style={styles.syncStats}>
            <StatRow label="Recordings on device" value={formatFileSize(totalQueuedBytes)} styles={styles} />
            <StatRow label="Finished uploads" value={String(uploadHistory.length)} styles={styles} />
            <StatRow label="Uploaded history" value={formatFileSize(uploadedBytes)} styles={styles} />
            <StatRow label="Event outbox" value="0 unsynced events" styles={styles} />
            <StatRow label="Recorder" value={recording.isRecording ? "on" : "idle"} styles={styles} />
          </View>
          <Text style={styles.helpText}>Recordings stay on this device after upload so upload loss is visible and recoverable.</Text>
        </Card>
      </Screen>
    </AppShell>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    titleBlock: {
      gap: theme.space.xs,
    },
    title: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.bold,
      fontSize: 30,
      letterSpacing: -0.7,
      lineHeight: 36,
    },
    subtitle: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.regular,
      fontSize: 14,
      lineHeight: 21,
    },
    sectionCard: {
      gap: theme.space.lg,
    },
    sectionHeaderRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: theme.space.md,
      justifyContent: "space-between",
    },
    recordingsList: {
      gap: theme.space.sm,
    },
    recordingRow: {
      alignItems: "flex-start",
      backgroundColor: theme.colors.control,
      borderColor: theme.colors.border,
      borderRadius: theme.radii.sm,
      borderWidth: 1,
      flexDirection: "row",
      gap: theme.space.md,
      justifyContent: "space-between",
      padding: theme.space.md,
    },
    recordingMain: {
      flex: 1,
      gap: theme.space.xs,
      minWidth: 0,
    },
    recordingTitle: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.semibold,
      fontSize: 14,
    },
    recordingMeta: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.regular,
      fontSize: 12,
      lineHeight: 17,
    },
    recordingActions: {
      alignItems: "flex-end",
      gap: theme.space.sm,
    },
    retryButton: {
      paddingHorizontal: theme.space.md,
      paddingVertical: theme.space.sm,
    },
    errorText: {
      color: theme.colors.danger,
      fontFamily: theme.fonts.medium,
      fontSize: 13,
      lineHeight: 19,
    },
    pill: {
      alignSelf: "flex-start",
      borderRadius: theme.radii.pill,
      borderWidth: 1,
      paddingHorizontal: theme.space.sm,
      paddingVertical: theme.space.xs,
    },
    pillText: {
      fontFamily: theme.fonts.semibold,
      fontSize: 12,
    },
    goodPill: {
      backgroundColor: theme.dark ? "#12351f" : "#e8f7ed",
      borderColor: theme.dark ? "#28643b" : "#b9e5c7",
    },
    warningPill: {
      backgroundColor: theme.dark ? "#332912" : "#fff6d8",
      borderColor: theme.dark ? "#6f5825" : "#ead385",
    },
    dangerPill: {
      backgroundColor: theme.colors.dangerSoft,
      borderColor: theme.colors.danger,
    },
    goodPillText: {
      color: theme.dark ? "#8be0a3" : "#176b31",
    },
    warningPillText: {
      color: theme.dark ? "#f1c96d" : "#745300",
    },
    dangerPillText: {
      color: theme.colors.danger,
    },
    syncStats: {
      gap: theme.space.md,
    },
    infoRow: {
      gap: theme.space.xs,
    },
    infoLabel: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.medium,
      fontSize: 12,
    },
    infoValue: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.regular,
      fontSize: 14,
      lineHeight: 21,
    },
    helpText: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.regular,
      fontSize: 13,
      lineHeight: 19,
    },
  });
}
