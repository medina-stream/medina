import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme, type AppTheme } from "../lib/theme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  getPlaybackState,
  skipPlayback,
  subscribePlaybackState,
  togglePlayback,
} from "../lib/playback";
import {
  getRecordingState,
  startRecording,
  stopRecording,
  subscribeRecordingState,
  type RecordingState,
} from "../lib/recorder";
import { getTranscripts, type Transcript } from "../lib/medina";
import { Icon } from "./Icon";

function formatTime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatRecordingDuration(durationMs: number): string {
  return formatTime(durationMs / 1000);
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function activeTranscript(transcripts: Transcript[], playhead: number, intervalStart?: string): Transcript | null {
  if (!intervalStart) return null;
  const currentTime = new Date(new Date(intervalStart).getTime() + playhead * 1000).getTime();
  if (Number.isNaN(currentTime)) return null;
  return transcripts.find((transcript) => {
    const start = new Date(transcript.startTime).getTime();
    const end = new Date(transcript.endTime).getTime();
    return Number.isFinite(start) && Number.isFinite(end) && currentTime >= start && currentTime < end;
  }) ?? null;
}

export function AudioToolbar({ bottomOffset = 12 }: { bottomOffset?: number }) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const insets = useSafeAreaInsets();
  const [playback, setPlayback] = useState(() => getPlaybackState());
  const [recording, setRecording] = useState<RecordingState>(() => getRecordingState());
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [transcriptsError, setTranscriptsError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribePlayback = subscribePlaybackState(setPlayback);
    const unsubscribeRecording = subscribeRecordingState(setRecording);
    return () => {
      unsubscribePlayback();
      unsubscribeRecording();
    };
  }, []);

  useEffect(() => {
    const current = playback.current;
    if (!current?.startTime) {
      setTranscripts([]);
      setTranscriptsError(null);
      return;
    }

    let cancelled = false;
    getTranscripts({
      from: current.startTime,
      to: addSeconds(current.startTime, current.durationSeconds),
    })
      .then((nextTranscripts) => {
        if (!cancelled) {
          setTranscripts(nextTranscripts);
          setTranscriptsError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setTranscripts([]);
          setTranscriptsError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [playback.current?.id, playback.current?.startTime, playback.current?.durationSeconds]);

  const transcript = useMemo(
    () => activeTranscript(transcripts, playback.playhead, playback.current?.startTime),
    [playback.current?.startTime, playback.playhead, transcripts],
  );

  async function toggleRecording() {
    if (recording.isTransitioning) {
      return;
    }

    try {
      if (recording.isRecording) {
        await stopRecording();
      } else {
        await startRecording();
      }
    } catch (error) {
      console.error("Recording error:", (error as Error).message);
    }
  }

  const currentPlayback = playback.current;
  const showPlayback = Boolean(currentPlayback);

  return (
    <View
      pointerEvents="box-none"
      style={[styles.shell, { bottom: insets.bottom + bottomOffset }]}
    >
      <View style={styles.toolbar}>
        <View style={styles.recordBlock}>
          <Pressable
            onPress={toggleRecording}
            disabled={recording.isTransitioning}
            style={[
              styles.recordAction,
              recording.isRecording && styles.recordActionActive,
              recording.isTransitioning && styles.controlDisabled,
            ]}
          >
            <Icon
              name={recording.isRecording ? "stop" : "record"}
              size={recording.isRecording ? 18 : 20}
              color={recording.isRecording ? theme.colors.danger : theme.colors.danger}
            />
          </Pressable>
          <Text style={styles.recordTime}>
            {recording.isTransitioning
              ? "..."
              : formatRecordingDuration(recording.durationMs)}
          </Text>
        </View>

        {showPlayback ? (
          <>
            <View style={styles.divider} />
            <View style={styles.playbackBlock}>
              <View style={styles.nowPlaying}>
                <Text style={styles.nowPlayingTitle} numberOfLines={1}>
                  {currentPlayback?.label}
                </Text>
                <Text style={styles.nowPlayingMeta}>
                  {formatTime(playback.playhead)} /{" "}
                  {formatTime(currentPlayback?.durationSeconds ?? 0)}
                </Text>
              </View>

              <View style={styles.actionRow}>
                <Pressable
                  onPress={() => skipPlayback(-15)}
                  style={styles.iconButton}
                >
                  <Icon name="skipBack" size={18} color={theme.colors.icon} />
                </Pressable>

                <Pressable
                  onPress={() => currentPlayback && togglePlayback(currentPlayback)}
                  style={styles.primaryPlaybackButton}
                >
                  <Icon
                    name={playback.isPlaying ? "pause" : "play"}
                    size={20}
                    color={theme.colors.primaryText}
                  />
                </Pressable>

                <Pressable
                  onPress={() => skipPlayback(15)}
                  style={styles.iconButton}
                >
                  <Icon name="skipForward" size={18} color={theme.colors.icon} />
                </Pressable>
              </View>
            </View>
          </>
        ) : null}

        {recording.lastError ? (
          <View style={styles.errorBadge}>
            <Text style={styles.errorText}>!</Text>
          </View>
        ) : null}
      </View>
      {showPlayback ? (
        <View style={styles.transcriptPanel}>
          <Text style={transcript ? styles.transcriptText : styles.transcriptEmpty} numberOfLines={3}>
            {transcript?.text || transcriptsError || "No transcript yet."}
          </Text>
        </View>
      ) : null}
      {recording.lastError ? (
        <Text style={styles.errorCaption} numberOfLines={1}>
          {recording.lastError}
        </Text>
      ) : null}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  shell: {
    position: "absolute",
    left: 16,
    right: 16,
    alignItems: "center",
  },
  toolbar: {
    width: "100%",
    maxWidth: 760,
    minHeight: 68,
    borderRadius: 22,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 10,
    paddingVertical: 8,
    shadowColor: theme.colors.shadow,
    shadowOpacity: 0.24,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  recordBlock: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexShrink: 0,
  },
  recordAction: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.dangerSoft,
    borderWidth: 1,
    borderColor: theme.colors.danger,
  },
  recordActionActive: {
    backgroundColor: theme.colors.dangerSoft,
    borderColor: theme.colors.danger,
  },
  controlDisabled: {
    opacity: 0.5,
  },
  recordTime: {
    color: theme.colors.secondaryText,
    fontSize: 12,
    fontFamily: theme.fonts.semibold,
    fontVariant: ["tabular-nums"],
    minWidth: 42,
  },
  divider: {
    width: 1,
    alignSelf: "stretch",
    backgroundColor: theme.colors.border,
  },
  playbackBlock: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minWidth: 0,
  },
  nowPlaying: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: theme.colors.card,
  },
  nowPlayingTitle: {
    color: theme.colors.primaryText,
    fontSize: 13,
    fontFamily: theme.fonts.bold,
    marginBottom: 2,
  },
  nowPlayingMeta: {
    color: theme.colors.muted,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.colors.control,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryPlaybackButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.colors.accentStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  errorBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: theme.colors.dangerSoft,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: "auto",
    flexShrink: 0,
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: 12,
    fontFamily: theme.fonts.bold,
  },
  transcriptPanel: {
    width: "100%",
    maxWidth: 760,
    marginTop: 8,
    borderRadius: 18,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  transcriptText: {
    color: theme.colors.primaryText,
    fontSize: 14,
    lineHeight: 20,
  },
  transcriptEmpty: {
    color: theme.colors.muted,
    fontSize: 13,
    lineHeight: 19,
  },
  errorCaption: {
    marginTop: 6,
    color: theme.colors.danger,
    fontSize: 11,
    maxWidth: 760,
  },
});

}
