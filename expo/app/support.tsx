import { AppShell, SettingsBackButton } from "../components/MainNavigation";
import { Screen } from "../components/ui";
import { PlaceholderScreen } from "../components/PlaceholderScreen";

export default function SupportScreen() {
  return (
    <AppShell>
      <Screen>
        <SettingsBackButton />
        <PlaceholderScreen title="Support" />
      </Screen>
    </AppShell>
  );
}
