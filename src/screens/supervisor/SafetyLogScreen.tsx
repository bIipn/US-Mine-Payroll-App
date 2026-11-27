import { useFileChoice } from '../../components/FileChoice';
import { ClipboardCheck, Factory, FileSpreadsheet, FileText } from '../../components/icons';
import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Chips, Divider, EmptyState, Page, Panel, Row, Segmented, Tag, Txt, UnitPlate } from '../../components/ui';
import { examFindings, examResult, shiftLabel } from '../../domain/areaExam';
import { cardsBetween } from '../../domain/checklistCard';
import type { ScreenProps } from '../../navigation/types';
import { exportPdf, exportReport } from '../../services/exportReport';
import { inspectorReport } from '../../services/inspectorReport';
import { safetyReport } from '../../services/reports';
import { employeeName, useStore } from '../../store/useStore';
import { color, radius, space } from '../../theme/theme';
import { addDays, fmtDateTime, fmtRelativeDay, startOfDay } from '../../util/format';
import { useNow } from '../../util/hooks';

type Tab = 'cards' | 'exams';
type Range = '1' | '7' | '30' | '365';
/** The most rows the list shows at once. */
const SHOWN = 120;

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
  // Android asks which way each file goes: open it, save it to the phone, or send it to another app.
  const files = useFileChoice();

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
        <>
          {/* The records an MSHA inspector asks for, as one PDF with the date and time on every record. */}
          <Button
            testID="export-inspector-pdf"
            label="PDF for an MSHA inspector"
            icon={FileText}
            kind="outline"
            onPress={() => exportPdf(() => inspectorReport({ ...useStore.getState() }, from, to, Date.now()), files.choose)}
          />
          <Button
            testID="export-safety"
            label="Export safety log to Excel"
            icon={FileSpreadsheet}
            kind="ink"
            onPress={() => exportReport(() => safetyReport({ ...useStore.getState() }, from, to, Date.now()), files.choose)}
          />
        </>
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
      {/* An exam record is kept for a year (56.18002(d)), so a year is the longest an inspector needs. */}
      <Chips<Range>
        value={range}
        onChange={setRange}
        wrap
        options={[
          { value: '1', label: 'Today' },
          { value: '7', label: 'Last 7 days' },
          { value: '30', label: 'Last 30 days' },
          { value: '365', label: 'Last 12 months' },
        ]}
      />

      {shown === 0 ? (
        <EmptyState icon={ClipboardCheck} title="Nothing in this range" body="Widen the range to see earlier records." />
      ) : tab === 'cards' ? (
        <Panel flush>
          {cards.slice(0, SHOWN).map((card, n) => {
            const units = card.columns.map((c) => c.unit?.unit ?? 'Removed');
            const bad = card.columns.filter((c) => c.inspection.result === 'bad_order').length;
            const defects = card.columns.filter((c) => c.inspection.result === 'defect').length;
            // Only a unit someone still has checked out: one that was parked after a defect never ran.
            const inUse = card.columns.filter((c) => c.inUse).length;
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
          {made.slice(0, SHOWN).map((exam, n) => {
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
                    <>
                      {/* The paper's "Date+Shift": with three shifts in a day, the date alone does not say which exam this is. */}
                      <Tag label={`${shiftLabel(exam.shift)} shift`} tone="neutral" />
                      {result === 'clear' ? (
                        <Tag label="Clear" tone="ok" />
                      ) : open === 0 ? (
                        <Tag label="Found and fixed" tone="ok" />
                      ) : (
                        <Tag label={result === 'danger' ? `${open} open, danger` : `${open} open`} tone="bo" solid />
                      )}
                    </>
                  }
                  chevron
                  onPress={() => navigation.navigate('AreaExamDetail', { examId: exam.id })}
                />
              </View>
            );
          })}
        </Panel>
      )}
      {/* The number on the tab is every record in the range. Say so when the list under it is shorter. */}
      {shown > SHOWN ? (
        <Txt v="small" c={color.silica} style={{ paddingHorizontal: 4 }}>
          Showing the latest {SHOWN} of {shown}. The Excel export has all of them.
        </Txt>
      ) : null}
      {files.sheet}
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
