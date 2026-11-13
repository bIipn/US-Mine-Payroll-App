import { useNavigation } from '@react-navigation/native';
import { Search, Tag as TagIcon, Wrench } from '../../components/icons';
import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Button, Chips, Divider, EmptyState, Field, Notice, Panel, Row, Sheet, Tag, TopBar, Txt, UnitPlate } from '../../components/ui';
import { CATEGORY_LABEL, CATEGORY_ORDER } from '../../domain/templates';
import type { Equipment, EquipmentCategory, OperatingLog } from '../../domain/types';
import { openLogs, useMe, useStore } from '../../store/useStore';
import { color, space, type Tone } from '../../theme/theme';
import { fmtMeter, fmtRelativeDay, fmtTime, shortName } from '../../util/format';
import { useNow } from '../../util/hooks';

type Filter = 'all' | EquipmentCategory;

interface UnitState {
  label: string;
  tone: Tone;
  solid?: boolean;
  rank: number;
}

export function EquipmentScreen() {
  const navigation = useNavigation();
  const now = useNow(30_000);
  const me = useMe();
  const equipment = useStore((s) => s.equipment);
  const opLogs = useStore((s) => s.opLogs);
  const employees = useStore((s) => s.employees);
  const inspections = useStore((s) => s.inspections);
  const mrfs = useStore((s) => s.mrfs);

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  const inUse = useMemo(() => openLogs(opLogs), [opLogs]);

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
      <TopBar title="Equipment" sub="Pre-op every unit before you run it this shift" />
      <ScrollView testID="equipment-screen" contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
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
      </ScrollView>

      <Sheet testID="unit-sheet" visible={!!open} onClose={() => setOpenId(null)} title={open ? `${open.make} ${open.model}` : ''}>
        {open ? (
          <>
            <View style={styles.sheetHead}>
              <UnitPlate unit={open.unit} size="lg" />
              <View style={{ flex: 1 }}>
                <Txt v="strong">{CATEGORY_LABEL[open.category]}</Txt>
                <Txt v="small" c={color.silica}>Meter {fmtMeter(open.meter)} {open.meterUnit}</Txt>
                {lastInspection ? (
                  <Txt v="small" c={color.silica}>
                    Last pre-op {fmtRelativeDay(lastInspection.submittedAt, now).toLowerCase()} {fmtTime(lastInspection.submittedAt)}
                    {lastBy ? ` by ${shortName(lastBy)}` : ''}
                  </Txt>
                ) : (
                  <Txt v="small" c={color.silica}>No pre-op on record yet</Txt>
                )}
              </View>
            </View>

            {open.status === 'out_of_service' ? (
              <Notice tone="bo" icon={TagIcon} title="Tagged out. Do not operate." body={openMrf ? `MRF #${openMrf.number}: ${openMrf.description}` : 'A safety defect is open on this unit.'} />
            ) : null}
            {open.status === 'defect' ? (
              <Notice tone="warn" icon={Wrench} title="A defect is reported on this unit" body={openMrf ? `MRF #${openMrf.number}: ${openMrf.description}` : undefined} />
            ) : null}
            {openLog && !mine && logOwner ? (
              <Notice
                tone="info"
                title={`${logOwner.firstName} ${logOwner.lastName} has this unit`}
                body={`Checked out at ${fmtTime(openLog.startAt)}. If you take it over, your pre-op closes their operating sheet.`}
              />
            ) : null}

            {mine && openLog ? (
              <Button testID="end-use" label="End use" kind="ink" onPress={() => go(() => navigation.navigate('EndUse', { logId: openLog.id }))} />
            ) : (
              <Button
                testID="start-preop"
                label="Start pre-op"
                kind="yellow"
                disabled={open.status === 'out_of_service'}
                onPress={() => go(() => navigation.navigate('Inspection', { equipmentId: open.id }))}
              />
            )}
            {openMrf ? (
              <Button
                testID="see-mrf"
                label={`See MRF #${openMrf.number}`}
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
