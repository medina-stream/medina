import { useColorScheme } from "react-native";

export const fonts = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
  mono: "Inter_500Medium",
};

const palette = {
  blue: "#4aa8ff",
  blueDark: "#2f8ee8",
  red: "#ff4d45",
  redSoftDark: "#331618",
  redSoftLight: "#fff0ef",
};

export const darkTheme = {
  dark: true,
  colors: {
    accent: palette.blue,
    accentStrong: palette.blueDark,
    background: "#101010",
    border: "#2a2a2a",
    card: "#171717",
    control: "#242424",
    controlPressed: "#2d2d2d",
    danger: palette.red,
    dangerSoft: palette.redSoftDark,
    header: "#101010",
    icon: "#d8d8d8",
    muted: "#8b8b8b",
    overlay: "rgba(0,0,0,0.46)",
    playhead: "#ffffff",
    recordButton: "#ea444d",
    recordButtonIcon: "#fff6f4",
    recordingAvatar: "#2e2b25",
    recordingAvatarBorder: "#403c34",
    recordingBackground: "#080806",
    recordingMutedText: "#8c867a",
    recordingPrimaryText: "#f4f0e9",
    primaryText: "#f4f4f4",
    secondaryText: "#c8c8c8",
    shadow: "#000000",
    surface: "#151515",
    timeline: "#202020",
  },
  fonts,
  radii: {
    sm: 8,
    md: 12,
    lg: 18,
    pill: 999,
  },
  space: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    xxl: 28,
  },
};

export const lightTheme = {
  ...darkTheme,
  dark: false,
  colors: {
    accent: "#147bd1",
    accentStrong: "#0c66b3",
    background: "#f7f7f4",
    border: "#deded8",
    card: "#ffffff",
    control: "#ededeb",
    controlPressed: "#dededb",
    danger: "#d92d20",
    dangerSoft: palette.redSoftLight,
    header: "#f7f7f4",
    icon: "#333333",
    muted: "#73736f",
    overlay: "rgba(0,0,0,0.24)",
    playhead: "#111111",
    recordButton: "#ea444d",
    recordButtonIcon: "#fff6f4",
    recordingAvatar: "#ffffff",
    recordingAvatarBorder: "#deded8",
    recordingBackground: "#fbfaf7",
    recordingMutedText: "#73736f",
    recordingPrimaryText: "#151515",
    primaryText: "#151515",
    secondaryText: "#454545",
    shadow: "#000000",
    surface: "#ffffff",
    timeline: "#e9e9e5",
  },
};

export type AppTheme = typeof darkTheme;

export function useTheme(): AppTheme {
  return useColorScheme() === "light" ? lightTheme : darkTheme;
}
