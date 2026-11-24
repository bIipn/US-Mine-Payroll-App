import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { PeriodSheet } from '../../components/PeriodSheet';
import { Segmented, TopBar } from '../../components/ui';
import { useSpans } from '../../components/useSpans';
import { WeekSheet } from '../../components/WeekSheet';
import { spanOf, SPAN_NAME, type SpanKind } from '../../domain/spans';
import { useMe } from '../../store/useStore';
import { color, space } from '../../theme/theme';
import { useNow } from '../../util/hooks';

/**
 * My hours: by pay period, the way the check is cut, when the company has set
 * one; by workweek, the way overtime is figured; and by month.
 */
export function HoursScreen() {
  const now = useNow(30_000);
  const me = useMe();
  const { views, view, setView, span, setSpan, options } = useSpans(now);
  if (!me) return null;
  return (
    <View style={styles.root}>
      <TopBar title="My hours" sub="Lunch is unpaid and comes off automatically" />
      <ScrollView testID="hours-screen" contentContainerStyle={styles.content}>
        <Segmented<SpanKind>
          testID="hours-view"
          value={view}
          onChange={setView}
          options={views.map((kind) => ({ value: kind, label: SPAN_NAME[kind] }))}
        />
        {view === 'week' ? (
          <WeekSheet employeeId={me.id} weekStart={span.start} onWeek={(start) => setSpan(spanOf('week', start, options))} now={now} />
        ) : (
          <PeriodSheet employeeId={me.id} span={span} onSpan={setSpan} now={now} own />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.kaolin },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xxl, gap: space.lg },
});
