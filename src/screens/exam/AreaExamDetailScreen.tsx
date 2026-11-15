import { ArrowLeft, CircleCheck, Siren, TriangleAlert, Wrench } from '../../components/icons';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { ExamSheet } from '../../components/ExamSheet';
import { StandardRefs, StepCard } from '../../components/Standards';
import { Button, Field, IconButton, Sheet, Tag, Txt } from '../../components/ui';
import { examCounts, examFindings, openFindings, shiftLabel, type Finding } from '../../domain/areaExam';
import { AREA_CONDITION_STEPS, AREA_DANGER_STEPS } from '../../domain/standards';
import type { ScreenProps } from '../../navigation/types';
import { haptic } from '../../services/haptics';
import { employeeName, useMe, useStore } from '../../store/useStore';
import { color, radius, space } from '../../theme/theme';
import { fmtDate, fmtDateTime, fmtTime } from '../../util/format';

/**
 * A signed Pre Shift Exam: what it found, what is still open, and the sheet as
 * it was filled in. Straight after signing it also says what to do next.
 */
export function AreaExamDetailScreen({ navigation, route }: ScreenProps<'AreaExamDetail'>) {
  const insets = useSafeAreaInsets();
  const me = useMe();
  const exams = useStore((s) => s.exams);
  const exam = exams.find((x) => x.id === route.params.examId);
  const employees = useStore((s) => s.employees);
  const mrfs = useStore((s) => s.mrfs);
  const { markFixed, showToast } = useStore.getState();

  const [fixing, setFixing] = useState<Finding | null>(null);
  const [note, setNote] = useState('');

  if (!exam || !me) return null;

  const fresh = !!route.params.fresh;
  const found = examFindings(exam);
  const open = found.filter((f) => !f.fixed);
  const danger = open.some((f) => f.danger);
  const counts = examCounts(exam);
  const examiner = employeeName(employees, exam.employeeId);
  const shift = shiftLabel(exam.shift).toLowerCase();
  const canFix = me.role === 'supervisor' || exam.employeeId === me.id;
  const mrfOf = (id?: string) => mrfs.find((m) => m.id === id);
  // The same line found again on another exam of this area is a record of its own: each keeps
  // its own date fixed, so nothing here closes it. The person is told it is there.
  const elsewhere = openFindings(exams, exam.sheetId).filter((f) => f.examId !== exam.id);
  const alsoOpen = (key: string) => elsewhere.filter((f) => f.key === key);

  const look =
    found.length === 0
      ? { bg: color.green, icon: CircleCheck, title: 'Work area clear', sub: `Nothing found in ${exam.area}.` }
      : open.length === 0
        ? { bg: color.green, icon: CircleCheck, title: 'Everything is fixed', sub: 'Each condition found on this exam has its date fixed.' }
        : danger
          ? { bg: color.red, icon: Siren, title: 'Danger found', sub: `Keep people out of ${exam.area} until it is fixed.` }
          : {
              bg: color.amber,
              icon: TriangleAlert,
              title: open.length === 1 ? 'One condition to fix' : `${open.length} conditions to fix`,
              sub: 'It stays open on this area until the date it was fixed is recorded.',
            };
  const Icon = look.icon;
  const steps = danger ? AREA_DANGER_STEPS : AREA_CONDITION_STEPS;

  const saveFix = () => {
    if (!fixing) return;
    const result = markFixed(exam.id, fixing.key, note);
    if (!result.ok) {
      haptic.error();
      showToast(result.error, 'bo');
      return;
    }
    haptic.success();
    const again = alsoOpen(fixing.key)[0];
    if (again) showToast(`${fixing.label} marked fixed here. It is still open on the exam of ${fmtDate(again.foundAt)}.`, 'warn');
    else showToast(`${fixing.label} marked fixed`);
    setFixing(null);
    setNote('');
  };

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <ScrollView testID="exam-detail" contentContainerStyle={{ paddingBottom: space.xxl + insets.bottom }}>
        <View style={[styles.field, { backgroundColor: look.bg, paddingTop: insets.top + space.sm }]}>
          {fresh ? null : (
            <View style={styles.back}>
              <IconButton icon={ArrowLeft} label="Back" onPress={navigation.goBack} tint={color.white} testID="back" />
            </View>
          )}
          <Icon color={color.white} size={44} strokeWidth={2.25} />
          <Txt v="h1" c={color.white} accessibilityRole="header" testID="exam-result">{look.title}</Txt>
          <Txt v="lead" c={color.white}>{look.sub}</Txt>
        </View>

        <View style={styles.body}>
          <View style={styles.card}>
            <Txt v="strong">{exam.area} pre shift exam</Txt>
            <Txt v="small" c={color.silica}>
              {examiner}, {fmtDate(exam.submittedAt)} at {fmtTime(exam.submittedAt)}, {shift} shift
            </Txt>
            <View style={styles.tags}>
              <Tag label={`${counts.ok} OK`} tone="ok" />
              <Tag label={`${counts.bo} Bad Order`} tone={counts.bo ? 'bo' : 'neutral'} solid={counts.bo > 0} />
              <Tag label={`${counts.na} N/A`} tone="neutral" />
            </View>
          </View>

          {found.length > 0 ? (
            <View style={styles.block}>
              <Txt v="h3">{found.length === 1 ? 'What was found' : `The ${found.length} things found`}</Txt>
              {found.map((f) => {
                const mrf = mrfOf(f.mrfId);
                return (
                  <View key={f.key} testID={`finding-${f.key}`} style={[styles.finding, f.fixed && { borderLeftColor: color.green }]}>
                    <View style={styles.findingHead}>
                      <Txt v="strong" style={{ flex: 1 }}>{f.label}</Txt>
                      {f.fixed ? <Tag label="Fixed" tone="ok" solid /> : f.danger ? <Tag label="Danger" tone="bo" solid icon={Siren} /> : <Tag label="Open" tone="bo" />}
                    </View>
                    <Txt v="small" c={color.silica}>{f.where}</Txt>
                    {f.note ? <Txt v="body" c={color.inkSoft}>{f.note}</Txt> : null}
                    <StandardRefs refs={f.refs} />
                    {f.fixed ? (
                      <Txt v="small" c={color.green}>
                        Fixed {fmtDateTime(f.fixed.at)} by {employeeName(employees, f.fixed.by)}{f.fixed.note ? `. ${f.fixed.note}` : ''}
                      </Txt>
                    ) : null}
                    {mrf ? (
                      <Button
                        testID={`finding-mrf-${f.key}`}
                        label={`See maintenance request #${mrf.number}`}
                        size="md"
                        kind="quiet"
                        onPress={() => navigation.navigate('MrfDetail', { mrfId: mrf.id })}
                      />
                    ) : null}
                    {!f.fixed && alsoOpen(f.key).length > 0 ? (
                      <View testID={`also-open-${f.key}`} style={{ gap: 6 }}>
                        <Txt v="small" c={color.red}>
                          Also found on this line on {fmtDate(alsoOpen(f.key)[0].foundAt)}
                          {alsoOpen(f.key).length > 1 ? `, and ${alsoOpen(f.key).length - 1} more` : ''}, and still open there. Each exam gets its own date fixed.
                        </Txt>
                        <Button
                          label="See that exam"
                          size="md"
                          kind="quiet"
                          onPress={() => navigation.push('AreaExamDetail', { examId: alsoOpen(f.key)[0].examId })}
                        />
                      </View>
                    ) : null}
                    {!f.fixed ? (
                      <View style={styles.actions}>
                        {!mrf ? (
                          <Button
                            testID={`send-${f.key}`}
                            label="Send to maintenance"
                            icon={Wrench}
                            size="md"
                            kind="ink"
                            onPress={() =>
                              navigation.navigate('MrfForm', { examId: exam.id, findingKey: f.key, location: `${exam.area}: ${f.label}` })
                            }
                          />
                        ) : null}
                        {canFix ? (
                          <Button
                            testID={`fix-${f.key}`}
                            label="Mark fixed"
                            size="md"
                            kind="green"
                            onPress={() => {
                              setNote('');
                              setFixing(f);
                            }}
                          />
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : null}

          {/* The steps are a sequence, so they are numbered. */}
          {fresh && open.length > 0 ? (
            <View style={styles.block}>
              <Txt v="h3">What to do now</Txt>
              {steps.map((step, i) => <StepCard key={step.title} step={step} n={i + 1} />)}
            </View>
          ) : null}

          {fresh ? <Button testID="exam-done" label="Done" kind="ink" size={open.length ? 'lg' : 'xl'} onPress={() => navigation.popToTop()} /> : null}

          <View style={styles.block}>
            <Txt v="h3">The sheet as it was signed</Txt>
            <ExamSheet
              exam={exam}
              examiner={examiner}
              nameOf={(id) => employeeName(employees, id)}
              mrfNumber={(id) => mrfOf(id)?.number}
            />
          </View>
        </View>
      </ScrollView>

      <Sheet testID="fix-sheet" visible={!!fixing} onClose={() => setFixing(null)} title="Mark it fixed">
        {fixing ? (
          <>
            <Txt v="strong">{fixing.label}</Txt>
            {fixing.note ? <Txt v="body" c={color.inkSoft}>{fixing.note}</Txt> : null}
            <Field
              testID="fix-note"
              label="What was done? (optional)"
              placeholder="Guard bolted back on, hose put away"
              value={note}
              onChangeText={setNote}
              multiline
            />
            <Txt v="small" c={color.silica}>Today's date goes on the exam as the date it was fixed, with your name.</Txt>
            <Button testID="fix-save" label="Record the fix" kind="green" onPress={saveFix} />
          </>
        ) : null}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.kaolin },
  field: { paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.sm },
  back: { marginLeft: -space.md, marginBottom: -space.sm },
  body: { paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.lg },
  card: {
    gap: 2,
    padding: space.lg,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.rule,
  },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
  block: { gap: space.md },
  finding: {
    gap: 6,
    padding: space.lg,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderLeftWidth: 6,
    borderLeftColor: color.red,
  },
  findingHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  actions: { gap: space.sm, marginTop: 4 },
});
