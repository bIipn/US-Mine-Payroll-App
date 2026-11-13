import { ClipboardCheck, FileSpreadsheet } from '../../components/icons';
import React, { useState } from 'react';
import { View } from 'react-native';

import { Button, Chips, Divider, EmptyState, Page, Panel, Row, Segmented, Tag, UnitPlate } from '../../components/ui';
import type { ScreenProps } from '../../navigation/types';
import { exportReport } from '../../services/exportReport';
import { safetyReport } from '../../services/reports';
import { employeeName, useStore } from '../../store/useStore';
import { space } from '../../theme/theme';
import { addDays, fmtDateTime, fmtDur, fmtMeter, fmtTime, startOfDay } from '../../util/format';
import { useNow } from '../../util/hooks';
import { RESULT_TAG } from '../equipment/InspectionDetailScreen';

type Tab = 'preops' | 'usage';
type Range = '1' | '7' | '30';

/** Safety's record of who inspected and ran which unit, and what they found. */
export function SafetyLogScreen({ navigation }: ScreenProps<'SafetyLog'>) {
  const now = useNow(30_000);
  const employees = useStore((s) => s.employees);
  const equipment = useStore((s) => s.equipment);
  const inspections = useStore((s) => s.inspections);
  const opLogs = useStore((s) => s.opLogs);
  const [tab, setTab] = useState<Tab>('preops');
  const [range, setRange] = useState<Range>('1');

  const to = addDays(startOfDay(now), 1);
  const from = addDays(to, -Number(range));
  const unitOf = (id: string) => equipment.find((e) => e.id === id);
  const preops = inspections.filter((i) => i.submittedAt >= from && i.submittedAt < to).reverse();
  const usage = opLogs.filter((l) => l.startAt >= from && l.startAt < to).reverse();
  const shown = tab === 'preops' ? preops.length : usage.length;

  return (
    <Page
      testID="safety-screen"
      title="Pre-ops and equipment use"
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
          { value: 'preops', label: `Pre-ops (${preops.length})` },
          { value: 'usage', label: `Equipment use (${usage.length})` },
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
      ) : tab === 'preops' ? (
        <Panel flush>
          {preops.slice(0, 120).map((i, n) => {
            const unit = unitOf(i.equipmentId);
            const tag = RESULT_TAG[i.result];
            return (
              <View key={i.id}>
                {n > 0 ? <Divider inset={space.lg} /> : null}
                <Row
                  testID={`preop-${n}`}
                  left={unit ? <UnitPlate unit={unit.unit} /> : undefined}
                  title={employeeName(employees, i.employeeId)}
                  sub={`${fmtDateTime(i.submittedAt)}, meter ${fmtMeter(i.meter)}`}
                  right={<Tag label={tag.label} tone={tag.tone} solid={i.result !== 'pass'} />}
                  onPress={() => navigation.navigate('InspectionDetail', { inspectionId: i.id })}
                />
              </View>
            );
          })}
        </Panel>
      ) : (
        <Panel flush>
          {usage.slice(0, 120).map((l, n) => {
            const unit = unitOf(l.equipmentId);
            return (
              <View key={l.id}>
                {n > 0 ? <Divider inset={space.lg} /> : null}
                <Row
                  left={unit ? <UnitPlate unit={unit.unit} /> : undefined}
                  title={employeeName(employees, l.employeeId)}
                  sub={
                    l.endAt
                      ? `${fmtDateTime(l.startAt)} to ${fmtTime(l.endAt)}, ${fmtDur(l.endAt - l.startAt)}, ${fmtMeter((l.endMeter ?? l.startMeter) - l.startMeter)} ${unit?.meterUnit ?? 'hrs'} on the meter`
                      : `Since ${fmtDateTime(l.startAt)}${l.area ? `, ${l.area.toLowerCase()}` : ''}`
                  }
                  right={l.endAt ? undefined : <Tag label="In use" tone="info" />}
                  onPress={() => navigation.navigate('InspectionDetail', { inspectionId: l.inspectionId })}
                />
              </View>
            );
          })}
        </Panel>
      )}
    </Page>
  );
}
