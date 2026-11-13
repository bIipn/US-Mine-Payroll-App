import { OctagonAlert } from '../../components/icons';
import React, { useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StandardRefs } from '../../components/Standards';
import { Button, CheckRow, Chips, Field, ProgressBar, Sheet, Tag, TopBar, Txt, TriChoice, UnitPlate } from '../../components/ui';
import { CATEGORY_LABEL, templateFor, templateItems, WORK_AREAS } from '../../domain/templates';
import type { Answer, ChecklistItem, InspectionAnswer } from '../../domain/types';
import type { ScreenProps } from '../../navigation/types';
import { haptic } from '../../services/haptics';
import { useMe, useStore } from '../../store/useStore';
import { color, radius, space } from '../../theme/theme';
import { fmtDate, fmtMeter, fmtTime, fullName } from '../../util/format';

type Draft = Record<string, { answer: Answer; note?: string; hazard?: boolean }>;

export function InspectionScreen({ navigation, route }: ScreenProps<'Inspection'>) {
  const insets = useSafeAreaInsets();
  const me = useMe();
  const unit = useStore((s) => s.equipment.find((e) => e.id === route.params.equipmentId));
  const allowAllOk = useStore((s) => s.settings.allowSectionAllOk);
  const { submitInspection, showToast } = useStore.getState();

  const startedAt = useRef(Date.now()).current;
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const positions = useRef<Record<string, number>>({});

  const [draft, setDraft] = useState<Draft>({});
  const [meter, setMeter] = useState(unit ? String(unit.meter) : '');
  const [area, setArea] = useState<string>('');
  const [signing, setSigning] = useState(false);
  const [certified, setCertified] = useState(false);
  const [showMissing, setShowMissing] = useState(false);

  const template = useMemo(() => (unit ? templateFor(unit.category) : undefined), [unit]);
  const items = useMemo(() => (template ? templateItems(template) : []), [template]);

  if (!unit || !template || !me) return null;

  const answered = items.filter((i) => draft[i.id]).length;
  const counts = { ok: 0, bo: 0, na: 0 };
  for (const i of items) {
    const a = draft[i.id]?.answer;
    if (a) counts[a] += 1;
  }
  const meterValue = Number(meter.replace(/,/g, ''));
  const meterOk = meter.trim() !== '' && Number.isFinite(meterValue) && meterValue >= 0;
  const missingNote = (i: ChecklistItem) => draft[i.id]?.answer === 'bo' && !draft[i.id]?.note?.trim();
  const firstProblem = items.find((i) => !draft[i.id] || missingNote(i));
  const hazard = items.some((i) => draft[i.id]?.answer === 'bo' && (i.critical || draft[i.id]?.hazard));

  const set = (id: string, patch: Partial<Draft[string]>) =>
    setDraft((d) => ({ ...d, [id]: { ...(d[id] ?? { answer: 'ok' as Answer }), ...patch } }));

  const review = () => {
    if (!meterOk) {
      setShowMissing(true);
      scroll.current?.scrollTo({ y: 0, animated: true });
      showToast(`Enter the ${unit.meterUnit === 'mi' ? 'odometer' : 'hour meter'} reading`, 'warn');
      return;
    }
    if (firstProblem) {
      setShowMissing(true);
      haptic.warning();
      scroll.current?.scrollTo({ y: Math.max(0, (positions.current[firstProblem.id] ?? 0) - 12), animated: true });
      const left = items.length - answered;
      showToast(left > 0 ? `${left} ${left === 1 ? 'check still needs' : 'checks still need'} an answer` : 'Say what is wrong on each Bad Order', 'warn');
      return;
    }
    setSigning(true);
  };

  const submit = () => {
    const answers: InspectionAnswer[] = items.map((i) => ({
      itemId: i.id,
      answer: draft[i.id].answer,
      note: draft[i.id].answer === 'bo' ? draft[i.id].note?.trim() : undefined,
      hazard: draft[i.id].answer === 'bo' && !i.critical ? draft[i.id].hazard || undefined : undefined,
    }));
    const result = submitInspection({ equipmentId: unit.id, startedAt, meter: meterValue, area: area || undefined, answers });
    if (!result.ok) {
      showToast(result.error, 'bo');
      return;
    }
    setSigning(false);
    if (result.inspection.result === 'pass') haptic.success();
    else haptic.warning();
    navigation.replace('InspectionResult', { inspectionId: result.inspection.id });
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <TopBar title={`${unit.unit} pre-op`} sub={`${unit.make} ${unit.model}, ${CATEGORY_LABEL[unit.category].toLowerCase()}`} onBack={navigation.goBack} />
      <View style={styles.progress}>
        <ProgressBar value={items.length ? answered / items.length : 0} tone={counts.bo > 0 ? 'bo' : 'ok'} height={8} />
        <Txt v="smallStrong" c={color.silica} testID="preop-progress">
          {answered} of {items.length} checked
        </Txt>
      </View>

      <ScrollView ref={scroll} testID="inspection-screen" contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* Operating sheet: who, when, meter, where. */}
        <View style={styles.sheet}>
          <View style={styles.sheetTop}>
            <UnitPlate unit={unit.unit} size="lg" />
            <View style={{ flex: 1 }}>
              <Txt v="lead" numberOfLines={1}>{fullName(me)}</Txt>
              <Txt v="small" c={color.silica}>{fmtDate(startedAt)}, {fmtTime(startedAt)}</Txt>
            </View>
          </View>
          <Field
            testID="meter"
            label={unit.meterUnit === 'mi' ? 'Odometer now (miles)' : 'Hour meter now'}
            value={meter}
            onChangeText={setMeter}
            keyboardType="decimal-pad"
            selectTextOnFocus
            hint={`Last reading ${fmtMeter(unit.meter)} ${unit.meterUnit}`}
            error={
              showMissing && !meterOk
                ? 'Enter the reading off the machine.'
                : meterOk && meterValue < unit.meter
                  ? `That is lower than the last reading of ${fmtMeter(unit.meter)}. Check it before you sign.`
                  : null
            }
          />
          <View style={{ gap: 6 }}>
            <Txt v="smallStrong">Where are you working?</Txt>
            <Chips value={area} onChange={(next) => setArea(next === area ? '' : next)} options={WORK_AREAS.map((a) => ({ value: a, label: a }))} />
          </View>
        </View>

        {template.sections.map((section) => {
          const done = section.items.filter((i) => draft[i.id]).length;
          return (
            <React.Fragment key={section.id}>
              <View style={styles.sectionHead}>
                <View style={{ flex: 1 }}>
                  <Txt v="h3" accessibilityRole="header">{section.title}</Txt>
                  <Txt v="small" c={color.silica}>{done} of {section.items.length} checked</Txt>
                </View>
                {allowAllOk && done < section.items.length ? (
                  <Button
                    testID={`all-ok-${section.id}`}
                    label="Rest are OK"
                    size="md"
                    kind="quiet"
                    onPress={() =>
                      setDraft((d) => {
                        const next = { ...d };
                        for (const i of section.items) if (!next[i.id]) next[i.id] = { answer: 'ok' };
                        return next;
                      })
                    }
                  />
                ) : null}
              </View>

              {section.items.map((item) => {
                const entry = draft[item.id];
                const flagged = showMissing && (!entry || missingNote(item));
                return (
                  <View
                    key={item.id}
                    testID={`item-${item.id}`}
                    onLayout={(e) => {
                      positions.current[item.id] = e.nativeEvent.layout.y;
                    }}
                    style={[styles.item, flagged && styles.itemFlagged, entry?.answer === 'bo' && styles.itemBad]}
                  >
                    <View style={styles.itemHead}>
                      <Txt v="strong" style={{ flex: 1 }}>{item.label}</Txt>
                      {item.critical ? <Tag label="Safety" tone="bo" icon={OctagonAlert} /> : null}
                    </View>
                    {item.hint ? <Txt v="small" c={color.silica}>{item.hint}</Txt> : null}
                    <StandardRefs cfr={item.cfr} osha={item.osha} />
                    <TriChoice testID={`answer-${item.id}`} value={entry?.answer} onChange={(answer) => set(item.id, { answer })} />

                    {entry?.answer === 'bo' ? (
                      <View style={styles.bad}>
                        <Field
                          testID={`note-${item.id}`}
                          label="What is wrong?"
                          placeholder="Say what you see, hear or feel"
                          value={entry.note ?? ''}
                          onChangeText={(note) => set(item.id, { note })}
                          multiline
                          error={showMissing && missingNote(item) ? 'Maintenance needs to know what to look for.' : null}
                        />
                        {item.critical ? (
                          <Txt v="smallStrong" c={color.red}>
                            Safety-critical. A Bad Order here takes the unit out of service.
                          </Txt>
                        ) : (
                          <CheckRow
                            testID={`hazard-${item.id}`}
                            label="This makes the unit unsafe to run"
                            sub="Ticking this takes the unit out of service."
                            value={!!entry.hazard}
                            onChange={(hazardous) => set(item.id, { hazard: hazardous })}
                          />
                        )}
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </React.Fragment>
          );
        })}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
        <View style={styles.tally}>
          <Tag label={`${counts.ok} OK`} tone="ok" />
          <Tag label={`${counts.bo} BO`} tone={counts.bo ? 'bo' : 'neutral'} solid={counts.bo > 0} />
          <Tag label={`${counts.na} N/A`} tone="neutral" />
          <Txt v="smallStrong" c={color.silica} style={{ marginLeft: 'auto' }}>
            {items.length - answered} left
          </Txt>
        </View>
        <Button testID="review-sign" label="Review and sign" kind={answered === items.length ? 'yellow' : 'quiet'} onPress={review} />
      </View>

      <Sheet testID="sign-sheet" visible={signing} onClose={() => setSigning(false)} title="Sign the pre-op">
        <View style={styles.signRow}>
          <UnitPlate unit={unit.unit} />
          <View style={{ flex: 1 }}>
            <Txt v="strong">{unit.make} {unit.model}</Txt>
            <Txt v="small" c={color.silica}>Meter {fmtMeter(meterValue)} {unit.meterUnit}{area ? `, ${area.toLowerCase()}` : ''}</Txt>
          </View>
        </View>
        <View style={styles.tally}>
          <Tag label={`${counts.ok} OK`} tone="ok" />
          <Tag label={`${counts.bo} Bad Order`} tone={counts.bo ? 'bo' : 'neutral'} solid={counts.bo > 0} />
          <Tag label={`${counts.na} N/A`} tone="neutral" />
        </View>
        {counts.bo > 0 ? (
          <Txt v="body" c={color.inkSoft}>
            {hazard
              ? 'This pre-op takes the unit out of service. Next you will get the steps to tag it out and send the maintenance request.'
              : 'This pre-op reports a defect. Next you will send the maintenance request and check with your supervisor.'}
          </Txt>
        ) : null}
        <CheckRow
          testID="certify"
          label="I inspected this unit myself before operating it this shift."
          sub={`${fullName(me)}, ${fmtTime(Date.now())}`}
          value={certified}
          onChange={setCertified}
        />
        <Button testID="submit-preop" label="Submit pre-op" kind={hazard ? 'red' : 'yellow'} disabled={!certified} onPress={submit} />
      </Sheet>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.kaolin },
  progress: { paddingHorizontal: space.xl, paddingBottom: space.sm, gap: 4 },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xxl, gap: space.md },
  sheet: {
    gap: space.lg,
    padding: space.lg,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.rule,
  },
  sheetTop: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.lg, paddingHorizontal: 4 },
  item: {
    gap: space.sm,
    padding: space.lg,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.rule,
  },
  itemFlagged: { borderColor: color.amber, borderWidth: 2.5, padding: space.lg - 1.5 },
  itemBad: { borderColor: color.red, borderWidth: 2.5, padding: space.lg - 1.5 },
  itemHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  bad: { gap: space.sm, marginTop: 4, padding: space.md, borderRadius: radius.md, backgroundColor: color.redTint },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    gap: space.sm,
    backgroundColor: color.paper,
    borderTopWidth: 1,
    borderTopColor: color.rule,
  },
  tally: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  signRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
});
