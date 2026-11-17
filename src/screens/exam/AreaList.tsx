import { useNavigation } from '@react-navigation/native';
import { Factory, ListChecks, Siren, Wrench } from '../../components/icons';
import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { StandardRefs } from '../../components/Standards';
import { Button, Divider, EmptyState, Notice, Panel, Row, Sheet, Tag, Txt } from '../../components/ui';
import { foundLine, openFindings, shiftLabel } from '../../domain/areaExam';
import type { AreaExam } from '../../domain/types';
import { employeeName, useMe, useStore } from '../../store/useStore';
import { color, radius, space } from '../../theme/theme';
import { fmtRelativeDay, fmtTime, shortName, startOfDay } from '../../util/format';

/** The work areas, each with today's latest pre shift exam, the shift it was for, and the conditions still open in it. */
export function AreaList({ now }: { now: number }) {
  const navigation = useNavigation();
  const me = useMe();
  const sheets = useStore((s) => s.areaSheets);
  const exams = useStore((s) => s.exams);
  const employees = useStore((s) => s.employees);
  const [openId, setOpenId] = useState<string | null>(null);

  const today = startOfDay(now);
  const active = sheets.filter((s) => s.active);
  const open = useMemo(() => openFindings(exams), [exams]);
  /** The latest exam of each area today. */
  const latest = useMemo(() => {
    const map = new Map<string, AreaExam>();
    for (const exam of exams) if (exam.submittedAt >= today) map.set(exam.sheetId, exam);
    return map;
  }, [exams, today]);

  const sheet = active.find((s) => s.id === openId);
  const sheetExam = sheet ? latest.get(sheet.id) : undefined;
  const sheetOpen = sheet ? open.filter((f) => f.sheetId === sheet.id) : [];
  const go = (action: () => void) => {
    setOpenId(null);
    action();
  };
  const by = (exam: AreaExam) => {
    const who = employees.find((e) => e.id === exam.employeeId);
    return who ? shortName(who) : 'someone';
  };
  // An exam is for one shift, and the next crew makes its own. So the row names the shift
  // it was made for, and leaves it to the person to see that theirs is still to do.
  const onShift = (exam: AreaExam) => `${shiftLabel(exam.shift).toLowerCase()} shift`;

  return (
    <>
      <View style={styles.intro}>
        <Txt v="body" c={color.inkSoft}>Examine your work area before work starts in it on the shift. Anything wrong stays on the list until it is fixed.</Txt>
        <StandardRefs cfr="56.18002" />
      </View>

      {active.length === 0 ? (
        <EmptyState icon={Factory} title="No area sheets yet" body="A supervisor adds the sheet for each work area under Crew, then Area sheets." />
      ) : (
        <Panel flush>
          {active.map((s, i) => {
            const exam = latest.get(s.id);
            const here = open.filter((f) => f.sheetId === s.id);
            const waiting = here.length;
            // A danger is not one more open item: people stay out of the area, so the row says so.
            const danger = here.some((f) => f.danger);
            return (
              <View key={s.id}>
                {i > 0 ? <Divider inset={space.lg} /> : null}
                <Row
                  testID={`area-${s.id}`}
                  left={
                    <View style={[styles.areaIcon, danger && { backgroundColor: color.red }]}>
                      {danger ? <Siren color={color.white} size={24} /> : <Factory color={color.ink} size={24} />}
                    </View>
                  }
                  title={s.title}
                  sub={exam ? `Examined at ${fmtTime(exam.submittedAt)} by ${by(exam)}` : 'Not examined yet today'}
                  below={
                    <>
                      {danger ? <Tag label="Danger, keep out" tone="bo" solid icon={Siren} /> : null}
                      <Tag label={exam ? `Examined, ${onShift(exam)}` : 'Exam due'} tone={exam ? 'ok' : 'warn'} />
                      {waiting > 0 ? <Tag label={`${waiting} open`} tone="bo" solid={!danger} /> : null}
                    </>
                  }
                  chevron
                  onPress={() => setOpenId(s.id)}
                />
              </View>
            );
          })}
        </Panel>
      )}

      <Button
        testID="area-mrf"
        label="Send a maintenance request"
        icon={Wrench}
        kind="quiet"
        onPress={() => navigation.navigate('MrfForm', {})}
      />
      {me?.role === 'supervisor' ? (
        <Button testID="area-sheets" label="Add or change area sheets" icon={ListChecks} kind="quiet" onPress={() => navigation.navigate('AreaSheets')} />
      ) : null}

      <Sheet testID="area-sheet" visible={!!sheet} onClose={() => setOpenId(null)} title={sheet?.title ?? ''}>
        {sheet ? (
          <>
            <Txt v="body" c={color.inkSoft}>
              {sheetExam
                ? `Examined today at ${fmtTime(sheetExam.submittedAt)} by ${employeeName(employees, sheetExam.employeeId)}, ${onShift(sheetExam)}.`
                : 'Nobody has examined this area yet today.'}
              {` The sheet has ${sheet.rows.length} ${sheet.rows.length === 1 ? 'line' : 'lines'} of its own and the 20 conditions.`}
            </Txt>

            {sheetOpen.some((f) => f.danger) ? (
              <View testID="area-danger">
                <Notice tone="bo" icon={Siren} title="A danger is open here" body="People stay out of the area until it is fixed. Check with your supervisor before you go in." />
              </View>
            ) : null}

            {sheetOpen.length > 0 ? (
              <View style={styles.openBox}>
                <Txt v="smallStrong" c={color.red} style={{ paddingHorizontal: space.lg }}>
                  {sheetOpen.length === 1 ? 'Still open in this area' : `${sheetOpen.length} still open in this area`}
                </Txt>
                {/* Every one of them, a danger first, so the count above is the number of rows under it. */}
                {sheetOpen.map((f) => (
                  <Row
                    key={`${f.examId}-${f.key}`}
                    testID={`open-${f.key}`}
                    title={f.label}
                    sub={foundLine(f.note ?? f.where, fmtRelativeDay(f.foundAt, now).toLowerCase())}
                    below={f.danger ? <Tag label="Danger" tone="bo" solid icon={Siren} /> : f.mrfId ? <Tag label="With maintenance" tone="bo" /> : undefined}
                    chevron
                    onPress={() => go(() => navigation.navigate('AreaExamDetail', { examId: f.examId }))}
                  />
                ))}
              </View>
            ) : null}

            <Button testID="start-exam" label="Start pre shift exam" kind="yellow" onPress={() => go(() => navigation.navigate('AreaExam', { sheetId: sheet.id }))} />
            {sheetExam ? (
              <Button testID="see-exam" label="See today's exam" kind="outline" onPress={() => go(() => navigation.navigate('AreaExamDetail', { examId: sheetExam.id }))} />
            ) : null}
            <Button
              testID="area-new-mrf"
              label="Send a maintenance request"
              icon={Wrench}
              kind="quiet"
              onPress={() => go(() => navigation.navigate('MrfForm', { location: sheet.title }))}
            />
          </>
        ) : null}
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  intro: { gap: space.sm },
  areaIcon: {
    width: 48,
    height: 48,
    borderRadius: radius.sm,
    backgroundColor: color.grayTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  openBox: { borderRadius: radius.md, backgroundColor: color.redTint, paddingTop: space.md, overflow: 'hidden' },
});
