import { useEffect } from "react";
import { Stack } from "expo-router";
import { useFonts } from "expo-font";
import { StatusBar } from "expo-status-bar";
import { Platform, StyleSheet, View, useWindowDimensions } from "react-native";
import { startUploadLoop, stopUploadLoop } from "../lib/uploader";
import { initializeNotifications } from "../lib/notifications";
import { UpdatePrompt } from "../components/UpdatePrompt";
import { useTheme } from "../lib/theme";

export default function RootLayout() {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const [fontsLoaded] = useFonts({
    Inter_400Regular: require("@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf"),
    Inter_500Medium: require("@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf"),
    Inter_600SemiBold: require("@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf"),
    Inter_700Bold: require("@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf"),
  });

  useEffect(() => {
    void initializeNotifications();
    startUploadLoop();
    return () => {
      stopUploadLoop();
    };
  }, []);

  if (!fontsLoaded) return null;

  const app = (
    <>
      <StatusBar style={theme.dark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          contentStyle: { backgroundColor: theme.colors.recordingBackground },
          headerShown: false,
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="day/[dayId]" />
        <Stack.Screen name="events" />
        <Stack.Screen name="sources/index" />
        <Stack.Screen name="sources/[sourceId]" />
        <Stack.Screen name="speakers" />
        <Stack.Screen name="privacy" />
        <Stack.Screen name="support" />
        <Stack.Screen name="feedback" />
        <Stack.Screen name="account" />
        <Stack.Screen name="setup" />
      </Stack>
      <UpdatePrompt />
    </>
  );

  if (Platform.OS !== "web" || width < desktopInsetBreakpoint) return app;

  return (
    <View style={[styles.desktopBackdrop, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.desktopFrame, { backgroundColor: theme.colors.recordingBackground, shadowColor: theme.colors.shadow }]}>
        {app}
      </View>
    </View>
  );
}

const desktopInsetBreakpoint = 720;

const styles = StyleSheet.create({
  desktopBackdrop: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 96,
  },
  desktopFrame: {
    flex: 1,
    maxWidth: 430,
    overflow: "hidden",
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.24,
    shadowRadius: 42,
    width: "100%",
  },
});
