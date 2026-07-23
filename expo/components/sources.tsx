import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import * as Linking from "expo-linking";
import { Icon } from "./Icon";
import { type SourceConfig } from "../lib/medina";
import { getSourceTypeDef } from "../lib/sourceTypes";
import { useTheme, type AppTheme } from "../lib/theme";

export function openExternal(url: string) {
  if (Platform.OS === "web") {
    window.location.assign(url);
  } else {
    void Linking.openURL(url);
  }
}

export function formatSyncStatus(source: SourceConfig): string {
  if (source.enabled === false) return "Disabled";
  if (source.lastSyncError) return `Sync failed: ${source.lastSyncError}`;
  const summary = source.lastSyncSummary;
  if (!summary) return "Never synced";
  const finished = new Date(summary.finishedAt);
  const when = Number.isNaN(finished.getTime()) ? summary.finishedAt : finished.toLocaleString();
  const parts = [`${summary.queued} queued`, `${summary.skipped} up to date`];
  if (summary.errors > 0) parts.push(`${summary.errors} errors`);
  return `Last sync ${when} · ${parts.join(", ")}`;
}

export function SourceList({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  const styles = createStyles(theme);
  return <View style={styles.list}>{children}</View>;
}

export function SourceListRow({ source, onPress, last = false }: {
  source: SourceConfig;
  onPress: () => void;
  last?: boolean;
}) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const def = getSourceTypeDef(source.type);
  const hasErrors = Boolean(source.lastSyncError) || (source.lastSyncSummary?.errors ?? 0) > 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${def.label} source`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, last && styles.rowLast, pressed && styles.rowPressed]}
    >
      <View style={styles.rowIcon}>
        <Icon name={def.icon} size={20} color={theme.colors.accent} />
      </View>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle} numberOfLines={1}>{def.label}</Text>
        <Text style={styles.rowSubtitle} numberOfLines={1}>{def.subtitle(source)}</Text>
        <Text style={[styles.rowMeta, hasErrors && styles.rowMetaError]} numberOfLines={1}>
          {formatSyncStatus(source)}
        </Text>
      </View>
      <Icon name="chevronRight" size={18} color={theme.colors.muted} />
    </Pressable>
  );
}

export function AddSourceRow({ label, icon, onPress, last = false }: {
  label: string;
  icon: Parameters<typeof Icon>[0]["name"];
  onPress: () => void;
  last?: boolean;
}) {
  const theme = useTheme();
  const styles = createStyles(theme);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, last && styles.rowLast, pressed && styles.rowPressed]}
    >
      <View style={styles.rowIcon}>
        <Icon name={icon} size={20} color={theme.colors.accent} />
      </View>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle} numberOfLines={1}>{label}</Text>
      </View>
      <Icon name="plus" size={18} color={theme.colors.muted} />
    </Pressable>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    list: {
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.border,
      borderRadius: theme.radii.sm,
      borderWidth: 1,
      overflow: "hidden",
    },
    row: {
      alignItems: "center",
      borderBottomColor: theme.colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: theme.space.md,
      paddingHorizontal: theme.space.lg,
      paddingVertical: theme.space.lg,
      width: "100%",
    },
    rowLast: {
      borderBottomWidth: 0,
    },
    rowPressed: {
      opacity: 0.58,
    },
    rowIcon: {
      alignItems: "center",
      justifyContent: "center",
      width: 28,
    },
    rowMain: {
      flex: 1,
      gap: 2,
      minWidth: 0,
    },
    rowTitle: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.medium,
      fontSize: 16,
    },
    rowSubtitle: {
      color: theme.colors.secondaryText,
      fontFamily: theme.fonts.regular,
      fontSize: 13,
    },
    rowMeta: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.regular,
      fontSize: 12,
    },
    rowMetaError: {
      color: theme.colors.danger,
    },
  });
}
