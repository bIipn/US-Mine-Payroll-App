import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { CARD_COLUMNS, type CardColumn, type DailyCard } from '../domain/checklistCard';
import { ANSWER_LEGEND, ANSWER_MARK, checklistFor, FUEL_LINE } from '../domain/templates';
import type { Answer } from '../domain/types';
import { haptic } from '../services/haptics';
import { color, font, space } from '../theme/theme';
import { fmtDate, fmtHrs, fmtMeter } from '../util/format';
import { Box, GridRow, Mark, PaperLine, PaperRow, PaperSheet, printed, RULE, written } from './Paper';

const MARK_W = 42;
const NUM_W = 30;
const HRS_W = 86;

/**
 * A day's Operator Equipment Checklist, laid out as the paper card is: the
 * equipment with its hours at the top, then a numbered column for each unit
 * against the 21 lines, the comments, and the legend.
 */
export function ChecklistCard({ card, name, hoursWorked, stillWorking, onOpen }: {
  card: DailyCard;
  name: string;
  /** "Total daily hours worked", in hundredths, from the time clock. */
  hoursWorked: number;
  /** The person is still on the clock, so the total is the hours so far. */
  stillWorking?: boolean;
  /** Open one unit's record. */
  onOpen?: (inspectionId: string) => void;
}) {
  const slots: (CardColumn | undefined)[] = Array.from({ length: CARD_COLUMNS }, (_, i) => card.columns[i]);
  // The lines read the same on every machine.
  const lines = checklistFor('loader').items;

  return (
    <PaperSheet title="Operator equipment checklist" testID="checklist-card">
      <PaperRow>
        <PaperLine label="Employee:" value={name} flex={1.6} testID="card-employee" />
        <PaperLine label="Date:" value={fmtDate(card.day)} testID="card-date" />
      </PaperRow>

      <GridRow head style={{ marginTop: space.md }}>
        <Box width={NUM_W} first><Text style={printed}>#</Text></Box>
        <Box><Text style={printed}>Equipment</Text></Box>
        <Box width={HRS_W}><Text style={[printed, styles.center]}>Equp. hrs st</Text></Box>
        <Box width={HRS_W}><Text style={[printed, styles.center]}>Equp. hrs. end</Text></Box>
      </GridRow>
      {slots.map((column, i) => {
        const result = column?.inspection.result;
        const body = (
          <>
            <Box width={NUM_W} first><Text style={printed}>{i + 1}</Text></Box>
            <Box style={styles.unitBox}>
              {column ? (
                <>
                  <Text style={styles.unit} numberOfLines={1}>
                    {column.unit?.unit ?? 'Removed'}
                    <Text style={styles.unitModel}>{column.unit ? `  ${column.unit.make} ${column.unit.model}` : ''}</Text>
                  </Text>
                  {result === 'bad_order' ? <Text style={[styles.status, { color: color.red }]}>Bad order, red tagged</Text> : null}
                  {result === 'defect' ? <Text style={[styles.status, { color: color.amber }]}>Defect reported</Text> : null}
                </>
              ) : null}
            </Box>
            <Box width={HRS_W}>{column ? <Text style={styles.hours}>{fmtMeter(column.hoursStart)}</Text> : null}</Box>
            <Box width={HRS_W}>{column?.hoursEnd != null ? <Text style={styles.hours}>{fmtMeter(column.hoursEnd)}</Text> : null}</Box>
          </>
        );
        if (!column || !onOpen) return <GridRow key={i} style={styles.unitRow}>{body}</GridRow>;
        return (
          <Pressable
            key={i}
            testID={`card-unit-${i + 1}`}
            accessibilityRole="button"
            accessibilityLabel={`Open the record for ${column.unit?.unit ?? 'this unit'}`}
            onPress={() => {
              haptic.tap();
              onOpen(column.inspection.id);
            }}
            style={({ pressed }) => [styles.gridRow, styles.unitRow, pressed && { backgroundColor: color.kaolin }]}
          >
            {body}
          </Pressable>
        );
      })}

      <GridRow style={styles.totalRow}>
        <Box first style={{ alignItems: 'flex-end' }}>
          <Text style={printed}>{'<>'} Total daily hours worked {'<>'}</Text>
          {stillWorking ? <Text style={styles.soFar}>So far today. Still on the clock.</Text> : null}
        </Box>
        <Box width={HRS_W}>
          <Text testID="card-hours-worked" style={styles.total}>{hoursWorked > 0 ? fmtHrs(hoursWorked) : ''}</Text>
        </Box>
      </GridRow>

      <GridRow head>
        {slots.map((_, i) => (
          <Box key={i} width={MARK_W} first={i === 0}><Text style={printed}>{i + 1}</Text></Box>
        ))}
        <Box style={styles.lineBox}><Text style={printed}>Check list items</Text></Box>
      </GridRow>
      {lines.map((line) => (
        <GridRow key={line.id}>
          {slots.map((column, i) => {
            const answer = column?.inspection.answers.find((a) => a.itemId === line.id)?.answer;
            const gallons = line.id === FUEL_LINE ? column?.fuelGal : undefined;
            return (
              <Box key={i} width={MARK_W} first={i === 0} style={styles.markBox}>
                <View
                  testID={column ? `card-${i + 1}-${line.id}` : undefined}
                  accessibilityLabel={column && answer ? `Unit ${i + 1}, ${line.label}: ${SAY[answer]}` : undefined}
                  style={styles.center}
                >
                  <Mark answer={answer} />
                  {gallons != null ? <Text style={styles.gallons}>{fmtGal(gallons)}</Text> : null}
                </View>
              </Box>
            );
          })}
          <Box style={styles.lineBox}>
            <Text style={[printed, styles.lineLabel]}>{line.id === FUEL_LINE ? 'Fuel    gallons added:' : breakable(line.label)}</Text>
          </Box>
        </GridRow>
      ))}

      <View style={styles.comments}>
        <Text style={printed}>Comments:</Text>
        {card.comments.length === 0 ? <View style={{ height: 22 }} /> : null}
        {card.comments.map((comment, i) => (
          <View key={i} style={styles.comment}>
            <Text style={styles.commentNo}>{comment.n}</Text>
            <Text style={[written, { flex: 1 }]}>{comment.text}</Text>
          </View>
        ))}
      </View>

      <View style={styles.legend}>
        {(['ok', 'bo', 'na'] as Answer[]).map((answer) => (
          <Text key={answer} style={styles.legendLine}>
            <Text style={{ fontFamily: font.bodyBold }}>{ANSWER_MARK[answer]}</Text> = {ANSWER_LEGEND[answer]}
          </Text>
        ))}
      </View>
    </PaperSheet>
  );
}

