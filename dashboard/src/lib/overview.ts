import { openFindings, type Finding } from '@app/domain/areaExam';
import { checklistSignedOn, findItem, isHazard, onTheCard } from '@app/domain/templates';
import type { AreaExam, Equipment, Inspection, InspectionAnswer, Mrf, MrfPriority } from '@app/domain/types';
import { addDays, DAY, startOfDay } from '@app/util/format';

import type { Shaped } from './records';

/**
 * What is open across the company, and what came in today: the board a
 * supervisor reads first. A danger comes ahead of anything else that is open.
 */

export interface OpenBadOrder {
  key: string;
  inspection: Inspection;
  answer: InspectionAnswer;
  /** The line of the card, or "Earlier checklist" for one made before the card. */
  label: string;
  unit?: Equipment;
  mrf?: Mrf;
  /** A safety item, or one the operator marked unsafe: the unit is red tagged. */
  hazard: boolean;
}

/**
 * Each Bad Order on an equipment checklist that is not corrected yet: its
 * maintenance request is not completed, or it was never sent on one. The same
 * rule as the PDF for an inspector, so the two always agree.
 */
export function openBadOrders(data: Pick<Shaped['data'], 'inspections' | 'equipment' | 'mrfs'>): OpenBadOrder[] {
  const unitOf = new Map(data.equipment.map((e) => [e.id, e]));
  const mrfOf = new Map(data.mrfs.map((m) => [m.id, m]));
  return data.inspections
    .flatMap((inspection) => {
      const mrf = inspection.mrfId ? mrfOf.get(inspection.mrfId) : undefined;
      if (mrf?.status === 'completed' && mrf.completedAt != null) return [];
      const unit = unitOf.get(inspection.equipmentId);
      const template = checklistSignedOn(inspection, unit);
      const earlier = !onTheCard(inspection);
      return inspection.answers
        .filter((a) => a.answer === 'bo')
        .map((answer): OpenBadOrder => ({
          key: `${inspection.id}:${answer.itemId}`,
          inspection,
          answer,
          label: earlier ? 'Earlier checklist' : (findItem(template, answer.itemId)?.label ?? answer.itemId),
          unit,
          mrf,
          hazard: earlier ? inspection.result === 'bad_order' : isHazard(template, answer),
        }));
    })
    .sort((a, b) => Number(b.hazard) - Number(a.hazard) || b.inspection.submittedAt - a.inspection.submittedAt);
}

const PRIORITY_ORDER: Record<MrfPriority, number> = { safety: 0, high: 1, routine: 2 };

/** Requests not completed: safety first, then high, then routine, oldest first within each. */
export function openRequests(mrfs: Mrf[]): Mrf[] {
  return mrfs
    .filter((m) => m.status !== 'completed')
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt - b.createdAt);
}

/**
 * Units with a red tag on them now, and units with a defect reported that still run.
 *
 * On a phone a unit's status follows its own open requests (statusFromMrfs in the
 * app's store): an open request that red tagged it keeps it out of service, any
 * other open request marks a defect. On the server each unit is whichever copy a
 * phone sent last, and a phone that never heard of the red tag sends its copy as
 * ready. So here the unit is red tagged when its stored status says so or when an
 * open red-tag request names it, and the same for a defect: a red tag is never
 * dropped because another phone's copy of the unit is older.
 */
export function unitsDown(equipment: Equipment[], mrfs: Mrf[] = []): { redTagged: Equipment[]; defect: Equipment[] } {
  const byUnit = (a: Equipment, b: Equipment) => a.unit.localeCompare(b.unit, undefined, { numeric: true });
  const open = mrfs.filter((m) => m.status !== 'completed' && m.equipmentId);
  const tagged = new Set(open.filter((m) => m.taggedOut).map((m) => m.equipmentId));
  const asked = new Set(open.map((m) => m.equipmentId));
  const isTagged = (e: Equipment) => e.status === 'out_of_service' || tagged.has(e.id);
  return {
    redTagged: equipment.filter(isTagged).sort(byUnit),
    defect: equipment.filter((e) => !isTagged(e) && (e.status === 'defect' || asked.has(e.id))).sort(byUnit),
  };
}

