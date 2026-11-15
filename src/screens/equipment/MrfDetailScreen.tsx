import { Tag as TagIcon, UserCog } from '../../components/icons';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PaperLine, PaperRow, PaperSheet } from '../../components/Paper';
import { StandardRefs } from '../../components/Standards';
import { Avatar, Button, Divider, Field, Notice, Page, Panel, Row, Segmented, Sheet, Tag, Txt, UnitPlate } from '../../components/ui';
import { examFindings, openFindings } from '../../domain/areaExam';
import type { Employee, MrfEvent, MrfPriority, MrfStatus } from '../../domain/types';
import type { ScreenProps } from '../../navigation/types';
import { haptic } from '../../services/haptics';
import { employeeName, useMe, useStore } from '../../store/useStore';
import { color, space, type Tone } from '../../theme/theme';
import { fmtDate, fmtDateTime, fmtHrs, fmtMeter, fullName, initials, toHundredths } from '../../util/format';

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
  completed: 'Completed',
};

/** People who do repairs come first in the list to assign from. */
const isMaintenance = (e: Employee) => /mechanic|maintenance/i.test(e.title ?? '');

/** A maintenance request as the paper form, filled in as the work is done. */
export function MrfDetailScreen({ navigation, route }: ScreenProps<'MrfDetail'>) {
  const me = useMe();
  const mrf = useStore((s) => s.mrfs.find((m) => m.id === route.params.mrfId));
  const unit = useStore((s) => s.equipment.find((e) => e.id === mrf?.equipmentId));
  const employees = useStore((s) => s.employees);
  const { assignMrf, startMrf, completeMrf, showToast } = useStore.getState();

  const exams = useStore((s) => s.exams);

  const [sheet, setSheet] = useState<'assign' | 'start' | 'complete' | null>(null);
  const [note, setNote] = useState('');
  const [hours, setHours] = useState('');
  const [doneBy, setDoneBy] = useState<'assignee' | 'me'>('assignee');
  const [error, setError] = useState<string | null>(null);

  if (!mrf || !me) return null;
  const status = MRF_STATUS[mrf.status];
  const priority = MRF_PRIORITY[mrf.priority];
  const supervisor = me.role === 'supervisor';
  const canWork = supervisor || mrf.assignedTo === me.id;
  const done = mrf.status === 'completed';
  const name = (id?: string) => (id ? employeeName(employees, id) : '');
  const where = [unit ? `${unit.unit} ${unit.make} ${unit.model}` : '', mrf.location ?? ''].filter(Boolean).join(', ');
  const crew = employees.filter((e) => e.active).sort((a, b) => Number(isMaintenance(b)) - Number(isMaintenance(a)) || a.lastName.localeCompare(b.lastName));
  // A supervisor closing a request out for the person it is assigned to says whose work it was.
  const forSomeone = supervisor && !!mrf.assignedTo && mrf.assignedTo !== me.id;
  // The line on the pre shift exam this request was sent for, and the same line found again since.
  const exam = exams.find((x) => x.id === mrf.examId);
  const finding = exam && mrf.findingKey ? examFindings(exam).find((f) => f.key === mrf.findingKey) : undefined;
  const foundAgain = exam && finding ? openFindings(exams, exam.sheetId).filter((f) => f.key === finding.key && f.examId !== exam.id) : [];
  const live = () => useStore.getState().mrfs.find((m) => m.id === mrf.id);

  const open = (next: typeof sheet) => {
    setNote('');
    setHours('');
    setDoneBy('assignee');
    setError(null);
    setSheet(next);
  };

  const fail = (text: string) => {
    haptic.error();
    setError(text);
  };

  const start = () => {
    // A second tap that lands while the sheet is closing has nothing left to do.
    if (live()?.status !== 'open') return;
    const result = startMrf(mrf.id, note);
    if (!result.ok) return fail(result.error);
    haptic.success();
    showToast(`Request #${mrf.number} is in progress`);
    setSheet(null);
  };

  const complete = () => {
    if (live()?.status === 'completed') return;
    const typed = hours.trim();
    const value = Number(typed);
    if (typed && !(Number.isFinite(value) && value > 0)) return fail('Enter the time spent in hours, like 1.5.');
    // Hours typed as a decimal are kept as hundredths, the way the timesheet does.
    const result = completeMrf(mrf.id, {
      remarks: note,
      timeSpent: typed ? toHundredths(value * 60) : undefined,
      completedBy: forSomeone && doneBy === 'assignee' ? mrf.assignedTo : undefined,
    });
    if (!result.ok) return fail(result.error);
    haptic.success();
    // Say what is true of the unit now: another request can still have it red tagged.
    const now = unit ? useStore.getState().equipment.find((e) => e.id === unit.id)?.status : undefined;
    const again = foundAgain[0];
    if (again) {
      showToast(`Request #${mrf.number} completed. The same line is still open on the exam of ${fmtDate(again.foundAt)}.`, 'warn');
    } else if (unit && mrf.taggedOut && now === 'out_of_service') {
      showToast(`Request #${mrf.number} completed. ${unit.unit} stays red tagged on another request.`, 'warn');
    } else if (unit && mrf.taggedOut) {
      showToast(`Request #${mrf.number} completed. ${unit.unit} is back in service.`);
    } else {
      showToast(`Request #${mrf.number} completed`);
    }
    setSheet(null);
  };

  const eventTitle = (entry: MrfEvent) => (entry.assignedTo ? `Assigned to ${name(entry.assignedTo)}` : HISTORY_LABEL[entry.status]);

  return (
    <Page
      testID="mrf-detail"
      title={`Request #${mrf.number}`}
      sub={`Sent ${fmtDateTime(mrf.createdAt)}`}
      onBack={navigation.goBack}
      footer={
        !done && (supervisor || canWork) ? (
          <>
            {supervisor ? (
              <Button testID="mrf-assign" label={mrf.assignedTo ? 'Assign to someone else' : 'Assign it'} icon={UserCog} kind="outline" onPress={() => open('assign')} />
            ) : null}
            {canWork && mrf.status === 'open' ? <Button testID="mrf-start" label="Start work" kind="ink" onPress={() => open('start')} /> : null}
            {canWork ? <Button testID="mrf-complete" label="Complete it" kind="green" onPress={() => open('complete')} /> : null}
          </>
        ) : undefined
      }
    >
      <View style={styles.tags}>
        <Tag label={status.label} tone={status.tone} solid />
        <Tag label={`${priority.label} priority`} tone={priority.tone} />
        {mrf.taggedOut && !done ? <Tag label="Red tagged" tone="bo" icon={TagIcon} /> : null}
      </View>

      {mrf.taggedOut && !done ? (
        <Notice tone="bo" icon={TagIcon} title="Red tagged. Do not operate." body="The unit stays out of service until this request is completed." />
      ) : null}

      <PaperSheet title="Maintenance request" corner={`No. ${mrf.number}`} testID="mrf-paper">
        <PaperRow>
          <PaperLine label="By" value={name(mrf.requestedBy)} flex={1.2} testID="mrf-by" />
          <PaperLine label="Date" value={fmtDateTime(mrf.createdAt)} testID="mrf-date" />
        </PaperRow>
        <PaperRow><PaperLine label="Location" value={where} testID="mrf-where" /></PaperRow>
        <PaperRow><PaperLine label="Problem" value={mrf.description} tall testID="mrf-problem" /></PaperRow>
        <PaperRow><PaperLine label="Assigned to" value={name(mrf.assignedTo)} testID="mrf-assigned" /></PaperRow>
        {/* One line on the paper. A phone is too narrow for both, so each gets its own. */}
        <PaperRow><PaperLine label="Date completed" value={mrf.completedAt ? fmtDateTime(mrf.completedAt) : ''} testID="mrf-completed" /></PaperRow>
        <PaperRow><PaperLine label="Time spent" value={mrf.timeSpent != null ? `${fmtHrs(mrf.timeSpent)} hrs` : ''} testID="mrf-time" /></PaperRow>
        <PaperRow><PaperLine label="Completed by" value={name(mrf.completedBy)} testID="mrf-completed-by" /></PaperRow>
        <PaperRow><PaperLine label="Remarks" value={mrf.remarks} tall testID="mrf-remarks" /></PaperRow>
        <View style={{ height: space.md }} />
      </PaperSheet>

      {unit ? (
        <Panel>
          <View style={styles.head}>
            <UnitPlate unit={unit.unit} size="lg" />
            <View style={{ flex: 1, gap: 2 }}>
              <Txt v="strong">{unit.make} {unit.model}</Txt>
              {mrf.meter != null ? (
                <Txt v="small" c={color.silica}>{unit.meterUnit === 'mi' ? 'Odometer' : 'Equipment hours'} {fmtMeter(mrf.meter)} when the request was sent</Txt>
              ) : null}
            </View>
          </View>
        </Panel>
      ) : null}

      {mrf.items.length > 0 ? (
        <Panel title="From the equipment checklist" flush>
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
        </Panel>
      ) : null}

      {mrf.inspectionId || mrf.examId ? (
        <View style={{ gap: space.sm }}>
          {mrf.inspectionId ? (
            <Button testID="mrf-open-checklist" label="Open the equipment checklist" size="md" kind="quiet" onPress={() => navigation.navigate('InspectionDetail', { inspectionId: mrf.inspectionId! })} />
          ) : null}
          {mrf.examId ? (
            <Button testID="mrf-open-exam" label="Open the pre shift exam" size="md" kind="quiet" onPress={() => navigation.navigate('AreaExamDetail', { examId: mrf.examId! })} />
          ) : null}
        </View>
      ) : null}

      <Panel title="History" flush>
        {mrf.history.map((entry, i) => (
          <View key={`${entry.at}-${i}`}>
            {i > 0 ? <Divider inset={space.lg} /> : null}
            <View style={styles.item}>
              <Txt v="strong">{eventTitle(entry)}</Txt>
              <Txt v="small" c={color.silica}>{fmtDateTime(entry.at)}, {name(entry.by)}</Txt>
              {entry.note ? <Txt v="body" c={color.inkSoft}>{entry.note}</Txt> : null}
            </View>
          </View>
        ))}
      </Panel>

      <Sheet testID="mrf-assign-sheet" visible={sheet === 'assign'} onClose={() => setSheet(null)} title="Assigned to">
        {error ? <Txt v="small" c={color.red}>{error}</Txt> : null}
        <Panel flush>
          {crew.map((person, i) => (
            <View key={person.id}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <Row
                testID={`assign-${person.id}`}
                left={<Avatar initials={initials(person.firstName, person.lastName)} tone={person.id === mrf.assignedTo ? 'ok' : 'ink'} />}
                title={fullName(person)}
                sub={person.title}
                right={person.id === mrf.assignedTo ? <Tag label="Assigned" tone="ok" /> : undefined}
                onPress={() => {
                  const result = assignMrf(mrf.id, person.id);
                  if (!result.ok) return fail(result.error);
                  haptic.success();
                  showToast(`Request #${mrf.number} assigned to ${fullName(person)}`);
                  setSheet(null);
                }}
              />
            </View>
          ))}
        </Panel>
      </Sheet>

      <Sheet testID="mrf-status-sheet" visible={sheet === 'start' || sheet === 'complete'} onClose={() => setSheet(null)} title={sheet === 'complete' ? 'Complete this request' : 'Start work'}>
        <Field
          testID="mrf-note"
          label={sheet === 'complete' ? 'Remarks: what was done?' : 'Note for the operator (optional)'}
          placeholder={sheet === 'complete' ? 'Parts replaced, tests run' : 'Parts on order, safe to run until fixed'}
          value={note}
          onChangeText={(text) => { setNote(text); setError(null); }}
          multiline
          error={error}
        />
        {sheet === 'complete' ? (
          <Field
            testID="mrf-hours"
            label="Time spent (hours)"
            placeholder="1.5"
            value={hours}
            onChangeText={(text) => { setHours(text); setError(null); }}
            keyboardType="decimal-pad"
            hint="Leave blank if you did not keep track."
          />
        ) : null}
        {sheet === 'complete' && forSomeone ? (
          <View style={{ gap: 6 }}>
            <Txt v="smallStrong">Who did the work?</Txt>
            <Segmented<'assignee' | 'me'>
              testID="mrf-done-by"
              value={doneBy}
              onChange={setDoneBy}
              options={[{ value: 'assignee', label: name(mrf.assignedTo) }, { value: 'me', label: 'I did' }]}
            />
            <Txt v="small" c={color.silica}>
              That name goes on the form as Completed by. The history shows that you entered it.
            </Txt>
          </View>
        ) : null}
        {sheet === 'complete' && !forSomeone ? (
          <Txt v="small" c={color.silica}>Your name, {fullName(me)}, goes on the form as Completed by.</Txt>
        ) : null}
        {sheet === 'complete' && unit && mrf.taggedOut ? (
          <Txt v="small" c={color.silica}>Completing this takes this request's red tag off. The unit goes back in service unless another request still has it tagged.</Txt>
        ) : null}
        {sheet === 'complete' && finding ? (
          <Txt v="small" c={color.silica}>
            {finding.fixed
              ? `The pre shift exam already has ${fmtDate(finding.fixed.at)} as the date this was fixed. That date stands.`
              : 'Today goes on the pre shift exam as the date this was fixed.'}
          </Txt>
        ) : null}
        {sheet === 'complete' && foundAgain.length > 0 ? (
          <Txt v="small" c={color.red}>
            The same line was found again on {fmtDate(foundAgain[0].foundAt)} and is still open on that exam. Completing this does not close it there.
          </Txt>
        ) : null}
        <Button
          testID="mrf-apply"
          label={sheet === 'complete' ? 'Complete the request' : 'Start work'}
          kind={sheet === 'complete' ? 'green' : 'ink'}
          onPress={sheet === 'complete' ? complete : start}
        />
      </Sheet>
    </Page>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  item: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: 2 },
});
