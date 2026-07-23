import { type ReactNode } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type ScrollViewProps,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { useTheme, type AppTheme } from "../lib/theme";

type ScreenProps = ScrollViewProps & {
  children: ReactNode;
  padded?: boolean;
};

export function Screen({ children, contentContainerStyle, padded = true, ...props }: ScreenProps) {
  const theme = useTheme();
  const styles = createStyles(theme);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={[
        padded && styles.screenContent,
        contentContainerStyle,
      ]}
      {...props}
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  const styles = createStyles(theme);
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const styles = createStyles(theme);
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

type ButtonProps = PressableProps & {
  children: ReactNode;
  variant?: "primary" | "secondary";
};

export function Button({ children, disabled, style, variant = "primary", ...props }: ButtonProps) {
  const theme = useTheme();
  const styles = createStyles(theme);
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        variant === "primary" ? styles.primaryButton : styles.secondaryButton,
        pressed && styles.pressed,
        disabled && styles.disabled,
        typeof style === "function" ? style({ pressed }) : style,
      ]}
      {...props}
    >
      {typeof children === "string" ? (
        <Text style={[styles.buttonText, variant === "primary" && styles.primaryButtonText]}>{children}</Text>
      ) : children}
    </Pressable>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const theme = useTheme();
  const styles = createStyles(theme);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        placeholderTextColor={theme.colors.muted}
        style={styles.input}
        {...props}
      />
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    scroll: {
      flex: 1,
    },
    screenContent: {
      gap: theme.space.lg,
      padding: theme.space.xl,
      paddingBottom: theme.space.xxl,
    },
    card: {
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.border,
      borderRadius: theme.radii.sm,
      borderWidth: 1,
      padding: theme.space.lg,
    },
    sectionTitle: {
      color: theme.colors.secondaryText,
      fontFamily: theme.fonts.semibold,
      fontSize: 16,
      marginBottom: theme.space.sm,
    },
    button: {
      alignItems: "center",
      borderRadius: theme.radii.sm,
      flexDirection: "row",
      gap: theme.space.sm,
      justifyContent: "center",
      paddingHorizontal: theme.space.lg,
      paddingVertical: theme.space.md,
    },
    primaryButton: {
      backgroundColor: theme.colors.accentStrong,
    },
    secondaryButton: {
      backgroundColor: theme.colors.control,
      borderColor: theme.colors.border,
      borderWidth: 1,
    },
    buttonText: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.semibold,
      fontSize: 15,
    },
    primaryButtonText: {
      color: "#ffffff",
    },
    pressed: {
      opacity: 0.82,
    },
    disabled: {
      opacity: 0.6,
    },
    field: {
      gap: theme.space.sm,
    },
    label: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.medium,
      fontSize: 14,
    },
    input: {
      backgroundColor: theme.colors.control,
      borderColor: theme.colors.border,
      borderRadius: theme.radii.sm,
      borderWidth: 1,
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.regular,
      fontSize: 16,
      padding: theme.space.md,
    },
  });
}
