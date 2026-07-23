import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View, type GestureResponderEvent } from "react-native";
import { useTheme, type AppTheme } from "../lib/theme";
import { subscribeEvents } from "../lib/events";
import {
  getPlaybackState,
  seekPlayback,
  subscribePlaybackState,
  togglePlayback,
  type PlaybackChunk,
  type PlaybackTarget,
} from "../lib/playback";
import { getMedinaAuthHeaders, getServerUrl } from "../lib/settings";
import { Icon } from "./Icon";

export type RecordingChunk = {
  key?: string;
  url: string;
  ordinal: number;
  durationSeconds: number;
};

export type Recording = {
  id: string;
  startTime: string;
  durationSeconds: number;
  chunks: RecordingChunk[];
};

export const intervalRowHeight = 106;

const daySeconds = 24 * 60 * 60;
const timelineTicks = [
  { label: "7a", seconds: 7 * 60 * 60 },
  { label: "12p", seconds: 12 * 60 * 60 },
  { label: "9p", seconds: 21 * 60 * 60 },
];

export type IntervalData = {
  id: string;
  startTime: string;
  endTime: string;
  durationSeconds: number;
  coverageSeconds: number;
  recordings: Recording[];
};

export type IntervalTimelineProps = {
  currentTimeSeconds: number | null;
  data: IntervalData;
  positionSeconds: number;
  showPlayhead: boolean;
  theme: AppTheme;
  onPositionChange?: (seconds: number) => void;
};

