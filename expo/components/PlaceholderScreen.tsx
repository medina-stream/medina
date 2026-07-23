import { StyleSheet, Text, View } from "react-native";
import { useTheme, type AppTheme } from "../lib/theme";

export function PlaceholderScreen({ title }: { title: string }) {
  const theme = useTheme();
  const styles = createStyles(theme);
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.text}>Coming soon.</Text>
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.border,
      borderRadius: theme.radii.sm,
      borderWidth: 1,
      gap: theme.space.sm,
      padding: theme.space.lg,
    },
    title: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.semibold,
      fontSize: 18,
    },
    text: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.regular,
      fontSize: 14,
      lineHeight: 21,
    },
  });
}
