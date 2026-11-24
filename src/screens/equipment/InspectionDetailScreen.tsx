import { Check, FileText, Minus, X } from '../../components/icons';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { StandardRefs } from '../../components/Standards';
import { Button, Divider, Notice, Page, Panel, Tag, Txt, UnitPlate } from '../../components/ui';
import { ANSWER_MARK, checklistFor, checklistSignedOn, countAnswers, findItem, FUEL_LINE, isHazard } from '../../domain/templates';
import type { InspectionResult } from '../../domain/types';
import type { ScreenProps } from '../../navigation/types';
import { employeeName, useStore } from '../../store/useStore';
import { color, space, type Tone } from '../../theme/theme';
import { fmtDate, fmtMeter, fmtTime } from '../../util/format';

export const RESULT_TAG: Record<InspectionResult, { label: string; tone: Tone }> = {
  pass: { label: 'Passed', tone: 'ok' },
  defect: { label: 'Defect', tone: 'warn' },
  bad_order: { label: 'Bad order', tone: 'bo' },
};

/** One unit on someone's equipment checklist, exactly as it was signed. */
export function InspectionDetailScreen({ navigation, route }: ScreenProps<'InspectionDetail'>) {
  const inspection = useStore((s) => s.inspections.find((i) => i.id === route.params.inspectionId));
  const unit = useStore((s) => s.equipment.find((e) => e.id === inspection?.equipmentId));
  const log = useStore((s) => s.opLogs.find((l) => l.inspectionId === route.params.inspectionId));
  const employees = useStore((s) => s.employees);
  const mrf = useStore((s) => s.mrfs.find((m) => m.id === inspection?.mrfId));

  if (!inspection) return null;
  // The lines read the same on every machine; the unit's type only picks the standards.
  const checklist = checklistSignedOn(inspection, unit);
  // A record signed on an earlier checklist keeps the lines it was signed on.
  const earlier = inspection.templateId !== checklist.id;
  const counts = countAnswers(inspection.answers);
  const tag = RESULT_TAG[inspection.result];
  const reading = unit?.meterUnit === 'mi' ? 'Odometer' : 'Equipment hours';
  const gallons = (inspection.fuelGal ?? 0) + (log?.fuelGal ?? 0);

  return (
    <Page title="Equipment checklist" sub={`${fmtDate(inspection.submittedAt)}, ${fmtTime(inspection.submittedAt)}`} onBack={navigation.goBack} testID="inspection-detail">
      <Panel>
        <View style={styles.head}>
          {unit ? <UnitPlate unit={unit.unit} size="lg" /> : null}
          <View style={{ flex: 1, gap: 2 }}>
            <Txt v="strong">{unit ? `${unit.make} ${unit.model}` : 'Unit removed from fleet'}</Txt>
            <Txt v="small" c={color.silica}>Checked by {employeeName(employees, inspection.employeeId)}</Txt>
            <Txt v="small" c={color.silica}>
              {reading} {fmtMeter(inspection.meter)} at the start{log?.endMeter != null ? `, ${fmtMeter(log.endMeter)} at the end` : ''}
            </Txt>
            {gallons > 0 ? <Txt v="small" c={color.silica}>{gallons} gallons of fuel added</Txt> : null}
          </View>
        </View>
        <View style={styles.tags}>
          <Tag label={tag.label} tone={tag.tone} solid />
          <Tag label={`${counts.ok} OK`} tone="ok" />
          <Tag label={`${counts.bo} BO`} tone={counts.bo ? 'bo' : 'neutral'} />
          <Tag label={`${counts.na} N/A`} tone="neutral" />
        </View>
        {inspection.decision ? (
          <Txt v="small" c={color.silica} style={{ marginTop: space.sm }}>
            {inspection.decision === 'operate' ? 'Operator ran the unit after a supervisor cleared it.' : 'Operator parked the unit.'}
          </Txt>
        ) : null}
      </Panel>

      <View style={{ gap: space.sm }}>
        <Button
          testID="open-card"
          label="See the whole card for the day"
          icon={FileText}
          kind="outline"
          onPress={() => navigation.navigate('ChecklistCard', { employeeId: inspection.employeeId, day: inspection.submittedAt })}
        />
        {mrf ? (
          <Button label={`See maintenance request #${mrf.number}`} kind="quiet" onPress={() => navigation.navigate('MrfDetail', { mrfId: mrf.id })} />
        ) : null}
      </View>

      {earlier ? (
        <Notice tone="info" title="Signed on an earlier checklist" body="This record keeps the lines it was signed on, so some are shown by their short names." />
      ) : null}

      <Panel title="Check list items" flush>
        {inspection.answers.map((answer, i) => {
          const item = findItem(checklist, answer.itemId);
          const Icon = answer.answer === 'ok' ? Check : answer.answer === 'bo' ? X : Minus;
          const tint = answer.answer === 'ok' ? color.green : answer.answer === 'bo' ? color.red : color.silica;
          return (
            <View key={answer.itemId}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <View style={styles.line}>
                <View style={[styles.mark, { borderColor: tint, backgroundColor: answer.answer === 'bo' ? color.red : color.paper }]}>
                  <Icon color={answer.answer === 'bo' ? color.white : tint} size={18} strokeWidth={3} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Txt v="strong">{item?.label ?? answer.itemId}</Txt>
                  {answer.itemId === FUEL_LINE && inspection.fuelGal ? <Txt v="small" c={color.silica}>{inspection.fuelGal} gallons added</Txt> : null}
                  {answer.note ? <Txt v="body" c={color.red}>{answer.note}</Txt> : null}
                  {isHazard(checklist, answer) ? <Txt v="smallStrong" c={color.red}>Unsafe to run. Unit taken out of service.</Txt> : null}
                  {answer.answer === 'bo' ? <StandardRefs cfr={item?.cfr} osha={item?.osha} /> : null}
                </View>
                <Txt v="smallStrong" c={tint}>{ANSWER_MARK[answer.answer]}</Txt>
              </View>
            </View>
          );
        })}
      </Panel>

      {inspection.comments || log?.notes ? (
        <Panel title="Comments">
          {inspection.comments ? <Txt v="body">{inspection.comments}</Txt> : null}
          {log?.notes ? <Txt v="body" c={color.inkSoft} style={inspection.comments ? { marginTop: space.sm } : undefined}>At the end of use: {log.notes}</Txt> : null}
        </Panel>
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  mark: { width: 28, height: 28, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
