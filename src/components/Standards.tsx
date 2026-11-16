import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { jurisdictionNote, shortCite, standard, type GuidanceStep } from '../domain/standards';
import { haptic } from '../services/haptics';
import { useStore } from '../store/useStore';
import { color, font, radius, space } from '../theme/theme';
import { Sheet, Txt } from './ui';

/**
 * The MSHA standard behind a check, with the matching OSHA rule beside it.
 * Tap either one to read what it requires. `refs` takes any number of them,
 * for a line that more than one standard covers.
 */
export function StandardRefs({ cfr, osha, refs, onDark }: { cfr?: string; osha?: string; refs?: string[]; onDark?: boolean }) {
  const [open, setOpen] = useState(false);
  const state = useStore((s) => s.settings.company.state);
  const keys = [cfr, osha, ...(refs ?? [])].filter((k): k is string => !!k && !!standard(k));
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
        <Txt v="small" c={color.silica}>{jurisdictionNote(state)}</Txt>
        <Txt v="small" c={color.silica}>Plain-language summary for the field. Read the regulation itself for the exact wording.</Txt>
      </Sheet>
    </>
  );
}

/** One step of what to do next, with the standard behind it. `n` numbers it when the steps are a sequence. */
export function StepCard({ step, n }: { step: GuidanceStep; n?: number }) {
  return (
    <View style={styles.step}>
      {n ? (
        <View style={styles.stepNo}>
          <Txt v="numSm" c={color.white}>{n}</Txt>
        </View>
      ) : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="strong">{step.title}</Txt>
        <Txt v="body" c={color.inkSoft}>{step.detail}</Txt>
        <StandardRefs cfr={step.cfr} osha={step.osha} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  step: {
    flexDirection: 'row',
    gap: space.md,
    padding: space.lg,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.rule,
  },
  stepNo: { width: 36, height: 36, borderRadius: radius.sm, backgroundColor: color.ink, alignItems: 'center', justifyContent: 'center' },
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
