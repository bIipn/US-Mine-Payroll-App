import { CircleCheck, FileText, OctagonAlert, TriangleAlert, Wrench } from '../../components/icons';
import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { DangerTag } from '../../components/DangerTag';
import { StepCard } from '../../components/Standards';
import { Button, Notice, Txt, UnitPlate } from '../../components/ui';
import { BAD_ORDER_STEPS, CLEARED_REMINDERS, DEFECT_STEPS } from '../../domain/standards';
import type { ScreenProps } from '../../navigation/types';
import { haptic } from '../../services/haptics';
import { mrfItemsFromInspection, useMe, useStore } from '../../store/useStore';
import { color, radius, space } from '../../theme/theme';
import { fmtDate, fmtMeter, fmtTime, fullName } from '../../util/format';

export function InspectionResultScreen({ navigation, route }: ScreenProps<'InspectionResult'>) {
  const insets = useSafeAreaInsets();
  const me = useMe();
  const inspection = useStore((s) => s.inspections.find((i) => i.id === route.params.inspectionId));
  const unit = useStore((s) => s.equipment.find((e) => e.id === inspection?.equipmentId));
  const mrf = useStore((s) => s.mrfs.find((m) => m.id === inspection?.mrfId));
  const { decideAfterDefect, showToast } = useStore.getState();

  if (!inspection || !unit || !me) return null;

  const defects = mrfItemsFromInspection(inspection, unit);
  const done = () => navigation.popToTop();
  const sendMrf = () => navigation.navigate('MrfForm', { equipmentId: unit.id, inspectionId: inspection.id });

  const look = {
    pass: { bg: color.green, icon: CircleCheck, title: 'Cleared to work', sub: `${unit.unit} passed its checklist at ${fmtTime(inspection.submittedAt)}.` },
    defect: { bg: color.amber, icon: TriangleAlert, title: 'Defect found', sub: 'Report it and check with your supervisor before you run this unit.' },
    bad_order: { bg: color.red, icon: OctagonAlert, title: 'Bad order', sub: `${unit.unit} is out of service. Do not operate it.` },
  }[inspection.result];
  const Icon = look.icon;

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <ScrollView testID={`result-${inspection.result}`} contentContainerStyle={{ paddingBottom: space.xxl }}>
        <View
          style={[
            styles.field,
            { backgroundColor: look.bg, paddingTop: insets.top + space.xl },
            inspection.result === 'bad_order' && { paddingBottom: space.xl },
          ]}
        >
          <Icon color={color.white} size={44} strokeWidth={2.25} />
          <Txt v="h1" c={color.white} accessibilityRole="header">{look.title}</Txt>
          <Txt v="lead" c={color.white}>{look.sub}</Txt>
        </View>

        <View style={styles.body}>
          {inspection.result === 'bad_order' ? (
            <View style={{ marginTop: space.xl }}>
              <DangerTag
                unit={unit.unit}
                reason={defects.map((d) => d.note || d.label).join('; ')}
                by={fullName(me)}
                when={`${fmtDate(inspection.submittedAt)} ${fmtTime(inspection.submittedAt)}`}
                bg={color.kaolin}
              />
            </View>
          ) : (
            <View style={[styles.card, { marginTop: -36 }]}>
              <UnitPlate unit={unit.unit} size="lg" />
              <View style={{ flex: 1 }}>
                <Txt v="strong">{unit.make} {unit.model}</Txt>
                <Txt v="small" c={color.silica}>
                  {unit.meterUnit === 'mi' ? 'Odometer' : 'Equipment hours'} {fmtMeter(inspection.meter)} at the start
                </Txt>
                {inspection.result === 'pass' ? <Txt v="small" c={color.silica}>It is on your card for today.</Txt> : null}
              </View>
            </View>
          )}

          {inspection.result !== 'pass' ? (
            <View style={styles.block}>
              <Txt v="h3">{defects.length === 1 ? 'What you found' : `The ${defects.length} things you found`}</Txt>
              {defects.map((d) => (
                <View key={d.label} style={styles.defect}>
                  <Txt v="strong">{d.label}</Txt>
                  {d.note ? <Txt v="body" c={color.inkSoft}>{d.note}</Txt> : null}
                </View>
              ))}
            </View>
          ) : null}

          {/* The steps are a sequence, so they are numbered. */}
          <View style={styles.block}>
            <Txt v="h3">{inspection.result === 'pass' ? 'Before you move' : 'What to do now'}</Txt>
            {(inspection.result === 'pass' ? CLEARED_REMINDERS : inspection.result === 'defect' ? DEFECT_STEPS : BAD_ORDER_STEPS).map(
              (step, i) => <StepCard key={step.title} step={step} n={inspection.result === 'pass' ? undefined : i + 1} />,
            )}
          </View>

          {inspection.result === 'pass' ? (
            <>
              <Button testID="result-done" label="Done" kind="ink" size="xl" onPress={done} />
              <Button
                testID="result-card"
                label="See my card for today"
                icon={FileText}
                kind="outline"
                onPress={() => {
                  navigation.popToTop();
                  navigation.navigate('ChecklistCard');
                }}
              />
            </>
          ) : null}

          {inspection.result !== 'pass' && !mrf ? (
            <Button testID="send-mrf" label="Fill out the maintenance request" icon={Wrench} kind="ink" size="lg" onPress={sendMrf} />
          ) : null}

          {inspection.result !== 'pass' && mrf ? (
            <Notice tone="ok" icon={CircleCheck} title={`Maintenance request #${mrf.number} sent`} body="It is on the maintenance request list, and it stays open until the repair is signed off." />
          ) : null}

          {inspection.result === 'bad_order' && mrf ? (
            <Button testID="result-done" label="Done. Pick another unit." kind="ink" size="lg" onPress={done} />
          ) : null}

          {inspection.result === 'defect' && mrf && !inspection.decision ? (
            <>
              <Button
                testID="decide-operate"
                label="My supervisor cleared it. Run it."
                kind="yellow"
                size="lg"
                onPress={() => {
                  decideAfterDefect(inspection.id, 'operate');
                  haptic.success();
                  showToast(`${unit.unit} checked out to you`);
                  done();
                }}
              />
              <Button
                testID="decide-park"
                label="I'm parking it"
                kind="outline"
                size="lg"
                onPress={() => {
                  decideAfterDefect(inspection.id, 'parked');
                  done();
                }}
              />
            </>
          ) : null}
          {inspection.result === 'defect' && mrf && inspection.decision ? (
            <Button testID="result-done" label="Done" kind="ink" size="lg" onPress={done} />
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.kaolin },
  field: { paddingHorizontal: space.xl, paddingBottom: 60, gap: space.sm },
  body: { paddingHorizontal: space.lg, gap: space.lg },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    padding: space.lg,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.rule,
  },
  block: { gap: space.md },
  defect: { padding: space.lg, backgroundColor: color.paper, borderRadius: radius.md, borderLeftWidth: 6, borderLeftColor: color.red },
});
