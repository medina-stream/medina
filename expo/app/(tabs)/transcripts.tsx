import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, StyleSheet, Text, View, type ViewToken } from "react-native";
import { AppShell } from "../../components/MainNavigation";
import { subscribeEvents } from "../../lib/events";
import { getDayTranscripts, getIntervalSummary, type Transcript } from "../../lib/medina";
import { formatClockTime } from "../../lib/timeformat";
import { useTheme, type AppTheme } from "../../lib/theme";
import { dateFromDayId, dayIdFromDate } from "../../lib/dates";

const today = new Date();
const year = today.getUTCFullYear();
const dayIds = getDayIdsBackThroughYear(today, 1900);
const transcriptViewabilityConfig = { itemVisiblePercentThreshold: 10, minimumViewTime: 80 };

type DayTranscriptsState = {
  error: string | null;
  loading: boolean;
  requested: boolean;
  coverageSeconds: number | null;
  transcripts: Transcript[];
};

function getDayIdsBackThroughYear(from: Date, endYear: number): string[] {
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const end = Date.UTC(endYear, 0, 1);
  const dayCount = Math.round((start - end) / 86_400_000) + 1;

  return Array.from({ length: dayCount }, (_, i) =>
    dayIdFromDate(new Date(start - i * 86_400_000)),
  );
}

