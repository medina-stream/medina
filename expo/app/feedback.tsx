import { AppShell, SettingsBackButton } from "../components/MainNavigation";
import { Screen } from "../components/ui";
import { PlaceholderScreen } from "../components/PlaceholderScreen";

export default function FeedbackScreen() {
  return (
    <AppShell>
      <Screen>
        <SettingsBackButton />
        <PlaceholderScreen title="Send feedback" />
      </Screen>
    </AppShell>
  );
}
