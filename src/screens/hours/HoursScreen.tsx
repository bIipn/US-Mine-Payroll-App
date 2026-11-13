import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { TopBar } from '../../components/ui';
import { WeekSheet } from '../../components/WeekSheet';
import { useMe, useStore } from '../../store/useStore';
import { color, space } from '../../theme/theme';
import { startOfWeek } from '../../util/format';
import { useNow } from '../../util/hooks';

export function HoursScreen() {
  const now = useNow(30_000);
  const me = useMe();
  const startsOn = useStore((s) => s.settings.workweekStartsOn);
  const [weekStart, setWeekStart] = useState(() => startOfWeek(Date.now(), startsOn));
  if (!me) return null;
  return (
    <View style={styles.root}>
      <TopBar title="My hours" sub="Lunch is unpaid and comes off automatically" />
      <ScrollView testID="hours-screen" contentContainerStyle={styles.content}>
        <WeekSheet employeeId={me.id} weekStart={weekStart} onWeek={setWeekStart} now={now} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.kaolin },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xxl },
});
