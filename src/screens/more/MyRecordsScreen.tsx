import { ClipboardList, Factory, Wrench } from '../../components/icons';
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';

import { Divider, EmptyState, Page, Panel, Row, Segmented, Tag, UnitPlate } from '../../components/ui';
import { examFindings } from '../../domain/areaExam';
import { cardsBetween } from '../../domain/checklistCard';
import type { ScreenProps } from '../../navigation/types';
import { useMe, useStore } from '../../store/useStore';
import { color, space } from '../../theme/theme';
import { fmtDate, fmtDateTime } from '../../util/format';
import { MRF_STATUS } from '../equipment/MrfDetailScreen';

type Tab = 'cards' | 'exams' | 'requests';

/** Everything you have signed or sent: your equipment cards, your pre shift exams and your requests. */
export function MyRecordsScreen({ navigation }: ScreenProps<'MyRecords'>) {
  const me = useMe();
  const equipment = useStore((s) => s.equipment);
  const inspections = useStore((s) => s.inspections);
  const opLogs = useStore((s) => s.opLogs);
  const exams = useStore((s) => s.exams);
  const mrfs = useStore((s) => s.mrfs);
  const [tab, setTab] = useState<Tab>('cards');

  const cards = useMemo(
    () => cardsBetween({ inspections: inspections.filter((i) => i.employeeId === me?.id), opLogs, equipment }, 0, Number.MAX_SAFE_INTEGER).slice(0, 60),
    [inspections, opLogs, equipment, me?.id],
  );
  const mine = exams.filter((x) => x.employeeId === me?.id).reverse().slice(0, 60);
  const requests = mrfs.filter((m) => m.requestedBy === me?.id).reverse();
  const unitOf = (id?: string) => equipment.find((e) => e.id === id);

  return (
    <Page testID="my-records" title="My records" onBack={navigation.goBack}>
      <Segmented<Tab>
        testID="records-tab"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'cards', label: 'Equipment' },
          { value: 'exams', label: 'Exams' },
          { value: 'requests', label: 'Requests' },
        ]}
      />
      {tab === 'cards' ? (
        cards.length === 0 ? (
          <EmptyState icon={ClipboardList} title="No equipment cards yet" body="Pick a unit on the Checklists tab to start today's card." />
        ) : (
          <Panel flush>
            {cards.map((card, n) => {
              const units = card.columns.map((c) => c.unit?.unit ?? 'Removed');
              const bad = card.columns.some((c) => c.inspection.result === 'bad_order');
              const defect = card.columns.some((c) => c.inspection.result === 'defect');
              return (
                <View key={`${card.day}-${n}`}>
                  {n > 0 ? <Divider inset={space.lg} /> : null}
                  <Row
                    testID={`my-card-${n}`}
                    left={<UnitPlate unit={units[0]} />}
                    title={fmtDate(card.day)}
                    sub={units.join(', ')}
                    right={<Tag label={bad ? 'Bad order' : defect ? 'Defect' : 'Passed'} tone={bad ? 'bo' : defect ? 'warn' : 'ok'} />}
                    onPress={() => navigation.navigate('ChecklistCard', { employeeId: card.employeeId, day: card.day })}
                  />
                </View>
              );
            })}
          </Panel>
        )
      ) : tab === 'exams' ? (
        mine.length === 0 ? (
          <EmptyState icon={Factory} title="No pre shift exams yet" body="Pick your work area on the Checklists tab to examine it." />
        ) : (
          <Panel flush>
            {mine.map((exam, n) => {
              const found = examFindings(exam);
              const open = found.filter((f) => !f.fixed).length;
              return (
                <View key={exam.id}>
                  {n > 0 ? <Divider inset={space.lg} /> : null}
                  <Row
                    testID={`my-exam-${n}`}
                    left={<Factory color={color.ink} size={24} />}
                    title={exam.area}
                    sub={fmtDateTime(exam.submittedAt)}
                    right={<Tag label={found.length === 0 ? 'Clear' : open ? `${open} open` : 'Fixed'} tone={open ? 'bo' : 'ok'} />}
                    onPress={() => navigation.navigate('AreaExamDetail', { examId: exam.id })}
                  />
                </View>
              );
            })}
          </Panel>
        )
      ) : requests.length === 0 ? (
        <EmptyState icon={Wrench} title="No maintenance requests" body="Requests you send show up here with their status." />
      ) : (
        <Panel flush>
          {requests.map((m, n) => {
            const unit = unitOf(m.equipmentId);
            const status = MRF_STATUS[m.status];
            return (
              <View key={m.id}>
                {n > 0 ? <Divider inset={space.lg} /> : null}
                <Row
                  left={unit ? <UnitPlate unit={unit.unit} /> : <Wrench color={color.ink} size={24} />}
                  title={`Request #${m.number}`}
                  sub={m.description}
                  right={<Tag label={status.label} tone={status.tone} />}
                  onPress={() => navigation.navigate('MrfDetail', { mrfId: m.id })}
                />
              </View>
            );
          })}
        </Panel>
      )}
    </Page>
  );
}
