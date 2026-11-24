import { ClipboardList, Factory, Wrench } from '../../components/icons';
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';

import { Divider, EmptyState, Page, Panel, Row, Segmented, Tag, Txt, UnitPlate } from '../../components/ui';
import { examFindings, shiftLabel } from '../../domain/areaExam';
import { cardsBetween } from '../../domain/checklistCard';
import type { ScreenProps } from '../../navigation/types';
import { useMe, useStore } from '../../store/useStore';
import { color, space } from '../../theme/theme';
import { fmtDate, fmtDateTime } from '../../util/format';
import { MRF_STATUS } from '../equipment/MrfDetailScreen';

type Tab = 'cards' | 'exams' | 'requests';

/** The most rows a list shows. Past that it says so, rather than stopping without a word. */
const SHOWN = 60;

/**
 * Everything you have signed or sent: your equipment cards, your pre shift exams
 * and your requests. The requests include the ones assigned to you to work,
 * which is the only place a person who is not a supervisor can find them.
 */
export function MyRecordsScreen({ navigation, route }: ScreenProps<'MyRecords'>) {
  const me = useMe();
  const equipment = useStore((s) => s.equipment);
  const inspections = useStore((s) => s.inspections);
  const opLogs = useStore((s) => s.opLogs);
  const exams = useStore((s) => s.exams);
  const mrfs = useStore((s) => s.mrfs);
  const [tab, setTab] = useState<Tab>(route.params?.tab ?? 'cards');

  const allCards = useMemo(
    () => cardsBetween({ inspections: inspections.filter((i) => i.employeeId === me?.id), opLogs, equipment }, 0, Number.MAX_SAFE_INTEGER),
    [inspections, opLogs, equipment, me?.id],
  );
  const cards = allCards.slice(0, SHOWN);
  const allMine = exams.filter((x) => x.employeeId === me?.id).reverse();
  const mine = allMine.slice(0, SHOWN);
  // Work that is waiting on you comes first, then everything else, newest first.
  const toDo = (m: (typeof mrfs)[number]) => m.assignedTo === me?.id && m.status !== 'completed';
  const requests = mrfs
    .filter((m) => m.requestedBy === me?.id || m.assignedTo === me?.id)
    .sort((a, b) => Number(toDo(b)) - Number(toDo(a)) || b.createdAt - a.createdAt);
  const waiting = requests.filter(toDo).length;
  const unitOf = (id?: string) => equipment.find((e) => e.id === id);
  const latestOnly = (all: number) =>
    all > SHOWN ? <Txt v="small" c={color.silica} style={{ paddingHorizontal: 4 }}>Showing the latest {SHOWN} of {all}.</Txt> : null;

  return (
    <Page testID="my-records" title="My records" onBack={navigation.goBack}>
      <Segmented<Tab>
        testID="records-tab"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'cards', label: 'Equipment' },
          { value: 'exams', label: 'Exams' },
          { value: 'requests', label: waiting > 0 ? `Requests (${waiting})` : 'Requests' },
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
                    sub={`${fmtDateTime(exam.submittedAt)}, ${shiftLabel(exam.shift).toLowerCase()} shift`}
                    right={<Tag label={found.length === 0 ? 'Clear' : open ? `${open} open` : 'Fixed'} tone={open ? 'bo' : 'ok'} />}
                    onPress={() => navigation.navigate('AreaExamDetail', { examId: exam.id })}
                  />
                </View>
              );
            })}
          </Panel>
        )
      ) : requests.length === 0 ? (
        <EmptyState icon={Wrench} title="No maintenance requests" body="Requests you send, and requests assigned to you, show up here with their status." />
      ) : (
        <Panel flush>
          {requests.map((m, n) => {
            const unit = unitOf(m.equipmentId);
            const status = MRF_STATUS[m.status];
            return (
              <View key={m.id}>
                {n > 0 ? <Divider inset={space.lg} /> : null}
                <Row
                  testID={`my-request-${m.number}`}
                  left={unit ? <UnitPlate unit={unit.unit} /> : <Wrench color={color.ink} size={24} />}
                  title={`Request #${m.number}`}
                  sub={m.location && !unit ? `${m.location}. ${m.description}` : m.description}
                  below={m.assignedTo === me?.id ? <Tag label={toDo(m) ? 'Assigned to you' : 'You were assigned'} tone={toDo(m) ? 'warn' : 'neutral'} solid={toDo(m)} /> : undefined}
                  right={<Tag label={status.label} tone={status.tone} />}
                  onPress={() => navigation.navigate('MrfDetail', { mrfId: m.id })}
                />
              </View>
            );
          })}
        </Panel>
      )}
      {tab === 'cards' ? latestOnly(allCards.length) : tab === 'exams' ? latestOnly(allMine.length) : null}
    </Page>
  );
}
