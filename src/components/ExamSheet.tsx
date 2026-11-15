import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AREA_CONDITIONS, EXAM_COLUMNS, shiftLabel } from '../domain/areaExam';
import type { AreaExam, ExamCondition, ExamRow } from '../domain/types';
import { color, font, space } from '../theme/theme';
import { fmtDate, fmtDateTime } from '../util/format';
import { Box, GridRow, Mark, PaperLine, PaperRow, PaperSheet, printed } from './Paper';

const COL_W = 58;

/**
 * A Pre Shift Exam laid out as the paper sheet is: the area's lines against
 * Guarding, Electrical and Safe access, then the conditions page with OK and
 * Bad Order. What the paper puts in its "Notes / Date fixed" column is written
 * under the line it belongs to.
 */
export function ExamSheet({ exam, examiner, nameOf, mrfNumber }: {
  exam: AreaExam;
  examiner: string;
  /** A person's name from their id, for "fixed by". */
  nameOf: (employeeId: string) => string;
  /** The number of the maintenance request a line was sent on. */
  mrfNumber: (mrfId: string) => number | undefined;
}) {
  const shift = shiftLabel(exam.shift);
  const conditionOf = new Map(AREA_CONDITIONS.map((c) => [c.id, c]));

  const notes = (line: ExamRow | ExamCondition) => {
    const number = line.mrfId ? mrfNumber(line.mrfId) : undefined;
    if (!line.note && !line.fixed && number == null) return null;
    return (
      <View style={styles.notes}>
        {/* The heading of the paper's last column. There is no room for a column, so it sits over what was written. */}
        <Text style={styles.notesHead}>Notes / Date fixed</Text>
        {line.note ? <Text style={[styles.note, !line.fixed && { color: color.red }]}>{line.note}</Text> : null}
        {line.danger ? <Text style={[styles.note, { color: color.red, fontFamily: font.bodyBold }]}>Marked as a danger. People kept out.</Text> : null}
        {number != null ? <Text style={styles.noteSmall}>Maintenance request #{number}</Text> : null}
        {line.fixed ? (
          <Text style={[styles.note, { color: color.green }]}>
            Fixed {fmtDateTime(line.fixed.at)} by {nameOf(line.fixed.by)}{line.fixed.note ? `: ${line.fixed.note}` : ''}
          </Text>
        ) : null}
      </View>
    );
  };

  return (
    <View style={{ gap: space.lg }}>
      <PaperSheet title={`${exam.area} pre shift exam`} testID="exam-sheet">
        <PaperRow><PaperLine label="Employee:" value={examiner} testID="exam-employee" /></PaperRow>
        <PaperRow><PaperLine label="Date+shift:" value={`${fmtDate(exam.submittedAt)}, ${shift}`} testID="exam-date" /></PaperRow>

        <GridRow head style={{ marginTop: space.md }}>
          <Box first style={styles.labelBox}><Text style={printed}>{exam.area} areas:</Text></Box>
          {EXAM_COLUMNS.map((column) => (
            <Box key={column.id} width={COL_W}><Text style={styles.colHead}>{column.label}</Text></Box>
          ))}
        </GridRow>
        {exam.rows.length === 0 ? (
          <GridRow><Box first style={styles.labelBox}><Text style={styles.lineText}>No lines on this area's sheet.</Text></Box></GridRow>
        ) : null}
        {exam.rows.map((row) => (
          <View key={row.id} testID={`sheet-row-${row.id}`} style={styles.block}>
            <View style={styles.cells}>
              <Box first style={styles.labelBox}>
                <Text style={styles.lineText}>
                  {row.other ? <Text style={styles.other}>Other (specify): </Text> : null}
                  {row.label}
                </Text>
              </Box>
              {EXAM_COLUMNS.map((column) => (
                <Box key={column.id} width={COL_W}><Mark answer={row[column.id]} /></Box>
              ))}
            </View>
            {notes(row)}
          </View>
        ))}
      </PaperSheet>

      <PaperSheet title="Conditions" testID="exam-conditions">
        <GridRow head style={{ borderTopWidth: 0 }}>
          <Box first style={styles.labelBox}><Text style={printed}> </Text></Box>
          <Box width={COL_W}><Text style={styles.colHead}>OK</Text></Box>
          <Box width={COL_W}><Text style={styles.colHead}>Bad order</Text></Box>
        </GridRow>
        {exam.conditions.map((line) => {
          const condition = conditionOf.get(line.id);
          return (
            <View key={line.id} testID={`sheet-cond-${line.id}`} style={styles.block}>
              <View style={styles.cells}>
                <Box first style={styles.labelBox}>
                  <Text style={styles.lineText}>
                    {condition?.label ?? line.id}
                    {condition?.detail ? <Text style={styles.detail}> ({condition.detail.charAt(0).toLowerCase() + condition.detail.slice(1)})</Text> : null}
                  </Text>
                </Box>
                {line.answer === 'na' ? (
                  <Box width={COL_W * 2}><Mark answer="na" /></Box>
                ) : (
                  <>
                    <Box width={COL_W}>{line.answer === 'ok' ? <Mark answer="ok" /> : null}</Box>
                    <Box width={COL_W}>{line.answer === 'bo' ? <Mark answer="bo" /> : null}</Box>
                  </>
                )}
              </View>
              {notes(line)}
            </View>
          );
        })}
      </PaperSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { borderTopWidth: 1, borderTopColor: color.silica },
  cells: { flexDirection: 'row', alignItems: 'stretch', minHeight: 34 },
  labelBox: { alignItems: 'flex-start', paddingHorizontal: space.sm },
  colHead: {
    fontFamily: font.cond,
    fontSize: 12,
    lineHeight: 14,
    letterSpacing: 0.2,
    textTransform: 'uppercase',
    textAlign: 'center',
    color: color.ink,
  },
  lineText: { fontFamily: font.cond, fontSize: 16, lineHeight: 19, color: color.ink },
  detail: { fontFamily: font.body, fontSize: 13, color: color.silica },
  other: { fontFamily: font.body, fontSize: 13, color: color.silica },
  notes: { gap: 2, paddingHorizontal: space.sm, paddingBottom: 6, paddingTop: 3, backgroundColor: color.kaolin },
  notesHead: { fontFamily: font.cond, fontSize: 11.5, lineHeight: 14, letterSpacing: 0.3, textTransform: 'uppercase', color: color.silica },
  note: { fontFamily: font.bodySemi, fontSize: 13.5, lineHeight: 18, color: color.ink },
  noteSmall: { fontFamily: font.body, fontSize: 12.5, lineHeight: 16, color: color.silica },
});
