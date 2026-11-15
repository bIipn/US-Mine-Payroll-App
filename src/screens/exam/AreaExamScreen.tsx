import { Plus, Siren, Trash } from '../../components/icons';
import React, { useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useLeaveGuard } from '../../components/LeaveGuard';
import { StandardRefs } from '../../components/Standards';
import { Button, CheckRow, Field, IconButton, MultiChoice, Notice, ProgressBar, Segmented, Sheet, Tag, TopBar, Txt, TriChoice } from '../../components/ui';
import { AREA_CONDITIONS, EXAM_COLUMNS, openFindings, shiftAt, SHIFTS, type ExamDraft, type Finding } from '../../domain/areaExam';
import type { Answer, ExamColumn, ShiftName } from '../../domain/types';
import type { ScreenProps } from '../../navigation/types';
import { haptic } from '../../services/haptics';
import { useMe, useStore } from '../../store/useStore';
import { color, radius, space } from '../../theme/theme';
import { fmtDate, fmtTime, fullName } from '../../util/format';

interface LineDraft {
  answer: Answer;
  columns: ExamColumn[];
  note: string;
  danger: boolean;
}
interface OtherLine {
  key: number;
  label: string;
  mark?: LineDraft;
}

const blank = (answer: Answer): LineDraft => ({ answer, columns: [], note: '', danger: false });

/** A Bad Order has to say what is wrong, and on the area sheet which column it is in. */
const rowUnfinished = (mark?: LineDraft) => !mark || (mark.answer === 'bo' && (!mark.note.trim() || mark.columns.length === 0));
const conditionUnfinished = (mark?: LineDraft) => !mark || (mark.answer === 'bo' && !mark.note.trim());

