import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { JURISDICTION_NOTE, shortCite, standard } from '../domain/standards';
import { haptic } from '../services/haptics';
import { color, font, radius, space } from '../theme/theme';
import { Sheet, Txt } from './ui';

/**
 * The MSHA standard behind a check, with the matching OSHA rule beside it.
 * Tap either one to read what it requires.
 */
export function StandardRefs({ cfr, osha, onDark }: { cfr?: string; osha?: string; onDark?: boolean }) {
  const [open, setOpen] = useState(false);
  const keys = [cfr, osha].filter((k): k is string => !!k && !!standard(k));
  if (keys.length === 0) return null;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Standards: ${keys.map(shortCite).join(', ')}. Tap to read.`}
        hitSlop={8}
        onPress={() => {
          haptic.tap();
          setOpen(true);
        }}
        style={styles.refs}
      >
        {keys.map((key) => (
          <View key={key} style={[styles.ref, onDark && { borderColor: color.onDarkMuted }]}>
            <Text style={[styles.refText, onDark && { color: color.white }]}>{shortCite(key)}</Text>
          </View>
        ))}
      </Pressable>
      <Sheet visible={open} onClose={() => setOpen(false)} title="What the standard says">
        {keys.map((key) => {
          const std = standard(key)!;
          return (
            <View key={key} style={{ gap: 4 }}>
              <Txt v="micro" c={std.agency === 'MSHA' ? color.blue : color.silica}>
                {std.agency === 'MSHA' ? 'MSHA, governs at the mine' : 'OSHA, matching rule'}
              </Txt>
              <Txt v="lead">{std.cite}</Txt>
              <Txt v="strong">{std.title}</Txt>
              <Txt v="body" c={color.inkSoft}>{std.summary}</Txt>
            </View>
          );
        })}
        <Txt v="small" c={color.silica}>{JURISDICTION_NOTE}</Txt>
        <Txt v="small" c={color.silica}>Plain-language summary for the field. Read the regulation itself for the exact wording.</Txt>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  refs: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignSelf: 'flex-start', paddingVertical: 2 },
  ref: {
    borderWidth: 1,
    borderColor: color.silicaLight,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  refText: { fontFamily: font.bodySemi, fontSize: 12, lineHeight: 16, color: color.silica },
});
