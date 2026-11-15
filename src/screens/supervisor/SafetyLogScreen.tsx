import { ClipboardCheck, Factory, FileSpreadsheet } from '../../components/icons';
import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Chips, Divider, EmptyState, Page, Panel, Row, Segmented, Tag, UnitPlate } from '../../components/ui';
import { examFindings, examResult } from '../../domain/areaExam';
import { cardsBetween } from '../../domain/checklistCard';
import type { ScreenProps } from '../../navigation/types';
import { exportReport } from '../../services/exportReport';
import { safetyReport } from '../../services/reports';
import { employeeName, useStore } from '../../store/useStore';
import { color, radius, space } from '../../theme/theme';
import { addDays, fmtDateTime, fmtRelativeDay, startOfDay } from '../../util/format';
import { useNow } from '../../util/hooks';

type Tab = 'cards' | 'exams';
type Range = '1' | '7' | '30';

/** Safety's record of the two paper forms: everyone's equipment cards, and the pre shift exams. */
export function SafetyLogScreen({ navigation }: ScreenProps<'SafetyLog'>) {
  const now = useNow(30_000);
  const employees = useStore((s) => s.employees);
  const equipment = useStore((s) => s.equipment);
  const inspections = useStore((s) => s.inspections);
  const opLogs = useStore((s) => s.opLogs);
  const exams = useStore((s) => s.exams);
  const [tab, setTab] = useState<Tab>('cards');
  const [range, setRange] = useState<Range>('1');

  const to = addDays(startOfDay(now), 1);
  const from = addDays(to, -Number(range));
  const cards = useMemo(() => cardsBetween({ inspections, opLogs, equipment }, from, to), [inspections, opLogs, equipment, from, to]);
  const made = useMemo(() => exams.filter((x) => x.submittedAt >= from && x.submittedAt < to).reverse(), [exams, from, to]);
  const shown = tab === 'cards' ? cards.length : made.length;

  return (
    <Page
      testID="safety-screen"
      title="Checklists and exams"
      onBack={navigation.goBack}
      footer={
        <Button
          testID="export-safety"
          label="Export safety log to Excel"
          icon={FileSpreadsheet}
          kind="ink"
          onPress={() => exportReport(() => safetyReport({ ...useStore.getState() }, from, to, Date.now()))}
        />
      }
    >
      <Segmented<Tab>
        testID="safety-tab"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'cards', label: `Equipment (${cards.length})` },
          { value: 'exams', label: `Work areas (${made.length})` },
        ]}
      />
      <Chips<Range>
        value={range}
        onChange={setRange}
        options={[
          { value: '1', label: 'Today' },
          { value: '7', label: 'Last 7 days' },
          { value: '30', label: 'Last 30 days' },
        ]}
      />

      {shown === 0 ? (
        <EmptyState icon={ClipboardCheck} title="Nothing in this range" body="Widen the range to see earlier records." />
      ) : tab === 'cards' ? (
        <Panel flush>
          {cards.slice(0, 120).map((card, n) => {
            const units = card.columns.map((c) => c.unit?.unit ?? 'Removed');
            const bad = card.columns.filter((c) => c.inspection.result === 'bad_order').length;
            const defects = card.columns.filter((c) => c.inspection.result === 'defect').length;
            const inUse = card.columns.filter((c) => c.inspection.result !== 'bad_order' && c.hoursEnd == null && card.day === startOfDay(now)).length;
            return (
              <View key={`${card.employeeId}-${card.day}-${n}`}>
                {n > 0 ? <Divider inset={space.lg} /> : null}
                <Row
                  testID={`card-${n}`}
                  left={<UnitPlate unit={units[0]} />}
                  title={employeeName(employees, card.employeeId)}
                  sub={`${fmtRelativeDay(card.day, now)}. ${units.join(', ')}`}
                  below={
                    <>
                      <Tag label={`${units.length} ${units.length === 1 ? 'unit' : 'units'}`} tone="neutral" />
                      {bad ? <Tag label={`${bad} bad order`} tone="bo" solid /> : null}
                      {defects ? <Tag label={`${defects} ${defects === 1 ? 'defect' : 'defects'}`} tone="warn" /> : null}
                      {!bad && !defects ? <Tag label="All passed" tone="ok" /> : null}
                      {inUse ? <Tag label="In use" tone="info" /> : null}
                    </>
                  }
                  chevron
                  onPress={() => navigation.navigate('ChecklistCard', { employeeId: card.employeeId, day: card.day })}
                />
              </View>
            );
          })}
        </Panel>
      ) : (
        <Panel flush>
          {made.slice(0, 120).map((exam, n) => {
            const result = examResult(exam);
            const open = examFindings(exam).filter((f) => !f.fixed).length;
            return (
              <View key={exam.id}>
                {n > 0 ? <Divider inset={space.lg} /> : null}
                <Row
                  testID={`exam-${n}`}
                  left={<View style={styles.areaIcon}><Factory color={color.ink} size={24} /></View>}
                  title={exam.area}
                  sub={`${employeeName(employees, exam.employeeId)}, ${fmtDateTime(exam.submittedAt)}`}
                  below={
                    result === 'clear' ? (
                      <Tag label="Clear" tone="ok" />
                    ) : open === 0 ? (
                      <Tag label="Found and fixed" tone="ok" />
                    ) : (
                      <Tag label={result === 'danger' ? `${open} open, danger` : `${open} open`} tone="bo" solid />
                    )
                  }
                  chevron
                  onPress={() => navigation.navigate('AreaExamDetail', { examId: exam.id })}
                />
              </View>
            );
          })}
        </Panel>
      )}
    </Page>
  );
}

const styles = StyleSheet.create({
  areaIcon: {
    width: 48,
    height: 48,
    borderRadius: radius.sm,
    backgroundColor: color.grayTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
