import { Check, Minus, X } from '../../components/icons';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { StandardRefs } from '../../components/Standards';
import { Button, Divider, Page, Panel, Tag, Txt, UnitPlate } from '../../components/ui';
import { countAnswers, isHazard, templateFor } from '../../domain/templates';
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

/** A submitted pre-op, exactly as it was signed. */
export function InspectionDetailScreen({ navigation, route }: ScreenProps<'InspectionDetail'>) {
  const inspection = useStore((s) => s.inspections.find((i) => i.id === route.params.inspectionId));
  const unit = useStore((s) => s.equipment.find((e) => e.id === inspection?.equipmentId));
  const employees = useStore((s) => s.employees);
  const mrf = useStore((s) => s.mrfs.find((m) => m.id === inspection?.mrfId));

  if (!inspection) return null;
  const template = unit ? templateFor(unit.category) : undefined;
  const byItem = new Map(inspection.answers.map((a) => [a.itemId, a]));
  const counts = countAnswers(inspection.answers);
  const tag = RESULT_TAG[inspection.result];

  return (
    <Page title="Pre-op record" sub={`${fmtDate(inspection.submittedAt)}, ${fmtTime(inspection.submittedAt)}`} onBack={navigation.goBack} testID="inspection-detail">
      <Panel>
        <View style={styles.head}>
          {unit ? <UnitPlate unit={unit.unit} size="lg" /> : null}
          <View style={{ flex: 1, gap: 2 }}>
            <Txt v="strong">{unit ? `${unit.make} ${unit.model}` : 'Unit removed from fleet'}</Txt>
            <Txt v="small" c={color.silica}>Inspected by {employeeName(employees, inspection.employeeId)}</Txt>
            <Txt v="small" c={color.silica}>
              Meter {fmtMeter(inspection.meter)}{unit ? ` ${unit.meterUnit}` : ''}{inspection.area ? `, ${inspection.area.toLowerCase()}` : ''}
            </Txt>
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

      {mrf ? (
        <Button label={`See MRF #${mrf.number}`} kind="outline" onPress={() => navigation.navigate('MrfDetail', { mrfId: mrf.id })} />
      ) : null}

      {template?.sections.map((section) => (
        <Panel key={section.id} title={section.title} flush>
          {section.items.map((item, i) => {
            const answer = byItem.get(item.id);
            const Icon = answer?.answer === 'ok' ? Check : answer?.answer === 'bo' ? X : Minus;
            const tint = answer?.answer === 'ok' ? color.green : answer?.answer === 'bo' ? color.red : color.silica;
            return (
              <View key={item.id}>
                {i > 0 ? <Divider inset={space.lg} /> : null}
                <View style={styles.line}>
                  <View style={[styles.mark, { borderColor: tint, backgroundColor: answer?.answer === 'bo' ? color.red : color.paper }]}>
                    <Icon color={answer?.answer === 'bo' ? color.white : tint} size={18} strokeWidth={3} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Txt v="strong">{item.label}</Txt>
                    {answer?.note ? <Txt v="body" c={color.red}>{answer.note}</Txt> : null}
                    {answer && isHazard(template, answer) ? <Txt v="smallStrong" c={color.red}>Unsafe to run. Unit taken out of service.</Txt> : null}
                    {answer?.answer === 'bo' ? <StandardRefs cfr={item.cfr} osha={item.osha} /> : null}
                  </View>
                  <Txt v="smallStrong" c={tint}>{answer?.answer === 'ok' ? 'OK' : answer?.answer === 'bo' ? 'BO' : 'N/A'}</Txt>
                </View>
              </View>
            );
          })}
        </Panel>
      ))}
    </Page>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  mark: { width: 28, height: 28, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
