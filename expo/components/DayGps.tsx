import { Image, StyleSheet, Text, View } from "react-native";
import { formatTimeRange } from "../lib/timeformat";
import { useTheme, type AppTheme } from "../lib/theme";
import { type GpsDay, type GpsDaySegment } from "../lib/medina";

function formatDistance(distanceMeters?: number): string {
  if (typeof distanceMeters !== "number" || !Number.isFinite(distanceMeters) || distanceMeters <= 0) {
    return "";
  }
  if (distanceMeters >= 1000) return `${(distanceMeters / 1000).toFixed(1)} km`;
  return `${Math.round(distanceMeters)} m`;
}

function formatSegmentLabel(segment: GpsDaySegment): string {
  if (segment.kind === "stay") {
    return segment.place ? `at ${segment.place}` : "stayed";
  }

  const mode = segment.mode || "traveled";
  const distance = formatDistance(segment.distanceMeters);
  return distance ? `${mode} ${distance}` : mode;
}

function formatSegmentTime(gps: GpsDay, segment: GpsDaySegment): string {
  return formatTimeRange(segment.startTime, segment.endTime, segment.timeZone, {
    withZoneAbbr: gps.multiZone || segment.timeZone !== gps.dominantTimeZone,
  });
}

export function GpsDaySection({ gps, mapUrl }: { gps: GpsDay; mapUrl: string }) {
  const theme = useTheme();
  const styles = createStyles(theme);

  return (
    <View style={styles.section}>
      <Image
        accessibilityLabel="Map of the day's GPS trace"
        resizeMode="cover"
        source={{ uri: mapUrl }}
        style={styles.map}
      />
      <Text style={styles.summary}>{gps.summary}</Text>
      {gps.segments.length > 0 ? (
        <View style={styles.timeline}>
          {gps.segments.map((segment) => {
            const key = `${segment.kind}:${segment.startTime}:${segment.endTime}:${segment.place ?? segment.mode ?? ""}`;
            return (
              <View key={key} style={styles.timelineRow}>
                <Text style={styles.timelineTime}>{formatSegmentTime(gps, segment)}</Text>
                <Text style={styles.timelineLabel}>{formatSegmentLabel(segment)}</Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    section: {
      borderBottomColor: theme.colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      gap: theme.space.md,
      paddingBottom: theme.space.lg,
    },
    map: {
      aspectRatio: 1,
      backgroundColor: theme.colors.control,
      borderRadius: 12,
      width: "100%",
    },
    summary: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.regular,
      fontSize: 16,
      lineHeight: 24,
    },
    timeline: {
      gap: theme.space.sm,
    },
    timelineRow: {
      alignItems: "flex-start",
      flexDirection: "row",
      gap: theme.space.md,
    },
    timelineTime: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.medium,
      fontSize: 13,
      fontVariant: ["tabular-nums"],
      lineHeight: 20,
      minWidth: 120,
    },
    timelineLabel: {
      color: theme.colors.primaryText,
      flex: 1,
      fontFamily: theme.fonts.regular,
      fontSize: 14,
      lineHeight: 20,
    },
  });
}
