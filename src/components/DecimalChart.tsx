import React from 'react';
import { StyleSheet, View } from 'react-native';

import { color, radius, space } from '../theme/theme';
import { minuteDecimal } from '../util/format';
import { Sheet, Txt } from './ui';

const MINUTES = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];

/** The crew's minutes-to-decimal chart, with a worked example. */
export function DecimalChart({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const half = MINUTES.length / 2;
  return (
    <Sheet visible={visible} onClose={onClose} title="Minutes as decimals" testID="decimal-chart">
      <Txt v="body" c={color.inkSoft}>
        Hours go on the timesheet as decimals. Divide the minutes by 60 and round to two places. The app does this for every punch.
      </Txt>
      <View style={styles.chart}>
        {[MINUTES.slice(0, half), MINUTES.slice(half)].map((column, c) => (
          <View key={c} style={[styles.column, c > 0 && styles.columnRule]}>
            <View style={styles.headRow}>
              <Txt v="cap" c={color.silica} style={styles.cell}>Min</Txt>
              <Txt v="cap" c={color.silica} style={styles.cell}>Dec</Txt>
            </View>
            {column.map((m) => (
              <View key={m} style={styles.row}>
                <Txt v="numSm" style={styles.cell}>{m}</Txt>
                <Txt v="numSm" style={styles.cell}>{minuteDecimal(m)}</Txt>
              </View>
            ))}
          </View>
        ))}
      </View>
      <View style={styles.example}>
        <Txt v="strong">Worked example</Txt>
        <Txt v="body" c={color.inkSoft}>6:15 AM to 7:00 PM with a 30-minute lunch</Txt>
        <Txt v="body" c={color.inkSoft}>12h 45m on site. 45 ÷ 60 = 0.75, so 12.75.</Txt>
        <Txt v="num">12.75 − 0.50 = 12.25</Txt>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  chart: { flexDirection: 'row', borderWidth: 1, borderColor: color.rule, borderRadius: radius.md, overflow: 'hidden' },
  column: { flex: 1 },
  columnRule: { borderLeftWidth: 1, borderLeftColor: color.rule },
  headRow: { flexDirection: 'row', paddingVertical: space.sm, backgroundColor: color.kaolin },
  row: { flexDirection: 'row', paddingVertical: 6, borderTopWidth: 1, borderTopColor: color.rule },
  cell: { flex: 1, textAlign: 'center' },
  example: { gap: 2, padding: space.lg, borderRadius: radius.md, backgroundColor: color.yellowTint },
});
