import { AppShell, SettingsBackButton } from "../components/MainNavigation";
import { Screen } from "../components/ui";
import { PlaceholderScreen } from "../components/PlaceholderScreen";

export default function PrivacyScreen() {
  return (
    <AppShell>
      <Screen>
        <SettingsBackButton />
        <PlaceholderScreen title="Privacy" />
      </Screen>
    </AppShell>
  );
}