type TimelinePressEvent = GestureResponderEvent["nativeEvent"] & {
  layerX?: number;
  offsetX?: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getRelativePressX(event: GestureResponderEvent): number | null {
  const nativeEvent = event.nativeEvent as TimelinePressEvent;
  const candidates = [nativeEvent.locationX, nativeEvent.offsetX, nativeEvent.layerX];

  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function getPlaybackChunkUrl(chunk: RecordingChunk): string | null {
  if (typeof chunk.key === "string" && chunk.key.length > 0) {
    return `/${chunk.key.replace(/^\/+/, "")}`;
  }

  if (typeof chunk.url === "string" && chunk.url.length > 0) {
    return chunk.url;
  }

  return null;
}

function formatTime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatDurationLabel(seconds: number): string {
  const totalSeconds = Math.max(0, Math.round(seconds));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function formatIntervalDate(id: string): string {
  const d = id.slice(1);
  const month = parseInt(d.slice(4, 6), 10);
  const day = parseInt(d.slice(6, 8), 10);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[month - 1]} ${day}`;
}

function currentDayId(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `0${y}${m}${d}`;
}

function secondsSinceUtcMidnight(date: Date): number {
  return date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds();
}

export function IntervalTimeline({ currentTimeSeconds, data, positionSeconds, showPlayhead, theme, onPositionChange }: IntervalTimelineProps) {
  const styles = createStyles(theme);
  const [trackWidth, setTrackWidth] = useState(0);

  const durationSeconds = Math.max(data.durationSeconds, 1);
  const intervalStartMs = new Date(data.startTime).getTime();
  const totalMs = durationSeconds * 1000;
  const playheadX = trackWidth > 0
    ? clamp((clamp(positionSeconds, 0, durationSeconds) / durationSeconds) * trackWidth, 0, Math.max(trackWidth - 2, 0))
    : 0;
  const currentTimeX = trackWidth > 0 && currentTimeSeconds !== null
    ? clamp((clamp(currentTimeSeconds, 0, durationSeconds) / durationSeconds) * trackWidth, 0, Math.max(trackWidth - 2, 0))
    : null;

  const handlePress = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
    if (!onPositionChange || trackWidth <= 0) {
      return;
    }

    const relativeX = getRelativePressX(event);
    if (relativeX === null) {
      return;
    }

    const fraction = clamp(relativeX / trackWidth, 0, 1);
    onPositionChange(fraction * durationSeconds);
  }, [durationSeconds, onPositionChange, trackWidth]);

  return (
    <Pressable
      disabled={!onPositionChange}
      onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
      onPress={handlePress}
      style={styles.timeline}
    >
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {trackWidth > 0 && timelineTicks.map((tick) => (
          <View
            key={tick.seconds}
            style={[
              styles.tick,
              { left: clamp((tick.seconds / daySeconds) * trackWidth, 0, Math.max(trackWidth - 1, 0)) },
            ]}
          >
            <Text style={styles.tickLabel}>{tick.label}</Text>
          </View>
        ))}
        {trackWidth > 0 && data.recordings.map((recording) => {
          const recordingStartMs = new Date(recording.startTime).getTime();
          const left = clamp(((recordingStartMs - intervalStartMs) / totalMs) * trackWidth, 0, trackWidth);
          const width = Math.max(2, (recording.durationSeconds / durationSeconds) * trackWidth);

          return (
            <View
              key={recording.id}
              style={[
                styles.segment,
                {
                  left,
                  width: Math.min(width, trackWidth - left),
                },
              ]}
            />
          );
        })}
        {currentTimeX !== null ? <View style={[styles.currentTime, { left: currentTimeX }]} /> : null}
        {showPlayhead ? <View style={[styles.playhead, { left: playheadX }]} /> : null}
      </View>
    </Pressable>
  );
}

function buildPlaybackTarget(id: string, data: IntervalData): PlaybackTarget {
  const intervalStartMs = new Date(data.startTime).getTime();
  const chunks: PlaybackChunk[] = [];

  for (const recording of data.recordings) {
    const recordingStartMs = new Date(recording.startTime).getTime();
    if (!isFinite(recordingStartMs)) {
      continue;
    }

    const recordingOffsetSeconds = (recordingStartMs - intervalStartMs) / 1000;
    const orderedChunks = [...recording.chunks].sort((a, b) => a.ordinal - b.ordinal);
    const fallbackChunkDuration = orderedChunks.length > 0
      ? recording.durationSeconds / orderedChunks.length
      : 0;

    let chunkOffsetSeconds = 0;

    for (const chunk of orderedChunks) {
      const startSeconds = recordingOffsetSeconds + chunkOffsetSeconds;
      const url = getPlaybackChunkUrl(chunk);
      if (isFinite(startSeconds)) {
        if (url) {
          chunks.push({ startSeconds, url });
        }
      }

      const chunkDuration = Number(chunk.durationSeconds);
      chunkOffsetSeconds += chunkDuration > 0 ? chunkDuration : fallbackChunkDuration;
    }
  }

  chunks.sort((a, b) => a.startSeconds - b.startSeconds);

  return {
    chunks,
    durationSeconds: data.durationSeconds,
    id,
    label: formatIntervalDate(id),
    startTime: data.startTime,
  };
}

export function Interval({ id, onOpenDay }: { id: string; onOpenDay?: () => void }) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const [data, setData] = useState<IntervalData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [playback, setPlayback] = useState(() => getPlaybackState());

  const fetchData = useCallback(() => {
    const serverUrl = getServerUrl();
    setError(null);

    fetch(`${serverUrl}/${id}.json`, {
      headers: getMedinaAuthHeaders(),
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`${response.status}`);
        }

        return response.json() as Promise<IntervalData>;
      })
      .then(setData)
      .catch((nextError: unknown) =>
        setError(nextError instanceof Error ? nextError.message : String(nextError))
      );
  }, [id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    return subscribeEvents((event) => {
      if (event.data?.type === "interval.materialized" && event.data?.id === id) {
        fetchData();
      }
    });
  }, [fetchData, id]);

  useEffect(() => {
    return subscribePlaybackState(setPlayback);
  }, []);

  useEffect(() => {
    if (id !== currentDayId()) {
      return;
    }

    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, [id]);

  const isToday = id === currentDayId();
  const playbackTarget = data ? buildPlaybackTarget(id, data) : null;
  const isCurrent = playback.current?.id === id;
  const currentTimeSeconds = isToday ? secondsSinceUtcMidnight(now) : null;
  const positionSeconds = isCurrent ? playback.playhead : 0;
  const playing = isCurrent && playback.isPlaying;

  const handlePositionChange = useCallback((seconds: number) => {
    if (!playbackTarget) {
      return;
    }

    seekPlayback(playbackTarget, seconds);
  }, [playbackTarget]);

  return (
    <Pressable
      disabled={!onOpenDay}
      onPress={onOpenDay}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowHeader}>
        <Text style={styles.dateLabel}>{formatIntervalDate(id)}</Text>
        <View style={styles.headerMeta}>
          {data ? <Text style={styles.coverage}>{formatDurationLabel(data.coverageSeconds)}</Text> : null}
          {onOpenDay ? <Icon name="chevronRight" size={17} color={theme.colors.muted} /> : null}
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>

      {data ? (
        <>
          <IntervalTimeline
            currentTimeSeconds={currentTimeSeconds}
            data={data}
            onPositionChange={handlePositionChange}
            positionSeconds={positionSeconds}
            showPlayhead={isCurrent}
            theme={theme}
          />
          <View style={styles.controls}>
            <Pressable
              onPress={(event) => {
                event.stopPropagation();
                if (playbackTarget) togglePlayback(playbackTarget);
              }}
              style={[styles.playButton, playing && styles.playButtonActive]}
            >
              <Icon name={playing ? "pause" : "play"} size={13} color={theme.colors.primaryText} />
            </Pressable>
            <Text style={styles.timeDisplay}>{formatTime(positionSeconds)}</Text>
          </View>
        </>
      ) : !error ? (
        <IntervalTimeline
          currentTimeSeconds={currentTimeSeconds}
          data={{
            id,
            startTime: `${id.slice(1, 5)}-${id.slice(5, 7)}-${id.slice(7, 9)}T00:00:00.000Z`,
            endTime: `${id.slice(1, 5)}-${id.slice(5, 7)}-${id.slice(7, 9)}T23:59:59.999Z`,
            durationSeconds: daySeconds,
            coverageSeconds: 0,
            recordings: [],
          }}
          positionSeconds={0}
          showPlayhead={false}
          theme={theme}
        />
      ) : null}
    </Pressable>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    row: {
      gap: 6,
      height: intervalRowHeight,
      paddingVertical: theme.space.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    rowPressed: {
      opacity: 0.78,
    },
    rowHeader: {
      flexDirection: "row",
      alignItems: "flex-end",
      justifyContent: "space-between",
    },
    headerMeta: {
      alignItems: "center",
      flexDirection: "row",
      gap: theme.space.xs,
    },
    dateLabel: {
      color: theme.colors.secondaryText,
      fontFamily: theme.fonts.semibold,
      fontSize: 17,
      letterSpacing: -0.1,
      lineHeight: 22,
    },
    coverage: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.medium,
      fontSize: 13,
      lineHeight: 20,
    },
    timeline: {
      height: 18,
      backgroundColor: theme.colors.timeline,
      borderRadius: theme.radii.sm,
      overflow: "hidden",
      position: "relative",
      justifyContent: "center",
    },
    loading: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.medium,
      fontSize: 12,
      textAlign: "center",
    },
    segment: {
      position: "absolute",
      top: 0,
      bottom: 0,
      backgroundColor: theme.colors.accent,
    },
    tick: {
      position: "absolute",
      top: 0,
      bottom: 0,
      width: 1,
      backgroundColor: theme.colors.border,
      opacity: 0.9,
    },
    tickLabel: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.medium,
      fontSize: 9,
      left: 3,
      lineHeight: 10,
      position: "absolute",
      top: 3,
    },
    currentTime: {
      position: "absolute",
      top: 0,
      bottom: 0,
      width: 2,
      backgroundColor: theme.colors.recordButton,
      opacity: 0.95,
    },
    playhead: {
      position: "absolute",
      top: 0,
      bottom: 0,
      width: 2,
      backgroundColor: theme.colors.playhead,
      opacity: 0.9,
    },
    controls: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.space.sm,
      marginTop: 0,
    },
    playButton: {
      width: 30,
      height: 30,
      borderRadius: 15,
      backgroundColor: theme.colors.control,
      alignItems: "center",
      justifyContent: "center",
    },
    playButtonActive: {
      backgroundColor: theme.colors.accentStrong,
    },
    timeDisplay: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.mono,
      fontSize: 13,
      fontVariant: ["tabular-nums"],
    },
    error: {
      color: theme.colors.danger,
      fontFamily: theme.fonts.medium,
      fontSize: 12,
    },
  });
}
