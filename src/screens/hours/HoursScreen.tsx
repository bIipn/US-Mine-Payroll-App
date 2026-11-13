import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { PeriodSheet } from '../../components/PeriodSheet';
import { Segmented, TopBar } from '../../components/ui';
import { WeekSheet } from '../../components/WeekSheet';
import { payPeriodOf } from '../../domain/payPeriod';
import { useMe, useStore } from '../../store/useStore';
import { color, space } from '../../theme/theme';
import { startOfWeek } from '../../util/format';
import { useNow } from '../../util/hooks';

type View_ = 'period' | 'week';

/** My hours: by pay period, the way the check is cut, or by workweek, the way overtime is figured. */
export function HoursScreen() {
  const now = useNow(30_000);
  const me = useMe();
  const startsOn = useStore((s) => s.settings.workweekStartsOn);
  const [view, setView] = useState<View_>('period');
  const [period, setPeriod] = useState(() => payPeriodOf(Date.now()));
  const [weekStart, setWeekStart] = useState(() => startOfWeek(Date.now(), startsOn));
  if (!me) return null;
  return (
    <View style={styles.root}>
      <TopBar title="My hours" sub="Lunch is unpaid and comes off automatically" />
      <ScrollView testID="hours-screen" contentContainerStyle={styles.content}>
        <Segmented<View_>
          testID="hours-view"
          value={view}
          onChange={setView}
          options={[
            { value: 'period', label: 'Pay period' },
            { value: 'week', label: 'Workweek' },
          ]}
        />
        {view === 'period' ? (
          <PeriodSheet employeeId={me.id} period={period} onPeriod={setPeriod} now={now} own />
        ) : (
          <WeekSheet employeeId={me.id} weekStart={weekStart} onWeek={setWeekStart} now={now} />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.kaolin },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xxl, gap: space.lg },
});
