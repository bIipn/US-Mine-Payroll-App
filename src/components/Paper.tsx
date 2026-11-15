import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { ANSWER_MARK } from '../domain/templates';
import type { Answer } from '../domain/types';
import { color, font, radius, space } from '../theme/theme';

/**
 * The look of the mine's printed forms: a white sheet, ruled boxes, and
 * condensed capitals for everything that is printed on the paper. What a
 * person wrote in is set in the ordinary text face, so the two tell apart.
 */

export const RULE = color.silica;

/** Printed words: headings, column heads and line names. */
export const printed: TextStyle = {
  fontFamily: font.cond,
  fontSize: 14,
  lineHeight: 17,
  letterSpacing: 0.3,
  textTransform: 'uppercase',
  color: color.ink,
};

/** Written-in words. */
export const written: TextStyle = { fontFamily: font.bodySemi, fontSize: 15, lineHeight: 20, color: color.ink };

export function PaperSheet({ title, corner, children, testID, style }: {
  title: string;
  /** A short label in the top corner, such as a form number. */
  corner?: string;
  children: React.ReactNode;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View testID={testID} style={[styles.sheet, style]}>
      <View style={styles.titleBand}>
        <Text style={styles.title} accessibilityRole="header">{title}</Text>
        {corner ? <Text style={styles.corner}>{corner}</Text> : null}
      </View>
      {children}
    </View>
  );
}

/** A printed label with what was written after it, on a ruled line. */
export function PaperLine({ label, value, flex = 1, testID, tall }: {
  label: string;
  value?: string | null;
  flex?: number;
  testID?: string;
  /** Room for several lines of writing. */
  tall?: boolean;
}) {
  return (
    <View style={[styles.line, { flex }, tall && styles.lineTall]} accessibilityLabel={`${label}: ${value || 'blank'}`}>
      <Text style={[printed, styles.lineLabel]}>{label}</Text>
      <Text testID={testID} style={[written, styles.lineValue]}>{value || ' '}</Text>
    </View>
  );
}

/** A row of PaperLines side by side. */
export function PaperRow({ children }: { children: React.ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

/** OK, BO or N/A the way it is written in a box. A Bad Order is filled red. */
export function Mark({ answer, small }: { answer?: Answer; small?: boolean }) {
  if (!answer) return null;
  const size = small ? 13 : 16;
  if (answer === 'bo') {
    return (
      <View style={styles.bo}>
        <Text style={{ fontFamily: font.condBold, fontSize: size, lineHeight: size + 3, color: color.white }}>{ANSWER_MARK.bo}</Text>
      </View>
    );
  }
  return (
    <Text
      style={{
        fontFamily: answer === 'ok' ? font.condBold : font.cond,
        fontSize: answer === 'ok' ? size : size - 2,
        lineHeight: size + 3,
        color: answer === 'ok' ? color.green : color.silica,
      }}
    >
      {ANSWER_MARK[answer]}
    </Text>
  );
}

/** One box of a grid. */
export function Box({ width, children, first, style }: {
  width?: number; children?: React.ReactNode; first?: boolean; style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.box, width != null ? { width } : { flex: 1 }, !first && styles.boxRule, style]}>{children}</View>;
}

/** A horizontal run of boxes with a rule above it. */
export function GridRow({ children, head, style }: { children: React.ReactNode; head?: boolean; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.gridRow, head && styles.gridHead, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: color.paper,
    borderWidth: 2,
    borderColor: color.ink,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  titleBand: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderBottomWidth: 1.5,
    borderBottomColor: color.ink,
  },
  title: {
    flex: 1,
    fontFamily: font.condBold,
    fontSize: 20,
    lineHeight: 24,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    textAlign: 'center',
    color: color.ink,
  },
  corner: { position: 'absolute', right: space.md, fontFamily: font.cond, fontSize: 14, color: color.silica },
  row: { flexDirection: 'row', gap: space.md, paddingHorizontal: space.md },
  line: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    minHeight: 36,
    paddingTop: 8,
    paddingBottom: 3,
    borderBottomWidth: 1,
    borderBottomColor: RULE,
  },
  lineTall: { alignItems: 'flex-start', minHeight: 72, flexDirection: 'column', gap: 2 },
  lineLabel: { color: color.silica },
  lineValue: { flex: 1 },
  bo: { minWidth: 28, paddingHorizontal: 4, borderRadius: 3, backgroundColor: color.red, alignItems: 'center' },
  box: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, paddingVertical: 5 },
  boxRule: { borderLeftWidth: 1, borderLeftColor: RULE },
  gridRow: { flexDirection: 'row', alignItems: 'stretch', borderTopWidth: 1, borderTopColor: RULE },
  gridHead: { borderTopWidth: 1.5, borderTopColor: color.ink, backgroundColor: color.kaolin },
});