const SAY: Record<Answer, string> = { ok: 'OK', bo: 'Bad order', na: 'Not applicable' };

/** Lets a long line name, such as "Batteries/secure/corrosion", wrap after a slash on a narrow phone. */
const breakable = (label: string) => label.replace(/\//g, '/​');

/** 18 or 12.5, with no trailing zero. */
const fmtGal = (gallons: number) => `${Math.round(gallons * 10) / 10} gal`;

const styles = StyleSheet.create({
  center: { alignItems: 'center', textAlign: 'center' },
  gridRow: { flexDirection: 'row', alignItems: 'stretch', borderTopWidth: 1, borderTopColor: RULE },
  unitRow: { minHeight: 46 },
  unitBox: { alignItems: 'flex-start', paddingHorizontal: space.sm },
  unit: { fontFamily: font.condBold, fontSize: 20, lineHeight: 23, color: color.ink },
  unitModel: { fontFamily: font.body, fontSize: 13, color: color.silica },
  status: { fontFamily: font.bodySemi, fontSize: 12, lineHeight: 15 },
  hours: { fontFamily: font.cond, fontSize: 18, lineHeight: 21, color: color.ink, fontVariant: ['tabular-nums'] },
  totalRow: { minHeight: 44, borderTopWidth: 1.5, borderTopColor: color.ink },
  total: { fontFamily: font.condBold, fontSize: 24, lineHeight: 27, color: color.ink, fontVariant: ['tabular-nums'] },
  soFar: { fontFamily: font.body, fontSize: 12, lineHeight: 15, color: color.silica },
  markBox: { paddingHorizontal: 0, minHeight: 30 },
  lineBox: { alignItems: 'flex-start', paddingHorizontal: space.sm },
  // Takes the width of its box, so a long name wraps instead of running off the card.
  lineLabel: { alignSelf: 'stretch' },
  gallons: { fontFamily: font.bodySemi, fontSize: 10.5, lineHeight: 13, color: color.inkSoft },
  comments: {
    gap: 4,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderTopWidth: 1.5,
    borderTopColor: color.ink,
  },
  comment: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
  commentNo: {
    width: 20,
    textAlign: 'center',
    fontFamily: font.condBold,
    fontSize: 15,
    lineHeight: 20,
    color: color.white,
    backgroundColor: color.ink,
    borderRadius: 3,
    overflow: 'hidden',
  },
  legend: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: 1,
    borderTopWidth: 1,
    borderTopColor: RULE,
    backgroundColor: color.kaolin,
  },
  legendLine: { fontFamily: font.body, fontSize: 12.5, lineHeight: 17, color: color.inkSoft, textAlign: 'center' },
});
