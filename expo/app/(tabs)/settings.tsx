import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { Icon } from "../../components/Icon";
import { AppShell } from "../../components/MainNavigation";
import { Button, Card, Field, Screen, SectionTitle } from "../../components/ui";
import { loadSettings, saveSettings } from "../../lib/settings";
import { useServerStatus } from "../../lib/useServerStatus";
import { useTheme, type AppTheme } from "../../lib/theme";
import {
  getNotificationStatus,
  requestNotificationPermission,
  subscribeNotificationStatus,
  type MedinaNotificationStatus,
} from "../../lib/notifications";

function connectionTone(options: {
  error: string | null;
  isLoading: boolean;
  ok?: boolean;
  serverUrl: string;
}): "good" | "warning" | "danger" {
  if (!options.serverUrl.trim()) return "danger";
  if (options.isLoading) return "warning";
  if (options.ok) return "good";
  if (options.error) return "danger";
  return "warning";
}

function StatusPill({ tone, children, styles }: {
  tone: "good" | "warning" | "danger";
  children: string;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={[styles.pill, styles[`${tone}Pill`]]}>
      <Text style={[styles.pillText, styles[`${tone}PillText`]]}>{children}</Text>
    </View>
  );
}

function SettingsLinkRow({ href, label, last = false, styles }: {
  href: "/sync" | "/sources" | "/speakers" | "/events" | "/privacy" | "/support" | "/feedback";
  label: string;
  last?: boolean;
  styles: ReturnType<typeof createStyles>;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => router.push(href)}
      style={({ pressed }) => [styles.linkRow, last && styles.linkRowLast, pressed && styles.linkRowPressed]}
    >
      <Text style={styles.linkRowText}>{label}</Text>
      <Icon name="chevronRight" size={18} color={theme.colors.muted} />
    </Pressable>
  );
}

function SaveCheckButton({ disabled, isSaving, onPress, styles, theme }: {
  disabled?: boolean;
  isSaving: boolean;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Save server settings"
      accessibilityState={{ busy: isSaving, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.saveIconButton,
        pressed && styles.saveIconButtonPressed,
        disabled && styles.saveIconButtonDisabled,
      ]}
    >
      {isSaving ? (
        <ActivityIndicator color={theme.colors.muted} size="small" />
      ) : (
        <Icon name="check" size={22} color="#ffffff" />
      )}
    </Pressable>
  );
}

export default function SetupScreen() {
  const theme = useTheme();
  const styles = createStyles(theme);
  const { error, isLoading, refresh, serverOnline, status } = useServerStatus();
  const [initialSettings] = useState(() => loadSettings());
  const [serverUrl, setServerUrl] = useState(() => initialSettings.serverUrl);
  const [token, setToken] = useState(() => initialSettings.token);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [notificationStatus, setNotificationStatus] = useState<MedinaNotificationStatus>(() => getNotificationStatus());
  const [requestingNotifications, setRequestingNotifications] = useState(false);

  useEffect(() => {
    const unsubscribeNotifications = subscribeNotificationStatus(setNotificationStatus);
    return unsubscribeNotifications;
  }, []);

  const tone = connectionTone({ error, isLoading, ok: status?.ok, serverUrl });

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const next = saveSettings(serverUrl, token);
      setServerUrl(next.serverUrl);
      setToken(next.token);
      setSaveError(null);
      await refresh();
    } catch (nextError) {
      setSaveError((nextError as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleEnableNotifications = async () => {
    setRequestingNotifications(true);
    try {
      setNotificationStatus(await requestNotificationPermission());
    } finally {
      setRequestingNotifications(false);
    }
  };

  return (
    <AppShell>
      <Screen>
        <Text style={styles.title}>Settings</Text>
        <Card style={styles.sectionCard}>
          <Field
            label="Endpoint"
            value={serverUrl}
            onChangeText={setServerUrl}
            placeholder="https://your.medina.server"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Field
            label="Token"
            value={token}
            onChangeText={setToken}
            placeholder="Optional access token"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            textContentType="password"
          />
          <View style={styles.connectionFooter}>
            <StatusPill tone={tone} styles={styles}>
              {isLoading ? "Checking" : serverOnline ? "Connected" : "Needs attention"}
            </StatusPill>
            <SaveCheckButton
              disabled={isSaving}
              isSaving={isSaving}
              onPress={() => void handleSave()}
              styles={styles}
              theme={theme}
            />
          </View>
          {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}
        </Card>

        <Card style={styles.sectionCard}>
          <View style={styles.cardTitleRow}>
            <Icon name="bell" size={18} color={theme.colors.accent} />
            <SectionTitle>Notifications</SectionTitle>
          </View>
          {notificationStatus.lastError ? <Text style={styles.errorText}>{notificationStatus.lastError}</Text> : null}
          {!notificationStatus.enabled && notificationStatus.permission !== "unsupported" ? (
            <Button onPress={handleEnableNotifications} disabled={requestingNotifications}>
              {requestingNotifications ? "Requesting…" : "Enable notifications"}
            </Button>
          ) : null}
        </Card>

        <View style={styles.linkList}>
          <SettingsLinkRow href="/sync" label="Sync state" styles={styles} />
          <SettingsLinkRow href="/sources" label="Sources" styles={styles} />
          <SettingsLinkRow href="/speakers" label="Voiceprints" styles={styles} />
          <SettingsLinkRow href="/events" label="Events" styles={styles} />
          <SettingsLinkRow href="/privacy" label="Privacy" styles={styles} />
          <SettingsLinkRow href="/support" label="Support" styles={styles} />
          <SettingsLinkRow href="/feedback" label="Send feedback" last styles={styles} />
        </View>

        <Text style={styles.versionFooter}>Medina 1.0.1 (bundled 12 hours ago)</Text>
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
    sectionCard: {
      gap: theme.space.lg,
    },
    linkList: {
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.border,
      borderRadius: theme.radii.sm,
      borderWidth: 1,
      overflow: "hidden",
    },
    linkRow: {
      alignItems: "center",
      borderBottomColor: theme.colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingHorizontal: theme.space.lg,
      paddingVertical: theme.space.lg,
      width: "100%",
    },
    linkRowLast: {
      borderBottomWidth: 0,
    },
    linkRowPressed: {
      opacity: 0.58,
    },
    linkRowText: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.medium,
      fontSize: 16,
    },
    versionFooter: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.regular,
      fontSize: 13,
      lineHeight: 19,
      textAlign: "center",
    },
    connectionFooter: {
      alignItems: "center",
      flexDirection: "row",
      gap: theme.space.md,
      justifyContent: "flex-end",
    },
    saveIconButton: {
      alignItems: "center",
      backgroundColor: theme.colors.accentStrong,
      borderRadius: theme.radii.pill,
      height: 36,
      justifyContent: "center",
      width: 36,
    },
    saveIconButtonPressed: {
      opacity: 0.82,
    },
    saveIconButtonDisabled: {
      backgroundColor: theme.colors.control,
    },
    cardTitleRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: theme.space.sm,
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
  });
}