/** The Pre Shift Exam of one work area: its own lines, then the 20 conditions. */
export function AreaExamScreen({ navigation, route }: ScreenProps<'AreaExam'>) {
  const insets = useSafeAreaInsets();
  const me = useMe();
  const sheet = useStore((s) => s.areaSheets.find((x) => x.id === route.params.sheetId));
  const exams = useStore((s) => s.exams);
  const mrfs = useStore((s) => s.mrfs);
  const allowAllOk = useStore((s) => s.settings.allowSectionAllOk);
  const { submitExam, showToast } = useStore.getState();

  const startedAt = useRef(Date.now()).current;
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const positions = useRef<Record<string, number>>({});
  const nextKey = useRef(1);

  const [shift, setShift] = useState<ShiftName>(shiftAt(startedAt));
  const [rows, setRows] = useState<Record<string, LineDraft>>({});
  const [others, setOthers] = useState<OtherLine[]>([]);
  const [conditions, setConditions] = useState<Record<string, LineDraft>>({});
  const [signing, setSigning] = useState(false);
  const [certified, setCertified] = useState(false);
  const [showMissing, setShowMissing] = useState(false);

  const stillOpen = useMemo(() => (sheet ? openFindings(exams, sheet.id) : []), [exams, sheet]);
  /** What is still open on each line, by the line's key. A danger comes first, then the newest. */
  const openOn = useMemo(() => {
    const byLine = new Map<string, Finding>();
    for (const finding of stillOpen) if (!byLine.has(finding.key)) byLine.set(finding.key, finding);
    return byLine;
  }, [stillOpen]);

  // Once anything is marked, leaving asks first. Signing lets go of the guard before it moves on.
  const sent = useRef(false);
  const dirty = Object.keys(rows).length + Object.keys(conditions).length + others.length > 0;
  const guard = useLeaveGuard(navigation, dirty, {
    title: 'Leave this exam?',
    body: 'It is not signed yet. What you have marked on it will be lost.',
  });

  if (!sheet || !me) return null;

  const marks = [...sheet.rows.map((r) => rows[r.id]), ...others.map((o) => o.mark), ...AREA_CONDITIONS.map((c) => conditions[c.id])];
  const total = marks.length;
  const answered = marks.filter(Boolean).length;
  const counts = { ok: 0, bo: 0, na: 0 };
  for (const mark of marks) if (mark) counts[mark.answer] += 1;
  const danger = marks.some((mark) => mark?.answer === 'bo' && mark.danger);

  const setRow = (id: string, patch: Partial<LineDraft>) => setRows((d) => ({ ...d, [id]: { ...(d[id] ?? blank('ok')), ...patch } }));
  const setCondition = (id: string, patch: Partial<LineDraft>) =>
    setConditions((d) => ({ ...d, [id]: { ...(d[id] ?? blank('ok')), ...patch } }));
  const setOther = (key: number, patch: Partial<OtherLine>) => setOthers((list) => list.map((o) => (o.key === key ? { ...o, ...patch } : o)));
  const setOtherMark = (key: number, patch: Partial<LineDraft>) =>
    setOthers((list) => list.map((o) => (o.key === key ? { ...o, mark: { ...(o.mark ?? blank('ok')), ...patch } } : o)));

  /** The first line that still needs something, as the key it was laid out under. */
  const firstProblem = (): string | undefined => {
    const row = sheet.rows.find((r) => rowUnfinished(rows[r.id]));
    if (row) return `row-${row.id}`;
    const other = others.find((o) => !o.label.trim() || rowUnfinished(o.mark));
    if (other) return `other-${other.key}`;
    const condition = AREA_CONDITIONS.find((c) => conditionUnfinished(conditions[c.id]));
    return condition ? `cond-${condition.id}` : undefined;
  };

  const review = () => {
    const problem = firstProblem();
    if (problem) {
      setShowMissing(true);
      haptic.warning();
      scroll.current?.scrollTo({ y: Math.max(0, (positions.current[problem] ?? 0) - 12), animated: true });
      const left = total - answered;
      showToast(
        left > 0
          ? `${left} ${left === 1 ? 'line still needs' : 'lines still need'} an answer`
          : others.some((o) => !o.label.trim())
            ? 'Name the line you added under Other, or take it off'
            : 'Finish each Bad Order: what is wrong, and where',
        'warn',
      );
      return;
    }
    setSigning(true);
  };

  const submit = () => {
    // One exam for one signature, however many times the button lands.
    if (sent.current) return;
    const draft: ExamDraft = {
      sheetId: sheet.id,
      shift,
      startedAt,
      rows,
      others: others.map((o) => ({ label: o.label, mark: o.mark ?? blank('ok') })),
      conditions,
    };
    const result = submitExam(draft);
    if (!result.ok) {
      showToast(result.error, 'bo');
      return;
    }
    sent.current = true;
    setSigning(false);
    if (counts.bo > 0) haptic.warning();
    else haptic.success();
    const examId = result.exam.id;
    guard.done(() => navigation.replace('AreaExamDetail', { examId, fresh: true }));
  };

  /** A reminder on a line that has a condition open from an earlier exam. */
  const openNote = (key: string, answer?: Answer) => {
    const open = openOn.get(key);
    if (!open) return null;
    const request = open.mrfId ? mrfs.find((m) => m.id === open.mrfId) : undefined;
    return (
      <View testID={`open-${key}`} style={styles.open}>
        <Txt v="smallStrong" c={color.red}>{open.danger ? 'Danger, still open' : 'Still open'} from {fmtDate(open.foundAt)}</Txt>
        <Txt v="small" c={color.inkSoft}>
          {open.note ?? open.where}
          {request ? `. Maintenance request #${request.number} is in.` : ''}
        </Txt>
        {answer === 'ok' || answer === 'na' ? (
          <Txt v="small" c={color.inkSoft}>Marking it here does not close it. If it has been fixed, the date fixed goes on that exam.</Txt>
        ) : null}
      </View>
    );
  };

  const place = (key: string) => (e: { nativeEvent: { layout: { y: number } } }) => {
    positions.current[key] = e.nativeEvent.layout.y;
  };

  /** What is asked once a line is a Bad Order. `columns` is only for the area sheet. */
  const badOrder = (id: string, mark: LineDraft, change: (patch: Partial<LineDraft>) => void, withColumns: boolean) => (
    <View style={styles.bad}>
      {withColumns ? (
        <View style={{ gap: 6 }}>
          <Txt v="smallStrong">What is wrong with it?</Txt>
          <MultiChoice<ExamColumn>
            testID={`col-${id}`}
            value={mark.columns}
            onChange={(columns) => change({ columns })}
            options={EXAM_COLUMNS.map((c) => ({ value: c.id, label: c.label }))}
          />
          {showMissing && mark.columns.length === 0 ? <Txt v="small" c={color.red}>Pick at least one.</Txt> : null}
          <StandardRefs refs={EXAM_COLUMNS.filter((c) => mark.columns.includes(c.id)).flatMap((c) => c.refs)} />
        </View>
      ) : null}
      <Field
        testID={`note-${id}`}
        label="What did you find?"
        placeholder="Say what you see, and where"
        value={mark.note}
        onChangeText={(note) => change({ note })}
        multiline
        error={showMissing && !mark.note.trim() ? 'Write down the condition. It goes on the record.' : null}
      />
      <CheckRow
        testID={`danger-${id}`}
        label="Someone could get hurt right now"
        sub="Tell your supervisor at once. People stay out of the area until it is fixed."
        value={mark.danger}
        onChange={(value) => change({ danger: value })}
      />
    </View>
  );

  // "Rest are OK" passes over a line that has a condition still open: that one is looked at and marked by hand.
  const restOk = (which: 'rows' | 'conditions') => {
    const skipped =
      which === 'rows'
        ? sheet.rows.filter((r) => !rows[r.id] && openOn.has(`row:${r.id}`)).length
        : AREA_CONDITIONS.filter((c) => !conditions[c.id] && openOn.has(`cond:${c.id}`)).length;
    if (which === 'rows') {
      setRows((d) => {
        const next = { ...d };
        for (const r of sheet.rows) if (!next[r.id] && !openOn.has(`row:${r.id}`)) next[r.id] = blank('ok');
        return next;
      });
      setOthers((list) => list.map((o) => (o.mark ? o : { ...o, mark: blank('ok') })));
    } else {
      setConditions((d) => {
        const next = { ...d };
        for (const c of AREA_CONDITIONS) if (!next[c.id] && !openOn.has(`cond:${c.id}`)) next[c.id] = blank('ok');
        return next;
      });
    }
    if (skipped > 0) {
      showToast(skipped === 1 ? 'One line has a condition still open. Mark that one yourself.' : `${skipped} lines have a condition still open. Mark those yourself.`, 'warn');
    }
  };
  const rowsLeft = sheet.rows.some((r) => !rows[r.id] && !openOn.has(`row:${r.id}`)) || others.some((o) => !o.mark);
  const conditionsLeft = AREA_CONDITIONS.some((c) => !conditions[c.id] && !openOn.has(`cond:${c.id}`));
  const dangerOpen = stillOpen.some((f) => f.danger);

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <TopBar title={`${sheet.title} pre shift exam`} sub={`${fmtDate(startedAt)}, ${fmtTime(startedAt)}`} onBack={navigation.goBack} />
      <View style={styles.progress}>
        <ProgressBar value={total ? answered / total : 0} tone={counts.bo > 0 ? 'bo' : 'ok'} height={8} />
        <Txt v="smallStrong" c={color.silica} testID="exam-progress">{answered} of {total} checked</Txt>
      </View>

      <ScrollView ref={scroll} testID="exam-screen" contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* The head of the sheet: employee, date and shift. */}
        <View style={styles.sheet}>
          <Txt v="cap" c={color.silica}>Pre shift exam</Txt>
          <Txt v="lead" numberOfLines={1}>{fullName(me)}</Txt>
          <View style={{ gap: 6 }}>
            <Txt v="smallStrong">Shift</Txt>
            <Segmented<ShiftName> testID="exam-shift" value={shift} onChange={setShift} options={SHIFTS.map((s) => ({ value: s.id, label: s.label }))} />
          </View>
          <Txt v="small" c={color.silica}>Examine the area before work starts in it. Mark each line, and write down anything that could hurt someone.</Txt>
          <StandardRefs cfr="56.18002" />
        </View>

        {stillOpen.length > 0 ? (
          <View testID="exam-still-open">
            <Notice
              tone="bo"
              icon={dangerOpen ? Siren : undefined}
              title={
                dangerOpen
                  ? 'A danger is still open here. People stay out until it is fixed.'
                  : stillOpen.length === 1 ? 'One condition is still open here' : `${stillOpen.length} conditions are still open here`
              }
              body={stillOpen.map((f) => `${f.danger ? 'Danger. ' : ''}${f.label}: ${f.note ?? f.where}`).join('\n')}
            />
          </View>
        ) : null}

        <View style={styles.sectionHead}>
          <View style={{ flex: 1 }}>
            <Txt v="h3" accessibilityRole="header">{sheet.title} areas</Txt>
            <Txt v="small" c={color.silica}>Each line is checked for guarding, electrical and safe access.</Txt>
          </View>
          {allowAllOk && rowsLeft ? <Button testID="rows-ok" label="Rest are OK" size="md" kind="quiet" onPress={() => restOk('rows')} /> : null}
        </View>

        {sheet.rows.length === 0 && others.length === 0 ? (
          <Txt v="small" c={color.silica} style={{ paddingHorizontal: 4 }}>
            This area has no lines of its own on its sheet yet. Add what you examine under Other, then go through the conditions.
          </Txt>
        ) : null}

        {sheet.rows.map((row) => {
          const mark = rows[row.id];
          const flagged = showMissing && rowUnfinished(mark);
          return (
            <View key={row.id} testID={`line-row-${row.id}`} onLayout={place(`row-${row.id}`)} style={[styles.item, flagged && styles.itemFlagged, mark?.answer === 'bo' && styles.itemBad]}>
              <Txt v="strong">{row.label}</Txt>
              {openNote(`row:${row.id}`, mark?.answer)}
              <TriChoice testID={`row-${row.id}`} value={mark?.answer} onChange={(answer) => setRow(row.id, { answer })} />
              {mark?.answer === 'bo' ? badOrder(`row-${row.id}`, mark, (patch) => setRow(row.id, patch), true) : null}
            </View>
          );
        })}

        {others.map((other) => {
          const flagged = showMissing && (!other.label.trim() || rowUnfinished(other.mark));
          return (
            <View key={other.key} testID={`line-other-${other.key}`} onLayout={place(`other-${other.key}`)} style={[styles.item, flagged && styles.itemFlagged, other.mark?.answer === 'bo' && styles.itemBad]}>
              <View style={styles.otherHead}>
                <View style={{ flex: 1 }}>
                  <Field
                    testID={`other-label-${other.key}`}
                    label="Other (specify)"
                    placeholder="What did you examine?"
                    value={other.label}
                    onChangeText={(label) => setOther(other.key, { label })}
                    error={showMissing && !other.label.trim() ? 'Name it, or take the line off.' : null}
                  />
                </View>
                <IconButton icon={Trash} label="Take this line off" onPress={() => setOthers((list) => list.filter((o) => o.key !== other.key))} bg={color.grayTint} />
              </View>
              <TriChoice testID={`other-${other.key}`} value={other.mark?.answer} onChange={(answer) => setOtherMark(other.key, { answer })} />
              {other.mark?.answer === 'bo' ? badOrder(`other-${other.key}`, other.mark, (patch) => setOtherMark(other.key, patch), true) : null}
            </View>
          );
        })}

        <Button
          testID="add-other"
          label="Add a line under Other"
          icon={Plus}
          size="md"
          kind="quiet"
          onPress={() => setOthers((list) => [...list, { key: nextKey.current++, label: '' }])}
        />

        <View style={styles.sectionHead}>
          <View style={{ flex: 1 }}>
            <Txt v="h3" accessibilityRole="header">Conditions</Txt>
            <Txt v="small" c={color.silica}>The second page of the sheet. Mark N/A where the area has none.</Txt>
          </View>
          {allowAllOk && conditionsLeft ? <Button testID="conditions-ok" label="Rest are OK" size="md" kind="quiet" onPress={() => restOk('conditions')} /> : null}
        </View>

        {AREA_CONDITIONS.map((condition) => {
          const mark = conditions[condition.id];
          const flagged = showMissing && conditionUnfinished(mark);
          return (
            <View key={condition.id} testID={`line-cond-${condition.id}`} onLayout={place(`cond-${condition.id}`)} style={[styles.item, flagged && styles.itemFlagged, mark?.answer === 'bo' && styles.itemBad]}>
              <Txt v="strong">{condition.label}</Txt>
              {condition.detail ? <Txt v="small" c={color.silica}>{condition.detail}</Txt> : null}
              <StandardRefs refs={condition.refs} />
              {openNote(`cond:${condition.id}`, mark?.answer)}
              <TriChoice testID={`cond-${condition.id}`} value={mark?.answer} onChange={(answer) => setCondition(condition.id, { answer })} />
              {mark?.answer === 'bo' ? badOrder(`cond-${condition.id}`, mark, (patch) => setCondition(condition.id, patch), false) : null}
            </View>
          );
        })}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
        <View style={styles.tally}>
          <Tag label={`${counts.ok} OK`} tone="ok" />
          <Tag label={`${counts.bo} BO`} tone={counts.bo ? 'bo' : 'neutral'} solid={counts.bo > 0} />
          <Tag label={`${counts.na} N/A`} tone="neutral" />
          <Txt v="smallStrong" c={color.silica} style={{ marginLeft: 'auto' }}>{total - answered} left</Txt>
        </View>
        <Button testID="exam-review" label="Review and sign" kind={answered === total ? 'yellow' : 'quiet'} onPress={review} />
      </View>

      <Sheet testID="exam-sign-sheet" visible={signing} onClose={() => setSigning(false)} title="Sign the exam">
        <Txt v="strong">{sheet.title}, {SHIFTS.find((s) => s.id === shift)?.label.toLowerCase()} shift</Txt>
        <View style={styles.tally}>
          <Tag label={`${counts.ok} OK`} tone="ok" />
          <Tag label={`${counts.bo} Bad Order`} tone={counts.bo ? 'bo' : 'neutral'} solid={counts.bo > 0} />
          <Tag label={`${counts.na} N/A`} tone="neutral" />
        </View>
        {counts.bo > 0 ? (
          <Txt v="body" c={color.inkSoft}>
            {danger
              ? 'You marked a danger. Next you will get the steps to keep people out and get it fixed.'
              : 'Each Bad Order stays open on this area until the date it was fixed is recorded.'}
          </Txt>
        ) : null}
        <CheckRow
          testID="exam-certify"
          label="I examined this work area myself before work started in it this shift."
          sub={`${fullName(me)}, ${fmtTime(Date.now())}`}
          value={certified}
          onChange={setCertified}
        />
        <Button testID="exam-submit" label="Submit exam" kind={danger ? 'red' : 'yellow'} disabled={!certified} onPress={submit} />
      </Sheet>
      {guard.sheet}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.kaolin },
  progress: { paddingHorizontal: space.xl, paddingBottom: space.sm, gap: 4 },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xxl, gap: space.md },
  sheet: {
    gap: space.md,
    padding: space.lg,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.rule,
  },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.lg, paddingHorizontal: 4 },
  item: {
    gap: space.sm,
    padding: space.lg,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.rule,
  },
  itemFlagged: { borderColor: color.amber, borderWidth: 2.5, padding: space.lg - 1.5 },
  itemBad: { borderColor: color.red, borderWidth: 2.5, padding: space.lg - 1.5 },
  otherHead: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  bad: { gap: space.md, marginTop: 4, padding: space.md, borderRadius: radius.md, backgroundColor: color.redTint },
  open: { gap: 2, paddingVertical: space.sm, paddingHorizontal: space.md, borderLeftWidth: 4, borderLeftColor: color.red, backgroundColor: color.redTint },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    gap: space.sm,
    backgroundColor: color.paper,
    borderTopWidth: 1,
    borderTopColor: color.rule,
  },
  tally: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
});