function formatDay(dayId: string): string {
  const date = dateFromDayId(dayId);
  return date.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatAudioHours(seconds: number | null): string {
  if (seconds === null) return "";
  const hours = Math.max(0, seconds) / 3600;
  if (hours === 0) return "0h";
  if (hours < 0.1) return "<0.1h";
  if (hours < 10) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours)}h`;
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

function createInitialDayState(): DayTranscriptsState {
  return {
    error: null,
    loading: false,
    requested: false,
    coverageSeconds: null,
    transcripts: [],
  };
}

function TranscriptsDay({
  dayId,
  isVisible,
  onFetch,
  state,
}: {
  dayId: string;
  isVisible: boolean;
  onFetch: (dayId: string, options?: { force?: boolean }) => void;
  state: DayTranscriptsState;
}) {
  const theme = useTheme();
  const styles = createStyles(theme);

  useEffect(() => {
    if (isVisible && !state.requested && !state.loading) {
      onFetch(dayId);
    }
  }, [dayId, isVisible, onFetch, state.loading, state.requested]);
  const visibleTranscripts = state.transcripts;

  return (
    <View style={styles.dayCell}>
      <View style={styles.dayHeader}>
        <Text style={styles.dayTitle}>{formatDay(dayId)}</Text>
        <Text style={styles.meta}>
          {state.loading && !state.requested
            ? "Loading..."
            : state.requested
              ? formatAudioHours(state.coverageSeconds)
              : ""}
        </Text>
      </View>

      {state.error ? <Text style={styles.error}>{state.error}</Text> : null}

      {!state.requested && !state.loading ? (
        <Text style={styles.empty}>Scroll here to load transcripts.</Text>
      ) : state.loading && !state.requested ? (
        <Text style={styles.empty}>Loading transcripts...</Text>
      ) : visibleTranscripts.length === 0 ? (
        <Text style={styles.empty}>No transcripts.</Text>
      ) : visibleTranscripts.map((transcript) => (
        <View key={transcript.transcriptKey} style={styles.transcriptRow}>
          <Text style={styles.timestamp}>{formatClockTime(transcript.startTime, transcript.timeZone ?? "UTC")}</Text>
          <Text style={styles.transcriptText}>{transcript.text || "[no speech]"}</Text>
        </View>
      ))}
    </View>
  );
}

export default function TranscriptsScreen() {
  const theme = useTheme();
  const styles = createStyles(theme);
  const [visibleDayIds, setVisibleDayIds] = useState<ReadonlySet<string>>(() => new Set());
  const [dayStates, setDayStates] = useState<Record<string, DayTranscriptsState>>({});
  const fetchGenerations = useRef<Record<string, number>>({});
  const loadingDayIds = useRef<Set<string>>(new Set());
  const requestedDayIds = useRef<Set<string>>(new Set());

  const fetchDay = useCallback(async (dayId: string, options: { force?: boolean } = {}) => {
    if (!options.force && (loadingDayIds.current.has(dayId) || requestedDayIds.current.has(dayId))) {
      return;
    }

    loadingDayIds.current.add(dayId);
    setDayStates((current) => {
      const existing = current[dayId] || createInitialDayState();
      return {
        ...current,
        [dayId]: {
          ...existing,
          error: null,
          loading: true,
        },
      };
    });

    const generation = (fetchGenerations.current[dayId] || 0) + 1;
    fetchGenerations.current[dayId] = generation;

    try {
      const [next, interval] = await Promise.all([
        getDayTranscripts(dayId),
        getIntervalSummary(dayId),
      ]);
      if (fetchGenerations.current[dayId] !== generation) {
        loadingDayIds.current.delete(dayId);
        return;
      }
      loadingDayIds.current.delete(dayId);
      requestedDayIds.current.add(dayId);
      setDayStates((current) => ({
        ...current,
        [dayId]: {
          error: null,
          loading: false,
          requested: true,
          coverageSeconds: interval.coverageSeconds,
          transcripts: next,
        },
      }));
    } catch (fetchError) {
      if (fetchGenerations.current[dayId] !== generation) {
        loadingDayIds.current.delete(dayId);
        return;
      }
      loadingDayIds.current.delete(dayId);
      requestedDayIds.current.add(dayId);
      setDayStates((current) => {
        const existing = current[dayId] || createInitialDayState();
        return {
          ...current,
          [dayId]: {
            ...existing,
            error: fetchError instanceof Error ? fetchError.message : String(fetchError),
            loading: false,
            requested: true,
          },
        };
      });
    }
  }, []);

  useEffect(() => {
    return subscribeEvents((event) => {
      if (event.data?.type !== "transcript.materialized") return;

      const visible = Array.from(visibleDayIds);
      for (const dayId of visible) {
        if (matchesTranscriptEventDay(event.data, dayId)) {
          fetchDay(dayId, { force: true });
        }
      }
    });
  }, [fetchDay, visibleDayIds]);

  const handleViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken<string>[] }) => {
    const fetchVisibleDay = fetchDay;
    const nextVisibleIds = viewableItems
      .map((item) => item.item)
      .filter((item): item is string => typeof item === "string");

    setVisibleDayIds(new Set(nextVisibleIds));
    for (const dayId of nextVisibleIds) {
      fetchVisibleDay(dayId);
    }
  }).current;

  return (
    <AppShell>
      <View style={styles.screen}>
        <FlatList
          contentContainerStyle={styles.container}
          data={dayIds}
          initialNumToRender={6}
          keyExtractor={(id) => id}
          ListHeaderComponent={
            <View style={styles.headerBlock}>
              <Text style={styles.title}>{year}</Text>
            </View>
          }
          maxToRenderPerBatch={8}
          onViewableItemsChanged={handleViewableItemsChanged}
          renderItem={({ item }) => (
            <TranscriptsDay
              dayId={item}
              isVisible={visibleDayIds.has(item)}
              onFetch={fetchDay}
              state={dayStates[item] || createInitialDayState()}
            />
          )}
          style={styles.list}
          viewabilityConfig={transcriptViewabilityConfig}
          windowSize={8}
        />
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
    list: {
      flex: 1,
    },
    container: {
      paddingHorizontal: theme.space.lg,
      paddingTop: theme.space.lg,
      paddingBottom: 84,
    },
    headerBlock: {
      marginBottom: theme.space.md,
    },
    title: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.bold,
      fontSize: 30,
      letterSpacing: -0.7,
      lineHeight: 36,
    },
    dayCell: {
      borderBottomColor: theme.colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      gap: 12,
      minHeight: 116,
      paddingVertical: theme.space.lg,
    },
    dayHeader: {
      alignItems: "flex-end",
      flexDirection: "row",
      justifyContent: "space-between",
      gap: theme.space.md,
    },
    dayTitle: {
      color: theme.colors.secondaryText,
      flex: 1,
      fontFamily: theme.fonts.semibold,
      fontSize: 17,
      letterSpacing: -0.1,
      lineHeight: 22,
    },
    meta: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.medium,
      fontSize: 13,
      lineHeight: 20,
    },
    error: {
      color: theme.colors.danger,
      fontFamily: theme.fonts.medium,
      fontSize: 12,
    },
    empty: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.regular,
      fontSize: 14,
    },
    transcriptRow: {
      alignItems: "flex-start",
      borderBottomColor: theme.colors.border,
      borderBottomWidth: 1,
      flexDirection: "row",
      gap: 14,
      paddingBottom: 14,
    },
    timestamp: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.medium,
      fontSize: 12,
      fontVariant: ["tabular-nums"],
      lineHeight: 22,
      minWidth: 62,
    },
    transcriptText: {
      color: theme.colors.primaryText,
      flex: 1,
      fontFamily: theme.fonts.regular,
      fontSize: 16,
      lineHeight: 24,
    },
  });
}
