import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { FileText, Search, Tag as TagIcon, Wrench } from '../../components/icons';
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Button, Chips, Divider, EmptyState, Field, Notice, Panel, Row, Segmented, Sheet, Tag, TopBar, Txt, UnitPlate } from '../../components/ui';
import { dailyCards } from '../../domain/checklistCard';
import { CATEGORY_LABEL, CATEGORY_ORDER } from '../../domain/templates';
import type { Equipment, EquipmentCategory, OperatingLog } from '../../domain/types';
import type { TabParamList } from '../../navigation/types';
import { openLogs, useMe, useStore } from '../../store/useStore';
import { color, space, type Tone } from '../../theme/theme';
import { fmtMeter, fmtRelativeDay, fmtTime, shortName } from '../../util/format';
import { useNow } from '../../util/hooks';
import { AreaList } from '../exam/AreaList';
import { CheckedOutUnits } from './CheckedOutUnits';

type Filter = 'all' | EquipmentCategory;
type Tab = 'equipment' | 'area';

interface UnitState {
  label: string;
  tone: Tone;
  solid?: boolean;
  rank: number;
}

/**
 * The Checklists tab: the two things done before work starts. Equipment is
 * the Operator Equipment Checklist, one unit at a time. Work area is the
 * Pre Shift Exam of the place you work in.
 */
