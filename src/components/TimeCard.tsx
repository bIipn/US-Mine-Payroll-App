import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Platform, StyleSheet, Text, View } from 'react-native';

import { shiftTotals } from '../domain/time';
import type { Shift } from '../domain/types';
import { color, font, radius, space } from '../theme/theme';
import { clockParts, fmtHM, fmtHrs } from '../util/format';
import { Txt } from './ui';

/**
 * The day's time card: four punches across, then the hours worked out the way
 * the crew fills in a timesheet — time on site as a decimal, minus lunch.
 */
export function TimeCard({ shift, now, name, dateLabel, corner }: {
  shift?: Shift;
  now: number;
  name?: string;
  dateLabel: string;
  /** Colour behind the card, so the clipped corner shows through. */
  corner: string;
}) {
  const lunch = shift?.lunches[0];
  const totals = shift ? shiftTotals(shift, now) : undefined;
  const slots: { key: string; head: string; at?: number }[] = [
    { key: 'in', head: 'In', at: shift?.clockIn.at },
    { key: 'lunch', head: 'Lunch', at: lunch?.start.at },
    { key: 'back', head: 'Back', at: lunch?.end?.at },
    { key: 'out', head: 'Out', at: shift?.clockOut?.at },
  ];
  const extraLunches = (shift?.lunches.length ?? 0) - 1;

  return (
    <View style={styles.card} testID="time-card">
      <View style={[styles.cut, { backgroundColor: corner }]} />
      <View style={styles.head}>
        <View style={{ flex: 1 }}>
          <Txt v="cap" c={color.silica}>Time card</Txt>
          {name ? <Txt v="lead" numberOfLines={1}>{name}</Txt> : null}
        </View>
        <Txt v="smallStrong" c={color.silica} style={{ marginRight: 22 }}>{dateLabel}</Txt>
      </View>

      <View style={styles.punches}>
        {slots.map((slot, i) => (
          <View key={slot.key} style={[styles.slot, i > 0 && styles.slotRule]}>
            <Txt v="cap" c={color.silica}>{slot.head}</Txt>
            <Stamp at={slot.at} testID={`punch-${slot.key}`} />
          </View>
        ))}
      </View>
      {extraLunches > 0 ? (
        <Txt v="small" c={color.silica} style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
          Plus {extraLunches} more lunch {extraLunches === 1 ? 'period' : 'periods'}, counted below.
        </Txt>
      ) : null}

      <View style={styles.math} accessibilityLabel={
        totals
          ? `On site ${fmtHrs(totals.gross)} hours, lunch ${fmtHrs(totals.lunch)}, paid ${fmtHrs(totals.paid)} hours`
          : 'No hours yet today'
      }>
        <Figure label="On site" detail={totals ? fmtHM(totals.grossMin) : undefined} value={totals ? fmtHrs(totals.gross) : '0.00'} />
        <Text style={styles.operator}>−</Text>
        <Figure label="Lunch" detail={totals && totals.lunchMin > 0 ? fmtHM(totals.lunchMin) : undefined} value={totals ? fmtHrs(totals.lunch) : '0.00'} />
        <Text style={styles.operator}>=</Text>
        <Figure label="Paid hours" value={totals ? fmtHrs(totals.paid) : '0.00'} strong testID="paid-hours" />
      </View>
    </View>
  );
}

function Figure({ label, detail, value, strong, testID }: {
  label: string; detail?: string; value: string; strong?: boolean; testID?: string;
}) {
  return (
    <View style={{ flex: strong ? 1.15 : 1 }}>
      <Text testID={testID} style={[styles.figure, strong && styles.figureStrong]}>{value}</Text>
      <Txt v="micro" c={strong ? color.ink : color.silica} numberOfLines={1}>{label}</Txt>
      {detail ? <Txt v="micro" c={color.silicaLight} numberOfLines={1}>{detail}</Txt> : null}
    </View>
  );
}

/** A punch time. It lands like a stamp the moment it is recorded. */
function Stamp({ at, testID }: { at?: number; testID?: string }) {
  const scale = useRef(new Animated.Value(1)).current;
  const seen = useRef(at);

  useEffect(() => {
    const landed = seen.current == null && at != null;
    seen.current = at;
    if (!landed) return;
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((reduce) => {
        if (cancelled || reduce) return;
        scale.setValue(1.7);
        Animated.spring(scale, { toValue: 1, friction: 6, tension: 180, useNativeDriver: Platform.OS !== 'web' }).start();
      });
    return () => {
      cancelled = true;
    };
  }, [at, scale]);

  if (at == null) {
    return (
      <View testID={testID}>
        <Text style={[styles.time, { color: color.rule }]}>–:––</Text>
        <Text style={[styles.ampm, { color: 'transparent' }]}>AM</Text>
      </View>
    );
  }
  const parts = clockParts(at);
  return (
    <Animated.View testID={testID} style={{ transform: [{ scale }] }}>
      <Text style={styles.time}>{parts.hm}</Text>
      <Text style={styles.ampm}>{parts.ampm}</Text>
    </Animated.View>
  );
}

const CUT = 26;

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.rule,
    overflow: 'hidden',
  },
  // A time card has one corner clipped so it only goes in the clock one way.
  cut: {
    position: 'absolute',
    top: -CUT,
    right: -CUT,
    width: CUT * 2,
    height: CUT * 2,
    transform: [{ rotate: '45deg' }],
    zIndex: 2,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
  },
  punches: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: color.rule,
  },
  slot: { flex: 1, alignItems: 'center', paddingVertical: space.md, gap: 4 },
  slotRule: { borderLeftWidth: 1, borderLeftColor: color.rule },
  time: {
    fontFamily: font.condBold,
    fontSize: 30,
    lineHeight: 32,
    color: color.ink,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  ampm: { fontFamily: font.cond, fontSize: 14, lineHeight: 16, color: color.silica, textAlign: 'center' },
  math: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    backgroundColor: color.paper,
  },
  figure: {
    fontFamily: font.cond,
    fontSize: 28,
    lineHeight: 30,
    color: color.inkSoft,
    fontVariant: ['tabular-nums'],
  },
  figureStrong: { fontFamily: font.condBold, fontSize: 36, lineHeight: 36, color: color.ink, marginTop: -6 },
  operator: { fontFamily: font.cond, fontSize: 26, lineHeight: 30, color: color.silicaLight, width: 16, textAlign: 'center' },
});
