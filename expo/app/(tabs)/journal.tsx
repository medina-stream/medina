import { FlatList, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useTheme, type AppTheme } from "../../lib/theme";
import { Interval, intervalRowHeight } from "../../components/Interval";
import { AppShell } from "../../components/MainNavigation";
import { dayIdFromDate } from "../../lib/dates";

const today = new Date();
const year = today.getUTCFullYear();
const dayIds = getDayIdsBackThroughYear(today, 1900);

function getDayIdsBackThroughYear(from: Date, endYear: number): string[] {
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const end = Date.UTC(endYear, 0, 1);
  const dayCount = Math.round((start - end) / 86_400_000) + 1;

  return Array.from({ length: dayCount }, (_, i) =>
    dayIdFromDate(new Date(start - i * 86_400_000)),
  );
}

export default function Journal() {
  const theme = useTheme();
  const styles = createStyles(theme);

  return (
    <AppShell>
      <View style={styles.screen}>
        <FlatList
          contentContainerStyle={styles.container}
          data={dayIds}
          getItemLayout={(_, index) => ({
            length: intervalRowHeight,
            offset: intervalRowHeight * index,
            index,
          })}
          initialNumToRender={18}
          keyExtractor={(id) => id}
          ListHeaderComponent={
            <View style={styles.headerBlock}>
              <Text style={styles.title}>{year}</Text>
            </View>
          }
          maxToRenderPerBatch={24}
          renderItem={({ item }) => (
            <Interval
              id={item}
              onOpenDay={() => router.push({ pathname: "/day/[dayId]", params: { dayId: item } })}
            />
          )}
          style={styles.list}
          windowSize={12}
        />
      </View>
    </AppShell>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    list: {
      flex: 1,
    },
    container: {
      paddingHorizontal: theme.space.lg,
      paddingTop: theme.space.lg,
      paddingBottom: theme.space.xl,
    },
    headerBlock: {
      marginBottom: theme.space.md,
    },
    title: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.bold,
      fontSize: 30,
      letterSpacing: -0.7,
      lineHeight: 36,
    },
  });
}
