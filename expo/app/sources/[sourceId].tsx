import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { AppShell } from "../../components/MainNavigation";
import { Icon } from "../../components/Icon";
import { Button, Card, Field, Screen, SectionTitle } from "../../components/ui";
import { formatSyncStatus, openExternal } from "../../components/sources";
import { deleteSource, getSource, syncSource, updateSource, type SourceConfig } from "../../lib/medina";
import { getSourceTypeDef } from "../../lib/sourceTypes";
import { useTheme, type AppTheme } from "../../lib/theme";

function SourcesBackButton() {
  const theme = useTheme();
  const styles = createStyles(theme);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back to Sources"
      onPress={() => router.replace("/sources")}
      style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
    >
      <Icon name="chevronLeft" size={18} color={theme.colors.primaryText} />
      <Text style={styles.backButtonText}>Sources</Text>
    </Pressable>
  );
}

export default function SourceDetailScreen() {
  const theme = useTheme();
  const styles = createStyles(theme);
  const params = useLocalSearchParams<{ sourceId: string; gdrive?: string }>();
  const sourceId = Array.isArray(params.sourceId) ? params.sourceId[0] : params.sourceId;
  const [source, setSource] = useState<SourceConfig | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [action, setAction] = useState<"saving" | "syncing" | "deleting" | "toggling" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(params.gdrive === "connected" ? "Google Drive connected." : null);

  const applySource = (next: SourceConfig) => {
    setSource(next);
    const def = getSourceTypeDef(next.type);
    const values: Record<string, string> = {};
    for (const field of def.fields) {
      const value = (next as Record<string, unknown>)[field.key];
      values[field.key] = typeof value === "string" ? value : "";
    }
    setFieldValues(values);
    setDirty(false);
  };

  useFocusEffect(useCallback(() => {
    if (!sourceId) return;
    let cancelled = false;
    getSource(sourceId)
      .then((result) => { if (!cancelled) { applySource(result); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [sourceId]));

  if (!sourceId) return null;

  const def = source ? getSourceTypeDef(source.type) : null;

  const run = async (name: typeof action & string, fn: () => Promise<void>) => {
    setAction(name);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAction(null);
    }
  };

  const handleSave = () => run("saving", async () => {
    const patch: Record<string, string> = {};
    for (const [key, value] of Object.entries(fieldValues)) patch[key] = value.trim();
    applySource(await updateSource(sourceId, patch));
    setNotice("Saved.");
  });

  const handleSync = () => run("syncing", async () => {
    const result = await syncSource(sourceId);
    applySource(await getSource(sourceId));
    if (result.summary) {
      setNotice(result.summary.queued > 0
        ? `${result.summary.queued} file${result.summary.queued === 1 ? "" : "s"} queued for ingest.`
        : "Everything is up to date.");
    }
  });

  const handleToggle = (enabled: boolean) => run("toggling", async () => {
    applySource(await updateSource(sourceId, { enabled }));
  });

  const handleDelete = () => run("deleting", async () => {
    await deleteSource(sourceId);
    router.replace("/sources");
  });

  return (
    <AppShell>
      <Screen>
        <SourcesBackButton />
        {!source || !def ? (
          error ? <Text style={styles.errorText}>{error}</Text> : <ActivityIndicator color={theme.colors.muted} />
        ) : (
          <>
            <View style={styles.header}>
              <Icon name={def.icon} size={28} color={theme.colors.accent} />
              <View style={styles.headerText}>
                <Text style={styles.title}>{def.label}</Text>
                <Text style={styles.subtitle} numberOfLines={1}>{def.subtitle(source)}</Text>
              </View>
            </View>

            {notice ? <Text style={styles.noticeText}>{notice}</Text> : null}
            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            <Card style={styles.sectionCard}>
              <View style={styles.rowBetween}>
                <SectionTitle>Enabled</SectionTitle>
                <Switch
                  value={source.enabled !== false}
                  disabled={action !== null || !def.editable}
                  onValueChange={(value) => void handleToggle(value)}
                  trackColor={{ true: theme.colors.accentStrong, false: theme.colors.control }}
                />
              </View>
              <Text style={styles.metaText}>{formatSyncStatus(source)}</Text>
              <Button variant="secondary" onPress={() => void handleSync()} disabled={action !== null || source.enabled === false}>
                {action === "syncing" ? "Checking…" : "Sync now"}
              </Button>
            </Card>

            {def.fields.length > 0 ? (
              <Card style={styles.sectionCard}>
                <SectionTitle>Configuration</SectionTitle>
                {def.fields.map((field) => (
                  <View key={field.key} style={styles.fieldGroup}>
                    {def.editable ? (
                      <Field
                        label={field.label}
                        value={fieldValues[field.key] ?? ""}
                        onChangeText={(value) => {
                          setFieldValues((prev) => ({ ...prev, [field.key]: value }));
                          setDirty(true);
                        }}
                        placeholder={field.placeholder}
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                    ) : (
                      <View>
                        <Text style={styles.readonlyLabel}>{field.label}</Text>
                        <Text style={styles.readonlyValue}>{fieldValues[field.key] || "—"}</Text>
                      </View>
                    )}
                    {field.help ? <Text style={styles.metaText}>{field.help}</Text> : null}
                  </View>
                ))}
                {def.editable ? (
                  <Button onPress={() => void handleSave()} disabled={action !== null || !dirty}>
                    {action === "saving" ? "Saving…" : "Save"}
                  </Button>
                ) : (
                  <Text style={styles.metaText}>This source is managed by the Medina instance.</Text>
                )}
              </Card>
            ) : null}

            {def.connect ? (
              <Card style={styles.sectionCard}>
                <SectionTitle>Connection</SectionTitle>
                <Text style={styles.metaText}>
                  {source.account ? `Connected as ${source.account}. ` : ""}
                  Reconnect if syncing fails with an authorization error.
                </Text>
                <Button variant="secondary" onPress={() => openExternal(def.connect!.url(source))} disabled={action !== null}>
                  {def.connect.reconnectLabel}
                </Button>
                <Text style={styles.metaText}>{def.connect.help}</Text>
              </Card>
            ) : null}

            {def.editable ? (
              <Card style={styles.sectionCard}>
                <Button variant="secondary" onPress={() => void handleDelete()} disabled={action !== null}>
                  <Icon name="trash" size={16} color={theme.colors.danger} />
                  <Text style={styles.dangerButtonText}>{action === "deleting" ? "Removing…" : "Remove source"}</Text>
                </Button>
                <Text style={styles.metaText}>Removes the source configuration and sync state. Already-ingested files are kept.</Text>
              </Card>
            ) : null}
          </>
        )}
      </Screen>
    </AppShell>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    backButton: {
      alignItems: "center",
      alignSelf: "flex-start",
      borderRadius: theme.radii.sm,
      flexDirection: "row",
      gap: theme.space.xs,
      marginLeft: -theme.space.sm,
      paddingHorizontal: theme.space.sm,
      paddingVertical: theme.space.sm,
    },
    backButtonPressed: {
      backgroundColor: theme.colors.controlPressed,
    },
    backButtonText: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.medium,
      fontSize: 15,
    },
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: theme.space.md,
    },
    headerText: {
      flex: 1,
      gap: 2,
      minWidth: 0,
    },
    title: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.bold,
      fontSize: 26,
      letterSpacing: -0.5,
      lineHeight: 32,
    },
    subtitle: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.regular,
      fontSize: 14,
    },
    sectionCard: {
      gap: theme.space.md,
    },
    rowBetween: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
    },
    fieldGroup: {
      gap: theme.space.xs,
    },
    readonlyLabel: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.medium,
      fontSize: 14,
      marginBottom: theme.space.xs,
    },
    readonlyValue: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.regular,
      fontSize: 15,
    },
    metaText: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.regular,
      fontSize: 13,
      lineHeight: 19,
    },
    noticeText: {
      color: theme.colors.accent,
      fontFamily: theme.fonts.medium,
      fontSize: 13,
      lineHeight: 19,
    },
    errorText: {
      color: theme.colors.danger,
      fontFamily: theme.fonts.medium,
      fontSize: 13,
      lineHeight: 19,
    },
    dangerButtonText: {
      color: theme.colors.danger,
      fontFamily: theme.fonts.semibold,
      fontSize: 15,
    },
  });
}
