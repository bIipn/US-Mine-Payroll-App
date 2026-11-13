import { Tag as TagIcon } from '../../components/icons';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { StandardRefs } from '../../components/Standards';
import { Button, Divider, Field, Notice, Page, Panel, Sheet, Tag, Txt, UnitPlate } from '../../components/ui';
import type { MrfPriority, MrfStatus } from '../../domain/types';
import type { ScreenProps } from '../../navigation/types';
import { haptic } from '../../services/haptics';
import { employeeName, useMe, useStore } from '../../store/useStore';
import { color, space, type Tone } from '../../theme/theme';
import { fmtDateTime, fmtMeter } from '../../util/format';

export const MRF_STATUS: Record<MrfStatus, { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'bo' },
  in_progress: { label: 'In progress', tone: 'warn' },
  completed: { label: 'Completed', tone: 'ok' },
};

export const MRF_PRIORITY: Record<MrfPriority, { label: string; tone: Tone }> = {
  safety: { label: 'Safety', tone: 'bo' },
  high: { label: 'High', tone: 'warn' },
  routine: { label: 'Routine', tone: 'neutral' },
};

const HISTORY_LABEL: Record<MrfStatus, string> = {
  open: 'Request sent',
  in_progress: 'Work started',
  completed: 'Completed and returned to service',
};

export function MrfDetailScreen({ navigation, route }: ScreenProps<'MrfDetail'>) {
  const me = useMe();
  const mrf = useStore((s) => s.mrfs.find((m) => m.id === route.params.mrfId));
  const unit = useStore((s) => s.equipment.find((e) => e.id === mrf?.equipmentId));
  const employees = useStore((s) => s.employees);
  const { setMrfStatus, showToast } = useStore.getState();

  const [next, setNext] = useState<MrfStatus | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!mrf) return null;
  const status = MRF_STATUS[mrf.status];
  const priority = MRF_PRIORITY[mrf.priority];
  const canManage = me?.role === 'supervisor';

  const apply = () => {
    if (!next) return;
    if (next === 'completed' && !note.trim()) {
      setError('Say what was done. This note is the repair record.');
      return;
    }
    setMrfStatus(mrf.id, next, note);
    haptic.success();
    showToast(next === 'completed' ? `MRF #${mrf.number} completed. ${unit?.unit ?? 'Unit'} is back in service.` : `MRF #${mrf.number} is in progress`);
    setNext(null);
    setNote('');
  };

  return (
    <Page
      testID="mrf-detail"
      title={`MRF #${mrf.number}`}
      sub={`Opened ${fmtDateTime(mrf.createdAt)}`}
      onBack={navigation.goBack}
      footer={
        canManage && mrf.status !== 'completed' ? (
          <>
            {mrf.status === 'open' ? (
              <Button testID="mrf-start" label="Start work" kind="outline" onPress={() => { setError(null); setNext('in_progress'); }} />
            ) : null}
            <Button testID="mrf-complete" label="Complete and return to service" kind="green" onPress={() => { setError(null); setNext('completed'); }} />
          </>
        ) : undefined
      }
    >
      <Panel>
        <View style={styles.head}>
          {unit ? <UnitPlate unit={unit.unit} size="lg" /> : null}
          <View style={{ flex: 1, gap: 2 }}>
            <Txt v="strong">{unit ? `${unit.make} ${unit.model}` : 'Unit removed from fleet'}</Txt>
            <Txt v="small" c={color.silica}>Requested by {employeeName(employees, mrf.requestedBy)}</Txt>
            {mrf.meter != null ? <Txt v="small" c={color.silica}>Meter {fmtMeter(mrf.meter)}{unit ? ` ${unit.meterUnit}` : ''}</Txt> : null}
          </View>
        </View>
        <View style={styles.tags}>
          <Tag label={status.label} tone={status.tone} solid />
          <Tag label={`${priority.label} priority`} tone={priority.tone} />
        </View>
      </Panel>

      {mrf.taggedOut && mrf.status !== 'completed' ? (
        <Notice tone="bo" icon={TagIcon} title="Tagged out. Do not operate." body={mrf.location ? `Unit is at: ${mrf.location}` : undefined} />
      ) : null}

      <Panel title="The problem">
        <Txt v="body">{mrf.description}</Txt>
        {!mrf.taggedOut && mrf.location ? <Txt v="small" c={color.silica} style={{ marginTop: space.sm }}>Unit is at: {mrf.location}</Txt> : null}
      </Panel>

      {mrf.items.length > 0 ? (
        <Panel title="From the pre-op" flush>
          {mrf.items.map((item, i) => (
            <View key={item.label}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <View style={styles.item}>
                <Txt v="strong">{item.label}</Txt>
                {item.note ? <Txt v="body" c={color.inkSoft}>{item.note}</Txt> : null}
                <StandardRefs cfr={item.cfr} />
              </View>
            </View>
          ))}
          {mrf.inspectionId ? (
            <>
              <Divider />
              <View style={{ padding: space.md }}>
                <Button label="Open the pre-op" size="md" kind="quiet" onPress={() => navigation.navigate('InspectionDetail', { inspectionId: mrf.inspectionId! })} />
              </View>
            </>
          ) : null}
        </Panel>
      ) : null}

      <Panel title="History" flush>
        {mrf.history.map((entry, i) => (
          <View key={`${entry.at}-${i}`}>
            {i > 0 ? <Divider inset={space.lg} /> : null}
            <View style={styles.item}>
              <Txt v="strong">{HISTORY_LABEL[entry.status]}</Txt>
              <Txt v="small" c={color.silica}>{fmtDateTime(entry.at)}, {employeeName(employees, entry.by)}</Txt>
              {entry.note ? <Txt v="body" c={color.inkSoft}>{entry.note}</Txt> : null}
            </View>
          </View>
        ))}
      </Panel>

      <Sheet
        testID="mrf-status-sheet"
        visible={next != null}
        onClose={() => setNext(null)}
        title={next === 'completed' ? 'Complete this request' : 'Start work'}
      >
        <Field
          testID="mrf-note"
          label={next === 'completed' ? 'What was done?' : 'Note for the operator (optional)'}
          placeholder={next === 'completed' ? 'Parts replaced, tests run' : 'Parts on order, safe to run until fixed'}
          value={note}
          onChangeText={(text) => { setNote(text); setError(null); }}
          multiline
          error={error}
        />
        {next === 'completed' && mrf.taggedOut ? (
          <Txt v="small" c={color.silica}>Completing this removes the tag-out and puts the unit back in service.</Txt>
        ) : null}
        <Button testID="mrf-apply" label={next === 'completed' ? 'Complete and return to service' : 'Start work'} kind={next === 'completed' ? 'green' : 'ink'} onPress={apply} />
      </Sheet>
    </Page>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  item: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: 2 },
});