export interface RedTagSource {
  /** When the tag went on, as far as the records say. */
  at?: number;
  /** The equipment checklist that put it on, when there is one. */
  inspectionId?: string;
  /** The open request that keeps it on. */
  mrfId?: string;
}

/**
 * What keeps a red tag on a unit: its newest open red-tag request, with the
 * checklist it came from when it came from one; or, with no such request, the
 * newest Bad Order checklist on the unit that is not corrected yet. A checklist
 * whose request was completed took its tag off with it, so it is never the one.
 */
export function redTagSource(unit: Equipment, data: Pick<Shaped['data'], 'inspections' | 'mrfs'>): RedTagSource {
  const request = data.mrfs
    .filter((m) => m.equipmentId === unit.id && m.taggedOut && m.status !== 'completed')
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (request) {
    const from = request.inspectionId ? data.inspections.find((i) => i.id === request.inspectionId) : undefined;
    return { at: request.createdAt, mrfId: request.id, ...(from ? { inspectionId: from.id } : null) };
  }
  const mrfOf = new Map(data.mrfs.map((m) => [m.id, m]));
  const check = data.inspections
    .filter((i) => i.equipmentId === unit.id && i.result === 'bad_order' && (!i.mrfId || mrfOf.get(i.mrfId)?.status !== 'completed'))
    .sort((a, b) => b.submittedAt - a.submittedAt)[0];
  return check ? { at: check.submittedAt, inspectionId: check.id, ...(check.mrfId ? { mrfId: check.mrfId } : null) } : {};
}

/**
 * Request numbers given to more than one request. Each phone numbers its own
 * requests from its own count, so two phones can give out the same number.
 */
export function repeatedNumbers(mrfs: Mrf[]): Map<number, Mrf[]> {
  const byNumber = new Map<number, Mrf[]>();
  for (const m of mrfs) byNumber.set(m.number, [...(byNumber.get(m.number) ?? []), m]);
  return new Map([...byNumber].filter(([, list]) => list.length > 1).sort((a, b) => a[0] - b[0]));
}

/**
 * Days between two moments, to a tenth, as the safety log's "Days open" column
 * counts them, so the pages and the workbook give the same figure.
 */
export function daysOpen(from: number, to: number): number {
  return Math.max(0, Math.round(((to - from) / DAY) * 10) / 10);
}

export const fmtDays = (days: number) => days.toFixed(1);

export interface Board {
  badOrders: OpenBadOrder[];
  redTagged: Equipment[];
  defect: Equipment[];
  /** Conditions from pre shift exams with no date fixed: any danger first. */
  conditions: Finding[];
  dangers: Finding[];
  requests: Mrf[];
  today: { inspections: Inspection[]; exams: AreaExam[] };
}

export function board(shaped: Pick<Shaped, 'data'>, now: number): Board {
  const { data } = shaped;
  const from = startOfDay(now);
  const to = addDays(from, 1);
  const conditions = openFindings(data.exams);
  return {
    badOrders: openBadOrders(data),
    ...unitsDown(data.equipment, data.mrfs),
    conditions,
    dangers: conditions.filter((f) => f.danger),
    requests: openRequests(data.mrfs),
    today: {
      inspections: data.inspections.filter((i) => i.submittedAt >= from && i.submittedAt < to).sort((a, b) => b.submittedAt - a.submittedAt),
      exams: data.exams.filter((x) => x.submittedAt >= from && x.submittedAt < to).sort((a, b) => b.submittedAt - a.submittedAt),
    },
  };
}

/** The days that have any checklist or exam, newest first, with how many of each. */
export function recordDays(data: Pick<Shaped['data'], 'inspections' | 'exams'>): { day: number; checklists: number; exams: number }[] {
  const days = new Map<number, { day: number; checklists: number; exams: number }>();
  const at = (t: number) => {
    const day = startOfDay(t);
    let entry = days.get(day);
    if (!entry) days.set(day, (entry = { day, checklists: 0, exams: 0 }));
    return entry;
  };
  for (const i of data.inspections) at(i.submittedAt).checklists += 1;
  for (const x of data.exams) at(x.submittedAt).exams += 1;
  return [...days.values()].sort((a, b) => b.day - a.day);
}
