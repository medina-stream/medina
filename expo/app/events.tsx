import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { AppShell, SettingsBackButton } from "../components/MainNavigation";
import { Icon } from "../components/Icon";
import { subscribeEvents, type ServerEvent } from "../lib/events";
import { getEvents } from "../lib/medina";
import { useTheme, type AppTheme } from "../lib/theme";

const eventLimit = 100;
const previewMaxLength = 180;

function getEventType(event: ServerEvent): string {
  return typeof event.data?.type === "string" ? event.data.type : "event";
}

function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatEventDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatEventPreview(data: Record<string, unknown>): string {
  const entries = Object.entries(data).filter(([key]) => key !== "type");
  if (entries.length === 0) return "No payload fields";

  const text = entries
    .map(([key, value]) => `${key}: ${formatValue(value)}`)
    .join(" · ");
  return text.length > previewMaxLength ? `${text.slice(0, previewMaxLength - 1)}…` : text;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function mergeEvents(current: ServerEvent[], incoming: ServerEvent[]): ServerEvent[] {
  const byId = new Map<string, ServerEvent>();
  for (const event of [...incoming, ...current]) {
    byId.set(event.id, event);
  }

  return [...byId.values()]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, eventLimit);
}

export default function EventsScreen() {
  const theme = useTheme();
  const styles = createStyles(theme);
  const [events, setEvents] = useState<ServerEvent[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(false);
  const fetchGeneration = useRef(0);

  const fetchEvents = useCallback(async () => {
    const generation = ++fetchGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const next = await getEvents(eventLimit);
      if (generation !== fetchGeneration.current) return;
      setEvents((current) => mergeEvents(current, next));
    } catch (fetchError) {
      if (generation !== fetchGeneration.current) return;
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      if (generation === fetchGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  useEffect(() => {
    setLive(true);
    const unsubscribe = subscribeEvents((event) => {
      setEvents((current) => mergeEvents(current, [event]));
    });
    return () => {
      setLive(false);
      unsubscribe();
    };
  }, []);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <AppShell>
      <View style={styles.screen}>
        <View style={styles.header}>
          <View style={styles.titleBlock}>
            <SettingsBackButton />
            <Text style={styles.eyebrow}>Live stream</Text>
            <Text style={styles.title}>Events</Text>
            <Text style={styles.meta}>
              {loading ? "Loading..." : `${events.length} recent event${events.length === 1 ? "" : "s"}`} · {live ? "listening" : "offline"}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh events"
            onPress={fetchEvents}
            style={({ pressed }) => [styles.refreshButton, pressed && styles.refreshButtonPressed]}
          >
            <Icon name="refresh" size={16} color={theme.colors.primaryText} />
            <Text style={styles.refreshText}>Refresh</Text>
          </Pressable>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {events.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>No events yet.</Text>
              <Text style={styles.emptyText}>New websocket events will appear here as they are received.</Text>
            </View>
          ) : events.map((event) => {
            const expanded = expandedIds.has(event.id);
            return (
              <Pressable key={event.id} onPress={() => toggleExpanded(event.id)} style={styles.eventCard}>
                <View style={styles.eventHeader}>
                  <View style={styles.eventTitleBlock}>
                    <Text style={styles.eventType}>{getEventType(event)}</Text>
                    <Text style={styles.eventPreview}>{formatEventPreview(event.data)}</Text>
                  </View>
                  <View style={styles.timeBlock}>
                    <Text style={styles.time}>{formatEventTime(event.createdAt)}</Text>
                    <Text style={styles.date}>{formatEventDate(event.createdAt)}</Text>
                  </View>
                </View>

                {expanded ? (
                  <View style={styles.detailBlock}>
                    <Text style={styles.detailLabel}>{event.id}</Text>
                    <Text style={styles.json}>{formatJson(event.data)}</Text>
                  </View>
                ) : null}
              </Pressable>
            );
          })}
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
      borderBottomWidth: 1,
      flexDirection: "row",
      gap: theme.space.lg,
      justifyContent: "space-between",
      padding: theme.space.xl,
    },
    titleBlock: {
      flex: 1,
      gap: 4,
      minWidth: 0,
    },
    eyebrow: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.medium,
      fontSize: 13,
      letterSpacing: 0.3,
    },
    title: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.bold,
      fontSize: 30,
      letterSpacing: -0.7,
      lineHeight: 36,
    },
    meta: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.regular,
      fontSize: 13,
    },
    refreshButton: {
      alignItems: "center",
      backgroundColor: theme.colors.control,
      borderColor: theme.colors.border,
      borderRadius: theme.radii.sm,
      borderWidth: 1,
      flexDirection: "row",
      gap: 8,
      paddingHorizontal: theme.space.md,
      paddingVertical: theme.space.sm,
    },
    refreshButtonPressed: {
      backgroundColor: theme.colors.controlPressed,
    },
    refreshText: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.semibold,
      fontSize: 13,
    },
    error: {
      color: theme.colors.danger,
      fontFamily: theme.fonts.medium,
      paddingHorizontal: theme.space.xl,
      paddingTop: theme.space.md,
    },
    scroll: {
      flex: 1,
    },
    content: {
      gap: theme.space.md,
      padding: theme.space.xl,
      paddingBottom: 50,
    },
    emptyCard: {
      backgroundColor: theme.colors.card,
      borderColor: theme.colors.border,
      borderRadius: theme.radii.md,
      borderWidth: 1,
      gap: 6,
      padding: theme.space.xl,
    },
    emptyTitle: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.semibold,
      fontSize: 16,
    },
    emptyText: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.regular,
      fontSize: 14,
      lineHeight: 20,
    },
    eventCard: {
      backgroundColor: theme.colors.card,
      borderColor: theme.colors.border,
      borderRadius: theme.radii.md,
      borderWidth: 1,
      padding: theme.space.lg,
    },
    eventHeader: {
      alignItems: "flex-start",
      flexDirection: "row",
      gap: theme.space.md,
      justifyContent: "space-between",
    },
    eventTitleBlock: {
      flex: 1,
      gap: 6,
      minWidth: 0,
    },
    eventType: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.semibold,
      fontSize: 16,
      letterSpacing: -0.1,
    },
    eventPreview: {
      color: theme.colors.secondaryText,
      fontFamily: theme.fonts.regular,
      fontSize: 13,
      lineHeight: 19,
    },
    timeBlock: {
      alignItems: "flex-end",
      gap: 3,
    },
    time: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.medium,
      fontSize: 13,
      fontVariant: ["tabular-nums"],
    },
    date: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.regular,
      fontSize: 12,
    },
    detailBlock: {
      borderTopColor: theme.colors.border,
      borderTopWidth: 1,
      gap: theme.space.sm,
      marginTop: theme.space.md,
      paddingTop: theme.space.md,
    },
    detailLabel: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.medium,
      fontSize: 12,
    },
    json: {
      color: theme.colors.secondaryText,
      fontFamily: theme.fonts.mono,
      fontSize: 12,
      lineHeight: 18,
    },
  });
}
