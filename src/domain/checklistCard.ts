import { checklistFor, findItem } from './templates';
import { shiftTotals } from './time';
import type { Equipment, Inspection, OperatingLog, Shift } from './types';
import { addDays, startOfDay } from '../util/format';

/**
 * A person's Operator Equipment Checklist for one day, laid out as the paper
 * card is: one numbered column for each piece of equipment they checked, with
 * its hours at the start and the end.
 */

/** The paper card has room for four pieces of equipment. */
export const CARD_COLUMNS = 4;

export interface CardColumn {
  /** The column's number on the card, 1 to 4. */
  n: number;
  inspection: Inspection;
  /** Missing when the unit has since been removed from the fleet. */
  unit?: Equipment;
  hoursStart: number;
  hoursEnd?: number;
  /** Gallons added, at the check and at the end of use together. */
  fuelGal?: number;
}

export interface DailyCard {
  employeeId: string;
  /** The start of the day the card is for. */
  day: number;
  columns: CardColumn[];
  /** The comments box: what was wrong on each Bad Order, then anything else written down. */
  comments: { n: number; text: string }[];
}

export interface CardData {
  inspections: Inspection[];
  opLogs: OperatingLog[];
  equipment: Equipment[];
}

function buildCards(data: CardData, employeeId: string, day: number, checks: Inspection[]): DailyCard[] {
  const unitOf = new Map(data.equipment.map((e) => [e.id, e]));
  const logOf = new Map(data.opLogs.map((l) => [l.inspectionId, l]));
  const cards: DailyCard[] = [];
  const inOrder = [...checks].sort((a, b) => a.submittedAt - b.submittedAt);

  for (let i = 0; i < inOrder.length; i += CARD_COLUMNS) {
    const card: DailyCard = { employeeId, day, columns: [], comments: [] };
    inOrder.slice(i, i + CARD_COLUMNS).forEach((inspection, index) => {
      const n = index + 1;
      const unit = unitOf.get(inspection.equipmentId);
      const log = logOf.get(inspection.id);
      const gallons = (inspection.fuelGal ?? 0) + (log?.fuelGal ?? 0);
      card.columns.push({
        n,
        inspection,
        unit,
        hoursStart: inspection.meter,
        hoursEnd: log?.endMeter,
        fuelGal: inspection.fuelGal == null && log?.fuelGal == null ? undefined : gallons,
      });

      // The lines read the same on every machine, so any checklist can name them.
      const checklist = checklistFor(unit?.category ?? 'loader');
      for (const answer of inspection.answers) {
        if (answer.answer !== 'bo' || !answer.note) continue;
        card.comments.push({ n, text: `${findItem(checklist, answer.itemId)?.label ?? answer.itemId}: ${answer.note}` });
      }
      for (const text of [inspection.comments, log?.notes]) if (text) card.comments.push({ n, text });
    });
    cards.push(card);
  }
  return cards;
}

/** The card, or cards, for one person on one day. `day` is any moment on that day. */
export function dailyCards(data: CardData, employeeId: string, day: number): DailyCard[] {
  const start = startOfDay(day);
  const end = addDays(start, 1);
  const checks = data.inspections.filter(
    (i) => i.employeeId === employeeId && i.submittedAt >= start && i.submittedAt < end,
  );
  return buildCards(data, employeeId, start, checks);
}

/** Everyone's cards from `from` up to, not including, `to`. The newest come first. */
export function cardsBetween(data: CardData, from: number, to: number): DailyCard[] {
  const groups = new Map<string, { employeeId: string; day: number; checks: Inspection[] }>();
  for (const inspection of data.inspections) {
    if (inspection.submittedAt < from || inspection.submittedAt >= to) continue;
    const day = startOfDay(inspection.submittedAt);
    const key = `${inspection.employeeId}|${day}`;
    const group = groups.get(key) ?? { employeeId: inspection.employeeId, day, checks: [] };
    group.checks.push(inspection);
    groups.set(key, group);
  }
  return [...groups.values()]
    .flatMap((group) => buildCards(data, group.employeeId, group.day, group.checks))
    .sort((a, b) => b.columns[0].inspection.submittedAt - a.columns[0].inspection.submittedAt);
}

/**
 * "Total daily hours worked" on the card: the person's paid hours from the time
 * clock for that day, in hundredths. A shift still open counts up to `now`.
 */
export function dayHoursWorked(shifts: Shift[], employeeId: string, day: number, now: number): number {
  const start = startOfDay(day);
  const end = addDays(start, 1);
  return shifts
    .filter((s) => s.employeeId === employeeId && s.clockIn.at >= start && s.clockIn.at < end)
    .reduce((sum, s) => sum + shiftTotals(s, now).paid, 0);
}