export function EquipmentScreen() {
  const navigation = useNavigation();
  const route = useRoute<RouteProp<TabParamList, 'Equipment'>>();
  const now = useNow(30_000);
  const me = useMe();
  const equipment = useStore((s) => s.equipment);
  const opLogs = useStore((s) => s.opLogs);
  const employees = useStore((s) => s.employees);
  const inspections = useStore((s) => s.inspections);
  const mrfs = useStore((s) => s.mrfs);

  const [tab, setTab] = useState<Tab>(route.params?.tab ?? 'equipment');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  // Another screen can send you straight to one side of the tab.
  const asked = route.params?.tab;
  const askedAt = route.params?.at;
  useEffect(() => {
    if (asked) setTab(asked);
  }, [asked, askedAt]);

  const inUse = useMemo(() => openLogs(opLogs), [opLogs]);
  const onMyCard = useMemo(
    () => (me ? dailyCards({ inspections, opLogs, equipment }, me.id, now).reduce((n, card) => n + card.columns.length, 0) : 0),
    [inspections, opLogs, equipment, me, now],
  );

  const stateOf = (unit: Equipment): UnitState => {
    const log = inUse.get(unit.id);
    if (unit.status === 'out_of_service') return { label: 'Out of service', tone: 'bo', solid: true, rank: 4 };
    if (log?.employeeId === me?.id) return { label: 'You have it', tone: 'yellow', solid: true, rank: 0 };
    if (log) {
      const who = employees.find((e) => e.id === log.employeeId);
      return { label: who ? `In use, ${shortName(who)}` : 'In use', tone: 'info', rank: 3 };
    }
    if (unit.status === 'defect') return { label: 'Defect reported', tone: 'warn', rank: 2 };
    return { label: 'Ready', tone: 'ok', rank: 1 };
  };

  const categories = CATEGORY_ORDER.filter((c) => equipment.some((e) => e.category === c));
  const text = query.trim().toLowerCase();
  const list = equipment
    .filter((e) => filter === 'all' || e.category === filter)
    .filter((e) => !text || `${e.unit} ${e.make} ${e.model} ${CATEGORY_LABEL[e.category]}`.toLowerCase().includes(text))
    .map((unit) => ({ unit, state: stateOf(unit) }))
    .sort((a, b) => a.state.rank - b.state.rank || a.unit.unit.localeCompare(b.unit.unit, undefined, { numeric: true }));

  const open = equipment.find((e) => e.id === openId);
  const openLog: OperatingLog | undefined = open ? inUse.get(open.id) : undefined;
  const openMrf = open ? mrfs.filter((m) => m.equipmentId === open.id && m.status !== 'completed').slice(-1)[0] : undefined;
  const lastInspection = open ? inspections.filter((i) => i.equipmentId === open.id).slice(-1)[0] : undefined;
  const lastBy = employees.find((e) => e.id === lastInspection?.employeeId);
  const logOwner = employees.find((e) => e.id === openLog?.employeeId);
  const mine = !!openLog && openLog.employeeId === me?.id;

  const go = (action: () => void) => {
    setOpenId(null);
    action();
  };

  return (
    <View style={styles.root}>
      <TopBar title="Checklists" sub="Your work area and your equipment, before you start" />
      <ScrollView testID="equipment-screen" contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Segmented<Tab>
          testID="checklists-tab"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'equipment', label: 'Equipment' },
            { value: 'area', label: 'Work area' },
          ]}
        />

        {tab === 'area' ? (
          <AreaList now={now} />
        ) : (
          <>
            <Panel flush>
              <Row
                testID="my-card"
                left={<FileText color={color.ink} size={26} />}
                title="My equipment card"
                sub={onMyCard > 0 ? `${onMyCard} ${onMyCard === 1 ? 'unit' : 'units'} checked today` : 'No equipment checked yet today'}
                chevron
                onPress={() => navigation.navigate('ChecklistCard')}
              />
            </Panel>

            {/* A unit taken out of the fleet while you had it checked out is in no list below: End use here. */}
            {me ? <CheckedOutUnits employeeId={me.id} takenOutOnly /> : null}

            <Field
              testID="equipment-search"
              label="Find a unit"
              placeholder="Unit number, make or type"
              value={query}
              onChangeText={setQuery}
              autoCapitalize="characters"
              autoCorrect={false}
              right={<Search color={color.silica} size={22} />}
            />
            <Chips<Filter>
              value={filter}
              onChange={setFilter}
              options={[{ value: 'all', label: 'All' }, ...categories.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))]}
            />

            {list.length === 0 ? (
              <EmptyState icon={Search} title="No unit matches" body="Check the unit number, or clear the search to see the whole fleet." />
            ) : (
              <Panel flush>
                {list.map(({ unit, state }, i) => (
                  <View key={unit.id}>
                    {i > 0 ? <Divider inset={space.lg} /> : null}
                    <Row
                      testID={`unit-${unit.unit}`}
                      left={<UnitPlate unit={unit.unit} />}
                      title={`${unit.make} ${unit.model}`}
                      sub={`${CATEGORY_LABEL[unit.category]}, ${fmtMeter(unit.meter)} ${unit.meterUnit}`}
                      below={<Tag label={state.label} tone={state.tone} solid={state.solid} />}
                      chevron
                      onPress={() => setOpenId(unit.id)}
                    />
                  </View>
                ))}
              </Panel>
            )}
          </>
        )}
      </ScrollView>

      <Sheet testID="unit-sheet" visible={!!open} onClose={() => setOpenId(null)} title={open ? `${open.make} ${open.model}` : ''}>
        {open ? (
          <>
            <View style={styles.sheetHead}>
              <UnitPlate unit={open.unit} size="lg" />
              <View style={{ flex: 1 }}>
                <Txt v="strong">{CATEGORY_LABEL[open.category]}</Txt>
                <Txt v="small" c={color.silica}>
                  {open.meterUnit === 'mi' ? 'Odometer' : 'Equipment hours'} {fmtMeter(open.meter)}
                </Txt>
                {lastInspection ? (
                  <Txt v="small" c={color.silica}>
                    Last checked {fmtRelativeDay(lastInspection.submittedAt, now).toLowerCase()} {fmtTime(lastInspection.submittedAt)}
                    {lastBy ? ` by ${shortName(lastBy)}` : ''}
                  </Txt>
                ) : (
                  <Txt v="small" c={color.silica}>No checklist on record yet</Txt>
                )}
              </View>
            </View>

            {open.status === 'out_of_service' ? (
              <Notice tone="bo" icon={TagIcon} title="Red tagged. Do not operate." body={openMrf ? `Request #${openMrf.number}: ${openMrf.description}` : 'A safety defect is open on this unit.'} />
            ) : null}
            {open.status === 'defect' ? (
              <Notice tone="warn" icon={Wrench} title="A defect is reported on this unit" body={openMrf ? `Request #${openMrf.number}: ${openMrf.description}` : undefined} />
            ) : null}
            {openLog && !mine && logOwner ? (
              <Notice
                tone="info"
                title={`${logOwner.firstName} ${logOwner.lastName} has this unit`}
                body={`Checked out at ${fmtTime(openLog.startAt)}. If you take it over, your checklist ends their use of it.`}
              />
            ) : null}

            {mine && openLog ? (
              <Button testID="end-use" label="End use" kind="ink" onPress={() => go(() => navigation.navigate('EndUse', { logId: openLog.id }))} />
            ) : (
              <Button
                testID="start-preop"
                label="Start checklist"
                kind="yellow"
                disabled={open.status === 'out_of_service'}
                onPress={() => go(() => navigation.navigate('Inspection', { equipmentId: open.id }))}
              />
            )}
            {openMrf ? (
              <Button
                testID="see-mrf"
                label={`See request #${openMrf.number}`}
                kind="outline"
                onPress={() => go(() => navigation.navigate('MrfDetail', { mrfId: openMrf.id }))}
              />
            ) : null}
            <Button
              testID="new-mrf"
              label="Send a maintenance request"
              icon={Wrench}
              kind="quiet"
              onPress={() => go(() => navigation.navigate('MrfForm', { equipmentId: open.id }))}
            />
          </>
        ) : null}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.kaolin },
  content: { paddingHorizontal: space.xl, paddingTop: space.sm, paddingBottom: space.xxl, gap: space.lg },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
});
