import { useCallback, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { AppShell, SettingsBackButton } from "../../components/MainNavigation";
import { Screen, SectionTitle } from "../../components/ui";
import { AddSourceRow, SourceList, SourceListRow, openExternal } from "../../components/sources";
import { getSources, type SourceConfig } from "../../lib/medina";
import { addableSourceTypes } from "../../lib/sourceTypes";
import { useTheme, type AppTheme } from "../../lib/theme";

export default function SourcesScreen() {
  const theme = useTheme();
  const styles = createStyles(theme);
  const params = useLocalSearchParams<{ gdrive?: string; message?: string }>();
  const [sources, setSources] = useState<SourceConfig[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    getSources()
      .then((result) => { if (!cancelled) { setSources(result.sources); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, []));

  const connectError = params.gdrive === "error"
    ? `Google Drive connection failed: ${params.message ?? "unknown error"}`
    : null;

  return (
    <AppShell>
      <Screen>
        <SettingsBackButton />
        <Text style={styles.title}>Sources</Text>
        <Text style={styles.helpText}>
          Sources feed your context lake. Medina syncs each enabled source automatically and ingests new files.
        </Text>
        {connectError ? <Text style={styles.errorText}>{connectError}</Text> : null}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {sources === null && !error ? (
          <ActivityIndicator color={theme.colors.muted} />
        ) : sources && sources.length > 0 ? (
          <SourceList>
            {sources.map((source, index) => (
              <SourceListRow
                key={source.id}
                source={source}
                last={index === sources.length - 1}
                onPress={() => router.push({ pathname: "/sources/[sourceId]", params: { sourceId: source.id } })}
              />
            ))}
          </SourceList>
        ) : sources ? (
          <Text style={styles.helpText}>No sources configured yet. Add one below.</Text>
        ) : null}

        <View style={styles.addSection}>
          <SectionTitle>Add a source</SectionTitle>
          <SourceList>
            {addableSourceTypes().map((def, index, all) => (
              <AddSourceRow
                key={def.type}
                label={def.label}
                icon={def.icon}
                last={index === all.length - 1}
                onPress={() => openExternal(def.connect!.url())}
              />
            ))}
          </SourceList>
          <Text style={styles.helpText}>
            Filesystem and other instance-managed sources are configured by the server operator and appear here automatically.
          </Text>
        </View>
      </Screen>
    </AppShell>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    title: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.bold,
      fontSize: 30,
      letterSpacing: -0.7,
      lineHeight: 36,
    },
    helpText: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.regular,
      fontSize: 13,
      lineHeight: 19,
    },
    errorText: {
      color: theme.colors.danger,
      fontFamily: theme.fonts.medium,
      fontSize: 13,
      lineHeight: 19,
    },
    addSection: {
      gap: theme.space.sm,
      marginTop: theme.space.md,
    },
  });
}
