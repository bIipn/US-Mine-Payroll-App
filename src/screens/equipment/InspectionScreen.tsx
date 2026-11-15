import { OctagonAlert } from '../../components/icons';
import React, { useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StandardRefs } from '../../components/Standards';
import { Button, CheckRow, Field, ProgressBar, Sheet, Tag, TopBar, Txt, TriChoice, UnitPlate } from '../../components/ui';
import { ANSWER_LEGEND, ANSWER_MARK, CATEGORY_LABEL, checklistFor, FUEL_LINE } from '../../domain/templates';
import type { Answer, ChecklistItem, InspectionAnswer } from '../../domain/types';
import type { ScreenProps } from '../../navigation/types';
import { haptic } from '../../services/haptics';
import { useMe, useStore } from '../../store/useStore';
import { color, radius, space } from '../../theme/theme';
import { fmtDate, fmtMeter, fmtTime, fullName } from '../../util/format';

type Draft = Record<string, { answer: Answer; note?: string; hazard?: boolean }>;

const LEGEND: Answer[] = ['ok', 'bo', 'na'];

/** The Operator Equipment Checklist for one unit: the 21 lines of the card, one tap each. */
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
  const [gallons, setGallons] = useState('');
  const [comments, setComments] = useState('');
  const [signing, setSigning] = useState(false);
  const [certified, setCertified] = useState(false);
  const [showMissing, setShowMissing] = useState(false);

  const checklist = useMemo(() => (unit ? checklistFor(unit.category) : undefined), [unit]);
  const items = checklist?.items ?? [];

  if (!unit || !checklist || !me) return null;

  const answered = items.filter((i) => draft[i.id]).length;
  const counts = { ok: 0, bo: 0, na: 0 };
  for (const i of items) {
    const a = draft[i.id]?.answer;
    if (a) counts[a] += 1;
  }
  const miles = unit.meterUnit === 'mi';
  const meterValue = Number(meter.replace(/,/g, ''));
  const meterOk = meter.trim() !== '' && Number.isFinite(meterValue) && meterValue >= 0;
  const gallonsValue = Number(gallons.replace(/,/g, ''));
  const gallonsOk = gallons.trim() === '' || (Number.isFinite(gallonsValue) && gallonsValue >= 0);
  const missingNote = (i: ChecklistItem) => draft[i.id]?.answer === 'bo' && !draft[i.id]?.note?.trim();
  const firstProblem = items.find((i) => !draft[i.id] || missingNote(i));
  const hazard = items.some((i) => draft[i.id]?.answer === 'bo' && (i.critical || draft[i.id]?.hazard));

  const set = (id: string, patch: Partial<Draft[string]>) =>
    setDraft((d) => ({ ...d, [id]: { ...(d[id] ?? { answer: 'ok' as Answer }), ...patch } }));

  const scrollTo = (id: string) =>
    scroll.current?.scrollTo({ y: Math.max(0, (positions.current[id] ?? 0) - 12), animated: true });

  const review = () => {
    if (!meterOk) {
      setShowMissing(true);
      scroll.current?.scrollTo({ y: 0, animated: true });
      showToast(miles ? 'Enter the odometer reading' : 'Enter the equipment hours', 'warn');
      return;
    }
    if (firstProblem) {
      setShowMissing(true);
      haptic.warning();
      scrollTo(firstProblem.id);
      const left = items.length - answered;
      showToast(left > 0 ? `${left} ${left === 1 ? 'line still needs' : 'lines still need'} an answer` : 'Say what is wrong on each Bad Order', 'warn');
      return;
    }
    if (!gallonsOk) {
      setShowMissing(true);
      scrollTo(FUEL_LINE);
      showToast('Enter the gallons added as a number, or leave it blank', 'warn');
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
    const result = submitInspection({
      equipmentId: unit.id,
      startedAt,
      meter: meterValue,
      answers,
      fuelGal: gallons.trim() ? gallonsValue : undefined,
      comments,
    });
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
      <TopBar title={`${unit.unit} checklist`} sub={`${unit.make} ${unit.model}, ${CATEGORY_LABEL[unit.category].toLowerCase()}`} onBack={navigation.goBack} />
      <View style={styles.progress}>
        <ProgressBar value={items.length ? answered / items.length : 0} tone={counts.bo > 0 ? 'bo' : 'ok'} height={8} />
        <Txt v="smallStrong" c={color.silica} testID="preop-progress">
          {answered} of {items.length} checked
        </Txt>
      </View>

      <ScrollView ref={scroll} testID="inspection-screen" contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* The top of the card: employee, date, equipment and its hours at the start. */}
        <View style={styles.sheet}>
          <Txt v="cap" c={color.silica}>Operator equipment checklist</Txt>
          <View style={styles.sheetTop}>
            <UnitPlate unit={unit.unit} size="lg" />
            <View style={{ flex: 1 }}>
              <Txt v="lead" numberOfLines={1}>{fullName(me)}</Txt>
              <Txt v="small" c={color.silica}>{fmtDate(startedAt)}, {fmtTime(startedAt)}</Txt>
            </View>
          </View>
          <Field
            testID="meter"
            label={miles ? 'Odometer at the start (miles)' : 'Equipment hours at the start'}
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
          <View style={styles.legend}>
            {LEGEND.map((answer) => (
              <View key={answer} style={styles.legendLine}>
                <Txt v="smallStrong" c={answer === 'ok' ? color.green : answer === 'bo' ? color.red : color.silica} style={styles.legendMark}>
                  {ANSWER_MARK[answer]}
                </Txt>
                <Txt v="small" c={color.inkSoft} style={{ flex: 1 }}>{ANSWER_LEGEND[answer]}</Txt>
              </View>
            ))}
          </View>
          <StandardRefs cfr="56.14100" osha={unit.category === 'forklift' ? '1910.178(q)(7)' : undefined} />
        </View>

        <View style={styles.sectionHead}>
          <View style={{ flex: 1 }}>
            <Txt v="h3" accessibilityRole="header">Check list items</Txt>
            <Txt v="small" c={color.silica}>The same {items.length} lines on every machine. Mark N/A where one does not apply.</Txt>
          </View>
          {allowAllOk && answered < items.length ? (
            <Button
              testID="all-ok"
              label="Rest are OK"
              size="md"
              kind="quiet"
              onPress={() =>
                setDraft((d) => {
                  const next = { ...d };
                  for (const i of items) if (!next[i.id]) next[i.id] = { answer: 'ok' };
                  return next;
                })
              }
            />
          ) : null}
        </View>

        {items.map((item) => {
          const entry = draft[item.id];
          const flagged = showMissing && (!entry || missingNote(item) || (item.id === FUEL_LINE && !gallonsOk));
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

              {item.id === FUEL_LINE ? (
                <Field
                  testID="fuel-gallons"
                  label="Gallons added"
                  value={gallons}
                  onChangeText={setGallons}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  hint="Leave blank if you did not fuel. You can add it when you end use."
                  error={showMissing && !gallonsOk ? 'Enter a number of gallons.' : null}
                />
              ) : null}

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
                      Safety item. Red tag the unit and report it right away.
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

        <View style={styles.item}>
          <Field
            testID="comments"
            label="Comments"
            placeholder="Anything else about this unit"
            value={comments}
            onChangeText={setComments}
            multiline
          />
        </View>
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

      <Sheet testID="sign-sheet" visible={signing} onClose={() => setSigning(false)} title="Sign the checklist">
        <View style={styles.signRow}>
          <UnitPlate unit={unit.unit} />
          <View style={{ flex: 1 }}>
            <Txt v="strong">{unit.make} {unit.model}</Txt>
            <Txt v="small" c={color.silica}>
              {miles ? 'Odometer' : 'Equipment hours'} {fmtMeter(meterValue)}{gallons.trim() && gallonsValue > 0 ? `, ${gallonsValue} gallons added` : ''}
            </Txt>
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
              ? 'This checklist takes the unit out of service. Next you will get the steps to red tag it and send the maintenance request.'
              : 'This checklist reports a defect. Next you will send the maintenance request and check with your supervisor.'}
          </Txt>
        ) : null}
        <CheckRow
          testID="certify"
          label="I inspected this unit myself before operating it this shift."
          sub={`${fullName(me)}, ${fmtTime(Date.now())}`}
          value={certified}
          onChange={setCertified}
        />
        <Button testID="submit-preop" label="Submit checklist" kind={hazard ? 'red' : 'yellow'} disabled={!certified} onPress={submit} />
      </Sheet>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.kaolin },
  progress: { paddingHorizontal: space.xl, paddingBottom: space.sm, gap: 4 },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xxl, gap: space.md },
  sheet: {
    gap: space.md,
    padding: space.lg,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.rule,
  },
  sheetTop: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  legend: { gap: 4, padding: space.md, borderRadius: radius.sm, backgroundColor: color.kaolin },
  legendLine: { flexDirection: 'row', gap: space.sm },
  legendMark: { width: 34 },
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
