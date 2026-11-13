import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { color, font, space } from '../theme/theme';

/**
 * The red DO NOT OPERATE tag that goes on a bad-ordered machine, filled in
 * from the pre-op. It is the screen version of the paper tag on the controls.
 */
export function DangerTag({ unit, reason, by, when, bg }: {
  unit: string; reason: string; by: string; when: string;
  /** Colour behind the tag, so the clipped corners and the eyelet show through. */
  bg: string;
}) {
  return (
    <View
      style={styles.tag}
      accessibilityRole="image"
      accessibilityLabel={`Danger. Do not operate unit ${unit}. ${reason}. Tagged by ${by}, ${when}.`}
    >
      <View style={[styles.corner, styles.cornerLeft, { backgroundColor: bg }]} />
      <View style={[styles.corner, styles.cornerRight, { backgroundColor: bg }]} />
      <View style={[styles.eyelet, { backgroundColor: bg }]} />
      <View style={styles.band}>
        <Text style={styles.danger}>DANGER</Text>
      </View>
      <Text style={styles.headline}>DO NOT{'\n'}OPERATE</Text>
      <View style={styles.lines}>
        <Line label="Unit" value={unit} large />
        <Line label="Reason" value={reason} />
        <Line label="Tagged by" value={`${by}, ${when}`} />
      </View>
    </View>
  );
}

function Line({ label, value, large }: { label: string; value: string; large?: boolean }) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{label}</Text>
      <Text style={[styles.lineValue, large && { fontFamily: font.condBold, fontSize: 30, lineHeight: 32 }]} numberOfLines={3}>
        {value}
      </Text>
    </View>
  );
}

const CUT = 30;

const styles = StyleSheet.create({
  tag: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 320,
    backgroundColor: color.paper,
    borderRadius: 8,
    borderWidth: 3,
    borderColor: color.red,
    overflow: 'hidden',
    paddingBottom: space.lg,
  },
  corner: { position: 'absolute', top: -CUT, width: CUT * 2, height: CUT * 2, transform: [{ rotate: '45deg' }], zIndex: 3 },
  cornerLeft: { left: -CUT },
  cornerRight: { right: -CUT },
  eyelet: {
    position: 'absolute',
    top: 12,
    alignSelf: 'center',
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 4,
    borderColor: color.silicaLight,
    zIndex: 4,
  },
  band: { backgroundColor: color.red, paddingTop: 46, paddingBottom: 8, alignItems: 'center' },
  danger: { fontFamily: font.condBold, fontSize: 40, lineHeight: 42, letterSpacing: 6, color: color.white },
  headline: {
    fontFamily: font.condBold,
    fontSize: 46,
    lineHeight: 46,
    letterSpacing: 1,
    color: color.ink,
    textAlign: 'center',
    paddingVertical: space.md,
  },
  lines: { paddingHorizontal: space.lg, gap: space.sm },
  line: { borderBottomWidth: 1.5, borderBottomColor: color.ink, paddingBottom: 4 },
  lineLabel: { fontFamily: font.cond, fontSize: 13, lineHeight: 15, letterSpacing: 1, textTransform: 'uppercase', color: color.silica },
  lineValue: { fontFamily: font.bodySemi, fontSize: 17, lineHeight: 22, color: color.ink },
});
