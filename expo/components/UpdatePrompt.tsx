import { useEffect, useRef, useState } from "react";
import * as Updates from "expo-updates";
import {
  AppState,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AppStateStatus,
} from "react-native";
import { Button } from "./ui";
import { useTheme, type AppTheme } from "../lib/theme";

type UpdatePromptState = {
  availableAt: string;
  downloaded: boolean;
  error: string | null;
  message: string;
  visible: boolean;
};

function initialUpdatePromptState(): UpdatePromptState {
  return {
    availableAt: "",
    downloaded: false,
    error: null,
    message: "Checking for a Medina update…",
    visible: false,
  };
}

function formatUpdateTimestamp(date: Date | undefined) {
  return date ? date.toLocaleString() : "now";
}

function manifestCreatedAt(manifest: Updates.Manifest | undefined) {
  if (manifest && "createdAt" in manifest && typeof manifest.createdAt === "string") {
    return new Date(manifest.createdAt);
  }
  return undefined;
}

export function UpdatePrompt() {
  const theme = useTheme();
  const styles = createStyles(theme);
  const updateState = Updates.useUpdates();
  const [prompt, setPrompt] = useState<UpdatePromptState>(() => initialUpdatePromptState());
  const hasCheckedOnLaunch = useRef(false);
  const lastForegroundCheckAt = useRef(0);

  async function checkForUpdate(showChecking = false) {
    if (!Updates.isEnabled) return;
    if (showChecking) {
      setPrompt((current) => ({
        ...current,
        error: null,
        message: "Checking for a Medina update…",
        visible: true,
      }));
    }

    try {
      const result = await Updates.checkForUpdateAsync();
      if (result.isAvailable || result.isRollBackToEmbedded) {
        setPrompt({
          availableAt: result.isAvailable ? formatUpdateTimestamp(manifestCreatedAt(result.manifest)) : "now",
          downloaded: false,
          error: null,
          message: "A Medina update is ready to download.",
          visible: true,
        });
      } else if (showChecking) {
        setPrompt((current) => ({
          ...current,
          error: null,
          message: "You’re already on the latest available update.",
          visible: true,
        }));
      }
    } catch (error) {
      if (showChecking) {
        setPrompt((current) => ({
          ...current,
          error: (error as Error).message,
          message: "Couldn’t check for updates.",
          visible: true,
        }));
      }
    }
  }

  async function downloadUpdate() {
    setPrompt((current) => ({
      ...current,
      error: null,
      message: "Downloading update…",
      visible: true,
    }));

    try {
      const result = await Updates.fetchUpdateAsync();
      if (result.isNew || result.isRollBackToEmbedded) {
        setPrompt((current) => ({
          ...current,
          downloaded: true,
          error: null,
          message: "Update downloaded. Restart Medina to apply it.",
          visible: true,
        }));
      } else {
        setPrompt((current) => ({
          ...current,
          downloaded: false,
          error: null,
          message: "No newer update was downloaded.",
          visible: true,
        }));
      }
    } catch (error) {
      setPrompt((current) => ({
        ...current,
        error: (error as Error).message,
        message: "Couldn’t download the update.",
        visible: true,
      }));
    }
  }

  async function restartNow() {
    setPrompt((current) => ({
      ...current,
      error: null,
      message: "Restarting Medina…",
      visible: true,
    }));

    try {
      await Updates.reloadAsync();
    } catch (error) {
      setPrompt((current) => ({
        ...current,
        error: (error as Error).message,
        message: "Couldn’t restart Medina.",
        visible: true,
      }));
    }
  }

  useEffect(() => {
    if (!Updates.isEnabled || hasCheckedOnLaunch.current) return;
    hasCheckedOnLaunch.current = true;
    void checkForUpdate();
  }, []);

  useEffect(() => {
    if (!Updates.isEnabled) return;
    const subscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      if (nextState !== "active") return;
      const now = Date.now();
      if (now - lastForegroundCheckAt.current < 300000) return;
      lastForegroundCheckAt.current = now;
      void checkForUpdate();
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (updateState.isUpdatePending) {
      setPrompt({
        availableAt: formatUpdateTimestamp(updateState.downloadedUpdate?.createdAt),
        downloaded: true,
        error: updateState.downloadError?.message ?? null,
        message: "Update downloaded. Restart Medina to apply it.",
        visible: true,
      });
      return;
    }

    if (updateState.isUpdateAvailable) {
      setPrompt({
        availableAt: formatUpdateTimestamp(updateState.availableUpdate?.createdAt),
        downloaded: false,
        error: updateState.checkError?.message ?? null,
        message: "A Medina update is available.",
        visible: true,
      });
    }
  }, [
    updateState.availableUpdate,
    updateState.checkError,
    updateState.downloadError,
    updateState.downloadedUpdate,
    updateState.isUpdateAvailable,
    updateState.isUpdatePending,
  ]);

  if (!Updates.isEnabled) return null;

  return (
    <Modal
      animationType="fade"
      transparent
      visible={prompt.visible}
      onRequestClose={() => setPrompt((current) => ({ ...current, visible: false }))}
    >
      <View style={styles.modalRoot}>
        <Pressable
          style={styles.scrim}
          onPress={() => setPrompt((current) => ({ ...current, visible: false }))}
        />
        <View style={styles.card}>
          <Text style={styles.title}>{prompt.downloaded ? "Restart to update" : "Update available"}</Text>
          <Text style={styles.message}>{prompt.message}</Text>
          {prompt.availableAt ? <Text style={styles.meta}>Published {prompt.availableAt}</Text> : null}
          {prompt.error ? <Text style={styles.error}>{prompt.error}</Text> : null}
          <View style={styles.actions}>
            <Button
              variant="secondary"
              style={styles.button}
              onPress={() => setPrompt((current) => ({ ...current, visible: false }))}
            >
              Later
            </Button>
            {prompt.downloaded ? (
              <Button style={styles.button} onPress={restartNow} disabled={updateState.isRestarting}>
                {updateState.isRestarting ? "Restarting…" : "Restart now"}
              </Button>
            ) : (
              <Button style={styles.button} onPress={downloadUpdate} disabled={updateState.isDownloading}>
                {updateState.isDownloading ? "Downloading…" : "Download"}
              </Button>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    modalRoot: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
      padding: theme.space.xl,
    },
    scrim: {
      backgroundColor: theme.colors.overlay,
      bottom: 0,
      left: 0,
      position: "absolute",
      right: 0,
      top: 0,
    },
    card: {
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.border,
      borderRadius: theme.radii.md,
      borderWidth: 1,
      gap: theme.space.md,
      maxWidth: 420,
      padding: theme.space.xl,
      width: "100%",
    },
    title: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.bold,
      fontSize: 20,
    },
    message: {
      color: theme.colors.secondaryText,
      fontFamily: theme.fonts.regular,
      fontSize: 15,
      lineHeight: 22,
    },
    meta: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.medium,
      fontSize: 13,
    },
    error: {
      color: theme.colors.danger,
      fontFamily: theme.fonts.medium,
      fontSize: 13,
    },
    actions: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.space.sm,
      justifyContent: "flex-end",
      marginTop: theme.space.sm,
    },
    button: {
      minWidth: 128,
      paddingHorizontal: theme.space.lg,
    },
  });
}
