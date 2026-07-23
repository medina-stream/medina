import { useEffect } from "react";
import Feather from "@react-native-vector-icons/feather";
import { router } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { Platform } from "react-native";
import { useTheme } from "../../lib/theme";

const tabShortcuts: Record<string, "/journal" | "/transcripts" | "/settings"> = {
  "1": "/journal",
  "2": "/transcripts",
  "3": "/settings",
};

export default function TabLayout() {
  const theme = useTheme();
  const web = Platform.OS === "web";

  useEffect(() => {
    if (!web || typeof window === "undefined") return;

    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        isTypingTarget(target)
      ) {
        return;
      }

      const href = tabShortcuts[event.key];
      if (!href) return;
      event.preventDefault();
      router.replace(href);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [web]);

  return (
    <NativeTabs
      backgroundColor={theme.colors.surface}
      iconColor={{ default: theme.colors.muted, selected: theme.colors.primaryText }}
      indicatorColor={theme.colors.control}
      labelStyle={web ? { default: { fontSize: 11 }, selected: { fontSize: 11 } } : { default: { fontSize: 0 }, selected: { fontSize: 0 } }}
      labelVisibilityMode={web ? "labeled" : "unlabeled"}
      tintColor={theme.colors.primaryText}
    >
      <NativeTabs.Trigger name="journal">
        <NativeTabs.Trigger.Label hidden={false}>Journal</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon src={<NativeTabs.Trigger.VectorIcon family={Feather} name="calendar" />} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="transcripts">
        <NativeTabs.Trigger.Label hidden={false}>Transcripts</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon src={<NativeTabs.Trigger.VectorIcon family={Feather} name="file-text" />} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label hidden={false}>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon src={<NativeTabs.Trigger.VectorIcon family={Feather} name="settings" />} />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select";
}
