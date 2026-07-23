import type { ReactNode } from "react";
import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Icon } from "./Icon";
import { useTheme, type AppTheme } from "../lib/theme";

export function AppShell({ children }: { children: ReactNode }) {
  return <View style={{ flex: 1 }}>{children}</View>;
}

export function SettingsBackButton() {
  const theme = useTheme();
  const styles = createStyles(theme);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back to Settings"
      onPress={() => router.replace("/settings")}
      style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
    >
      <Icon name="chevronLeft" size={18} color={theme.colors.primaryText} />
      <Text style={styles.backButtonText}>Settings</Text>
    </Pressable>
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
      fontFamily: theme.fonts.semibold,
      fontSize: 14,
    },
  });
}
