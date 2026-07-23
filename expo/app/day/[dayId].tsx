import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { AppShell } from "../../components/MainNavigation";
import { GpsDaySection } from "../../components/DayGps";
import { Icon } from "../../components/Icon";
import { subscribeEvents } from "../../lib/events";
import { dateFromDayId } from "../../lib/dates";
import { getDayGps, getDayMapUrl, getDayTranscripts, getIntervalSummary, type GpsDay, type Transcript } from "../../lib/medina";
import { formatClockTime } from "../../lib/timeformat";
import { useTheme, type AppTheme } from "../../lib/theme";

type DayState = {
  coverageSeconds: number | null;
  error: string | null;
  gps: GpsDay | null;
  loading: boolean;
  transcripts: Transcript[];
};

function getDayIdParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}

function formatDay(dayId: string): string {
  const date = dateFromDayId(dayId);
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatAudioHours(seconds: number | null): string {
  if (seconds === null) return "";
  const hours = Math.max(0, seconds) / 3600;
  if (hours === 0) return "0h audio";
  if (hours < 0.1) return "<0.1h audio";
  if (hours < 10) return `${hours.toFixed(1)}h audio`;
  return `${Math.round(hours)}h audio`;
}

function matchesTranscriptEventDay(eventData: unknown, dayId: string): boolean {
  if (!eventData || typeof eventData !== "object") return true;
  const data = eventData as { chunkKey?: unknown; dayIds?: unknown; transcriptKey?: unknown };
  if (Array.isArray(data.dayIds) && data.dayIds.some((value) => value === dayId)) return true;
  const chunkKey = data.chunkKey;
  const transcriptKey = data.transcriptKey;

  if (typeof chunkKey === "string") return chunkKey.startsWith(`chunks/${dayId}`);
  if (typeof transcriptKey === "string") return transcriptKey.startsWith(`chunks/${dayId}`);
  return true;
}

export default function DayScreen() {
  const theme = useTheme();
  const styles = createStyles(theme);
  const params = useLocalSearchParams<{ dayId?: string | string[] }>();
  const dayId = getDayIdParam(params.dayId);
  const [state, setState] = useState<DayState>({
    coverageSeconds: null,
    error: null,
    gps: null,
    loading: true,
    transcripts: [],
  });

  const fetchDay = useCallback(async () => {
    if (!dayId) return;
    setState((current) => ({ ...current, error: null, loading: true }));

    try {
      const [transcripts, interval, gps] = await Promise.all([
        getDayTranscripts(dayId),
        getIntervalSummary(dayId),
        getDayGps(dayId).catch(() => null),
      ]);
      setState({
        coverageSeconds: interval.coverageSeconds,
        error: null,
        gps,
        loading: false,
        transcripts,
      });
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      }));
    }
  }, [dayId]);

  useEffect(() => {
    void fetchDay();
  }, [fetchDay]);

  useEffect(() => {
    if (!dayId) return;
    return subscribeEvents((event) => {
      if (event.data?.type === "transcript.materialized" && matchesTranscriptEventDay(event.data, dayId)) {
        void fetchDay();
      }
    });
  }, [dayId, fetchDay]);
  const transcripts = state.transcripts;

  return (
    <AppShell>
      <View style={styles.screen}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backButton}>
            <Icon name="chevronLeft" size={22} color={theme.colors.primaryText} />
          </Pressable>
          <View style={styles.headerText}>
            <Text style={styles.kicker}>Day</Text>
            <Text style={styles.title}>{dayId ? formatDay(dayId) : "Day"}</Text>
            <Text style={styles.meta}>{formatAudioHours(state.coverageSeconds)}</Text>
          </View>
        </View>

        <ScrollView contentContainerStyle={styles.content} style={styles.scroll}>
          {state.gps && dayId ? <GpsDaySection gps={state.gps} mapUrl={getDayMapUrl(dayId)} /> : null}
          {state.loading && transcripts.length === 0 ? (
            <View style={styles.centerState}>
              <ActivityIndicator color={theme.colors.muted} />
              <Text style={styles.empty}>Loading transcript...</Text>
            </View>
          ) : state.error ? (
            <Text style={styles.error}>{state.error}</Text>
          ) : transcripts.length === 0 ? (
            <Text style={styles.empty}>No transcript for this day.</Text>
          ) : transcripts.map((transcript) => (
            <View key={transcript.transcriptKey} style={styles.transcriptRow}>
              <Text style={styles.timestamp}>{formatClockTime(transcript.startTime, transcript.timeZone ?? "UTC", { withSeconds: true })}</Text>
              <Text style={styles.transcriptText}>{transcript.text || "[no speech]"}</Text>
            </View>
          ))}
        </ScrollView>
      </View>
    </AppShell>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    header: {
      alignItems: "flex-start",
      borderBottomColor: theme.colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: theme.space.md,
      paddingBottom: theme.space.lg,
      paddingHorizontal: theme.space.lg,
      paddingTop: theme.space.xl,
    },
    backButton: {
      alignItems: "center",
      backgroundColor: theme.colors.control,
      borderRadius: 18,
      height: 36,
      justifyContent: "center",
      marginTop: 4,
      width: 36,
    },
    headerText: {
      flex: 1,
      gap: 2,
    },
    kicker: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.semibold,
      fontSize: 12,
      letterSpacing: 0.8,
      lineHeight: 18,
      textTransform: "uppercase",
    },
    title: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.bold,
      fontSize: 28,
      letterSpacing: -0.7,
      lineHeight: 34,
    },
    meta: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.medium,
      fontSize: 14,
      lineHeight: 22,
    },
    scroll: {
      flex: 1,
    },
    content: {
      gap: 16,
      padding: theme.space.lg,
      paddingBottom: 80,
    },
    centerState: {
      alignItems: "center",
      gap: theme.space.md,
      paddingTop: theme.space.xxl,
    },
    empty: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.regular,
      fontSize: 15,
      lineHeight: 22,
    },
    error: {
      color: theme.colors.danger,
      fontFamily: theme.fonts.medium,
      fontSize: 14,
      lineHeight: 22,
    },
    transcriptRow: {
      alignItems: "flex-start",
      borderBottomColor: theme.colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 14,
      paddingBottom: 16,
    },
    timestamp: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.medium,
      fontSize: 12,
      fontVariant: ["tabular-nums"],
      lineHeight: 24,
      minWidth: 72,
    },
    transcriptText: {
      color: theme.colors.primaryText,
      flex: 1,
      fontFamily: theme.fonts.regular,
      fontSize: 17,
      lineHeight: 26,
    },
  });
}
