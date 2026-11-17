import { cleanText } from './roster';
import type { Answer, AreaExam, AreaSheet, ExamColumn, ExamCondition, ExamFix, ExamRow, ShiftName } from './types';

/**
 * The Pre Shift Exam: the examination of a work area before work starts in it
 * on a shift (30 CFR 56.18002).
 *
 * The paper is two pages. The first lists the things in one area, each checked
 * for guarding, electrical and safe access. The second is the same for every
 * area: 20 conditions, each OK or Bad Order. Both have a column for notes and
 * the date a problem was fixed.
 *
 * The area sheets are the mine's own, so they are data: a build can name them,
 * and a supervisor can add or change them in the app.
 */

export interface ExamColumnInfo {
  id: ExamColumn;
  label: string;
  /** What to look for. */
  hint: string;
  /** Keys into the standards table. */
  refs: string[];
}

export const EXAM_COLUMNS: ExamColumnInfo[] = [
  { id: 'guarding', label: 'Guarding', hint: 'Guards in place and secure on belts, pulleys, shafts, couplings and fans.', refs: ['56.14107', '1910.212'] },
  { id: 'electrical', label: 'Electrical', hint: 'Boxes closed and covers on. Cords and conduit undamaged.', refs: ['56.12032', '56.12004'] },
  { id: 'access', label: 'Safe access', hint: 'A clear, stable way in and out. Steps, handrails and gates in place.', refs: ['56.11001'] },
];

export interface AreaCondition {
  id: string;
  label: string;
  /** The words in brackets on the paper: what OK looks like. */
  detail?: string;
  /** Keys into the standards table. */
  refs: string[];
}

/** The second page of every Pre Shift Exam, in the order it is printed. */
export const AREA_CONDITIONS: AreaCondition[] = [
  { id: 'ground', label: 'Ground conditions', detail: 'Stable footing, no trip hazards', refs: ['56.20003'] },
  { id: 'berms', label: 'Berms in place & maintained', refs: ['56.9300'] },
  { id: 'walkways', label: 'Walkways/travelways/catwalks', detail: 'Clear, safe access, stable', refs: ['56.11001'] },
  { id: 'handrails', label: 'Handrails, guardrails, toe boards', refs: ['56.11002'] },
  { id: 'ladders', label: 'Ladders and stairways', detail: 'Secure and undamaged', refs: ['56.11003'] },
  { id: 'pulleys', label: 'Conveyor head/tail pulleys', detail: 'Properly guarded', refs: ['56.14107', '1910.212'] },
  { id: 'belt_components', label: 'Belt conveyor components', detail: 'Rollers, skirts, spillage', refs: ['56.14100'] },
  { id: 'estops', label: 'Emergency stop devices', detail: 'Cords, switches', refs: ['56.14109'] },
  { id: 'mobile_equipment', label: 'Mobile equipment', detail: 'Implements down, chocked', refs: ['56.14206', '56.14207'] },
  { id: 'haul_roads', label: 'Haul roads', detail: 'Maintained, visibility, width', refs: ['56.9313', '56.9300'] },
  { id: 'lockout', label: 'Lockout/tagout equipment', detail: 'Available, clearly marked', refs: ['56.12016', '1910.147'] },
  { id: 'electrical', label: 'Electrical panels and cords', detail: 'Closed, covers on, undamaged cords', refs: ['56.12032', '56.12004'] },
  {
    id: 'fire_extinguishers',
    label: 'Fire extinguishers',
    detail: 'Charged, monthly punch tag + annual sticker current, accessible',
    refs: ['56.4201', '1910.157(e)(2)'],
  },
  { id: 'first_aid', label: 'First aid kit', detail: 'Stocked, in date, accessible', refs: ['56.15001'] },
  // No standard is cited for dust control or respirators: 30 CFR 56.5005 was being revised when this list was written.
  { id: 'dust', label: 'Dust suppression/control measures', detail: 'In place + functioning as required', refs: [] },
  { id: 'noise', label: 'Noise hazards', detail: 'Signage posted, hearing protection enforced', refs: ['62.160'] },
  { id: 'respiratory', label: 'Respiratory protection', detail: 'Signage posted, respirator use enforced', refs: [] },
  { id: 'barricades', label: 'Barricades/warning signs', detail: 'In place where required', refs: ['56.20011'] },
  { id: 'lighting', label: 'Lighting', detail: 'Working and travel areas', refs: ['56.17001'] },
  { id: 'chemicals', label: 'Chemical storage / labeling / SDS access', refs: ['47.41'] },
];

/** The shifts, in the order they run. The paper leaves "Date+Shift" blank; these are what goes in it. */
export const SHIFTS: { id: ShiftName; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'swing', label: 'Swing' },
  { id: 'night', label: 'Night' },
];

/** A shift as it is written in the blank. One this version does not know is shown as it was saved. */
export function shiftLabel(shift: ShiftName): string {
  return SHIFTS.find((s) => s.id === shift)?.label ?? shift;
}

/** The hour of the day each shift's crew starts to come in. Nights run on past midnight, until the day crew's hour. */
const DAY_CREW_FROM = 3;
const SWING_CREW_FROM = 11;
const NIGHT_CREW_FROM = 17;

/**
 * The shift someone who clocked in at this time is on.
 *
 * The mine has not given its shift times, so the hours are wide enough to take an eight hour
 * pattern or a twelve hour one. It is a guess at a starting choice and nothing more: do not
 * decide from it that an exam is due or done.
 */
export function shiftAt(clockedInAt: number): ShiftName {
  const hour = new Date(clockedInAt).getHours();
  if (hour >= NIGHT_CREW_FROM || hour < DAY_CREW_FROM) return 'night';
  return hour >= SWING_CREW_FROM ? 'swing' : 'day';
}

/**
 * The shift an exam form starts on: the one the person clocked in for, however late in it they
 * make the exam. Off the clock there is only the time to go by. The person can change it.
 */
export function startingShift(clockedInAt: number | undefined, now: number): ShiftName {
  return shiftAt(clockedInAt ?? now);
}

// ---- Area sheets ---------------------------------------------------------------------------

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function unique(base: string, taken: Set<string>): string {
  let id = base || 'line';
  for (let n = 2; taken.has(id); n++) id = `${base || 'line'}_${n}`;
  taken.add(id);
  return id;
}

/** Typed after a sheet's name, this marks a sheet with one OK/BO column: "Core shed [OK/BO]". */
const SINGLE_MARK = /\[\s*ok\s*\/\s*bo\s*\]$/i;

/**
 * A sheet from its name and its lines, one to a line of text. The heading can be
 * typed the way it is printed: "North Plant areas:" and "North Plant Pre Shift
 * Exam" both give "North Plant". Without the colon "areas" is part of the name,
 * so "Staging areas" stays as it is.
 *
 * Most sheets check each line for guarding, electrical and safe access. One that
 * has a single OK/BO column instead is `single`: say so, or type [OK/BO] after
 * the name.
 */
export function makeSheet(title: string, rowsText: string, takenIds: string[] = [], single = false): AreaSheet | null {
  const typed = cleanText(title);
  const name = cleanText(
    cleanText(typed.replace(SINGLE_MARK, ''))
      .replace(/\s+areas\s*:$/i, '')
      .replace(/:$/, '')
      .replace(/\s+pre[\s-]?shift exam$/i, ''),
  );
  if (!name) return null;
  const rowIds = new Set<string>();
  const rows = rowsText
    .split(/\r?\n/)
    .map(cleanText)
    .filter(Boolean)
    .map((label) => ({ id: unique(slug(label), rowIds), label }));
  return {
    id: unique(slug(name), new Set(takenIds)),
    title: name,
    rows,
    active: true,
    ...(single || SINGLE_MARK.test(typed) ? { single: true } : null),
  };
}

/**
 * Sheets from pasted text: the name of an area, then one line for each line of
 * its sheet, with a blank line before the next area. Line ends can be Windows
 * ones, or `\n` typed out, which is what a setting holds when it is not in
 * double quotes.
 */
export function parseAreaSheets(text: string | undefined): AreaSheet[] {
  const sheets: AreaSheet[] = [];
  const plain = (text ?? '').replace(/\\n/g, '\n').replace(/\r\n?/g, '\n');
  for (const block of plain.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((line) => cleanText(line));
    if (lines.length === 0) continue;
    const sheet = makeSheet(lines[0], lines.slice(1).join('\n'), sheets.map((s) => s.id));
    if (sheet) sheets.push(sheet);
  }
  return sheets;
}

/**
 * The saved sheets, plus any sheet the build names that is not among them yet.
 * A sheet a supervisor removed is still there, switched off, so it stays removed.
 * Returns the same list when there is nothing to add.
 */
export function withSheets(existing: AreaSheet[], configured: AreaSheet[]): AreaSheet[] {
  const have = new Set(existing.map((s) => s.id));
  const missing = configured.filter((s) => !have.has(s.id));
  return missing.length ? [...existing, ...missing] : existing;
}

export type SheetResult = { ok: true; sheet: AreaSheet } | { ok: false; error: string };

const NO_AREA = 'Give the sheet the name of its work area.';

/**
 * A new sheet for the list, or why it cannot be added. Two sheets cannot have
 * the same name, whatever its capitals. Its id is a slug of its name, so the
 * same area typed on two phones, or on a phone and in the office, is one sheet.
 */
export function newSheet(sheets: readonly AreaSheet[], title: string, rowsText: string, single?: boolean): SheetResult {
  const sheet = makeSheet(title, rowsText, sheets.map((s) => s.id), single);
  if (!sheet) return { ok: false, error: NO_AREA };
  const same = sheets.find((s) => s.title.toLowerCase() === sheet.title.toLowerCase());
  if (same) return { ok: false, error: `There is already a sheet called ${same.title}.` };
  return { ok: true, sheet };
}

/**
 * A sheet with its name, its lines and its columns changed, or why it cannot
 * be. With nothing said about the columns (`single` left out) the sheet keeps
 * the ones it has. Its id, and whether it is in use, stay as they are. Exams
 * already signed keep the lines, and the columns, they were made on: a change
 * here is for the exams made from now on.
 */
export function changedSheet(sheets: readonly AreaSheet[], sheetId: string, title: string, rowsText: string, single?: boolean): SheetResult {
  const current = sheets.find((s) => s.id === sheetId);
  if (!current) return { ok: false, error: 'That area sheet is no longer on the list.' };
  const next = makeSheet(title, rowsText, [], single ?? !!current.single);
  if (!next) return { ok: false, error: NO_AREA };
  const same = sheets.find((s) => s.id !== sheetId && s.title.toLowerCase() === next.title.toLowerCase());
  if (same) return { ok: false, error: `There is already a sheet called ${same.title}.` };
  const { single: _was, ...kept } = current;
  return { ok: true, sheet: { ...kept, title: next.title, rows: next.rows, ...(next.single ? { single: true } : null) } };
}

/** A sheet put on the list the crew picks from, or taken off it. Its exams stay on record either way. */
export function sheetInUse(sheet: AreaSheet, active: boolean): AreaSheet {
  return { ...sheet, active };
}

/**
 * Made-up sheets for the sample data: a plant that is nothing like the mine's
 * own. The real sheets list the mine's equipment and are not in this
 * repository: a build names them (see `AREA_SHEETS` in src/config.ts) or a
 * supervisor adds them in the app. Do not model a sample on a real sheet; where
 * a build's sheets are on the machine, a test holds the two apart.
 */
export const SAMPLE_AREA_SHEETS: AreaSheet[] = parseAreaSheets(
  [
    'Crusher\nDump pocket\nGrizzly feeder\nJaw crusher\nRock breaker\nDischarge conveyor\nSurge bin\nControl booth\nLube unit\nDust collector',
    'Bagging plant\nFeed bin\nBag conveyor\nBulk bag filler\nPalletizer\nStretch wrapper\nBucket elevator\nBaghouse\nLoading dock\nForklift lane',
    // One of the samples has a single OK/BO column, as some of a mine's sheets do.
    'Core shed [OK/BO]\nCore saw\nCore splitter\nLogging benches\nCore racks\nSample store\nRoller door\nEyewash station',
  ].join('\n\n'),
);

// ---- Filling in an exam ----------------------------------------------------------------------

/** How a line was marked: one answer, and for a Bad Order which columns are wrong. */
export interface RowMark {
  answer: Answer;
  columns?: ExamColumn[];
  note?: string;
  danger?: boolean;
}

export interface ConditionMark {
  answer: Answer;
  note?: string;
  danger?: boolean;
}

/**
 * What was written beside a mark. It goes on the record only with a Bad Order:
 * a note typed on a line that was then changed back to OK has been withdrawn,
 * and the form no longer shows it to the person signing.
 */
const extras = (mark: { answer: Answer; note?: string; danger?: boolean }) =>
  mark.answer !== 'bo'
    ? null
    : {
        ...(mark.note && cleanText(mark.note) ? { note: cleanText(mark.note) } : null),
        ...(mark.danger ? { danger: true } : null),
      };

/**
 * One line of the area sheet. OK or N/A fills all three columns. A Bad Order
 * goes in the columns that are wrong, and the others are OK.
 */
export function examRow(line: { id: string; label: string; other?: boolean }, mark: RowMark): ExamRow {
  const wrong = mark.columns?.length ? mark.columns : EXAM_COLUMNS.map((c) => c.id);
  const cell = (column: ExamColumn): Answer => (mark.answer !== 'bo' ? mark.answer : wrong.includes(column) ? 'bo' : 'ok');
  return {
    id: line.id,
    label: line.label,
    ...(line.other ? { other: true } : null),
    guarding: cell('guarding'),
    electrical: cell('electrical'),
    access: cell('access'),
    ...extras(mark),
  };
}

/** A line as one answer: Bad Order if any column is, N/A if all of them are. */
export function rowAnswer(row: ExamRow): Answer {
  const cells = [row.guarding, row.electrical, row.access];
  if (cells.includes('bo')) return 'bo';
  return cells.every((c) => c === 'na') ? 'na' : 'ok';
}

export interface ExamDraft {
  sheetId: string;
  shift: ShiftName;
  startedAt: number;
  /** Marks for the printed lines, by line id. */
  rows: Record<string, RowMark>;
  /** Lines written in under "Other (specify)". */
  others: { label: string; mark: RowMark }[];
  conditions: Record<string, ConditionMark>;
}

export type BuiltExam = { ok: true; exam: AreaExam } | { ok: false; error: string };

const ANSWERS: Answer[] = ['ok', 'bo', 'na'];
/** A line has an answer once it is marked OK, BO or N/A. Anything else is still blank. */
const answered = (mark: { answer?: Answer } | undefined): boolean => !!mark && ANSWERS.includes(mark.answer as Answer);

/**
 * Turn a filled-in sheet into the record: who examined the area, when, where,
 * and every line with what was found. Nothing is signed with a line left blank
 * or a Bad Order that does not say what is wrong.
 */
export function buildExam(
  sheet: AreaSheet,
  draft: ExamDraft,
  who: { id: string; employeeId: string; submittedAt: number },
): BuiltExam {
  const blank =
    sheet.rows.filter((r) => !answered(draft.rows[r.id])).length +
    draft.others.filter((o) => !answered(o.mark)).length +
    AREA_CONDITIONS.filter((c) => !answered(draft.conditions[c.id])).length;
  if (blank > 0) return { ok: false, error: `${blank} ${blank === 1 ? 'line still needs' : 'lines still need'} an answer.` };
  if (draft.others.some((o) => !cleanText(o.label))) return { ok: false, error: 'Name each line you added under Other.' };

  const rowMarks = [...sheet.rows.map((r) => draft.rows[r.id]), ...draft.others.map((o) => o.mark)];
  const bad = [...rowMarks, ...AREA_CONDITIONS.map((c) => draft.conditions[c.id])].filter((m) => m.answer === 'bo');
  if (bad.some((m) => !m.note || !cleanText(m.note))) return { ok: false, error: 'Say what is wrong on each Bad Order.' };
  // A sheet with one OK/BO column has no column to pick.
  if (!sheet.single && rowMarks.some((m) => m.answer === 'bo' && !m.columns?.length)) {
    return { ok: false, error: 'On each Bad Order, pick what is wrong: guarding, electrical or safe access.' };
  }

  // A written-in line is other_1, other_2 and so on, stepping past any printed line with that id.
  const lineIds = new Set(sheet.rows.map((r) => r.id));
  return {
    ok: true,
    exam: {
      id: who.id,
      sheetId: sheet.id,
      area: sheet.title,
      employeeId: who.employeeId,
      shift: draft.shift,
      startedAt: draft.startedAt,
      submittedAt: who.submittedAt,
      ...(sheet.single ? { single: true } : null),
      // On a sheet with one column a mark names no columns, so its three cells all take the one answer.
      rows: [
        ...sheet.rows.map((r) => examRow(r, sheet.single ? { ...draft.rows[r.id], columns: [] } : draft.rows[r.id])),
        ...draft.others.map((o, i) =>
          examRow({ id: unique(`other_${i + 1}`, lineIds), label: cleanText(o.label), other: true }, sheet.single ? { ...o.mark, columns: [] } : o.mark),
        ),
      ],
      conditions: AREA_CONDITIONS.map((c): ExamCondition => {
        const mark = draft.conditions[c.id];
        return { id: c.id, answer: mark.answer, ...extras(mark) };
      }),
    },
  };
}

// ---- Reading an exam -------------------------------------------------------------------------

/** A Bad Order found on an exam: a condition that stays open until the date it was fixed is added. */
export interface Finding {
  /** `row:<id>` or `cond:<id>`: the line it is on. */
  key: string;
  examId: string;
  sheetId: string;
  area: string;
  employeeId: string;
  foundAt: number;
  label: string;
  /** The column or columns it is in, or "Conditions" for the second page. */
  where: string;
  note?: string;
  danger: boolean;
  fixed?: ExamFix;
  mrfId?: string;
  /** Keys into the standards table. */
  refs: string[];
}

const conditionOf = new Map(AREA_CONDITIONS.map((c) => [c.id, c]));

/** Where a Bad Order is, on a sheet with one OK/BO column: on the area's own sheet, as against the conditions page. */
export const ON_THE_SHEET = 'Area sheet';

export function examFindings(exam: AreaExam): Finding[] {
  const base = { examId: exam.id, sheetId: exam.sheetId, area: exam.area, employeeId: exam.employeeId, foundAt: exam.submittedAt };
  const tail = (line: ExamRow | ExamCondition) => ({
    note: line.note,
    danger: !!line.danger,
    ...(line.fixed ? { fixed: line.fixed } : null),
    ...(line.mrfId ? { mrfId: line.mrfId } : null),
  });
  const fromRows = exam.rows
    .filter((row) => rowAnswer(row) === 'bo')
    .map((row): Finding => {
      // A sheet with one OK/BO column has no column to name, and so no standard of a column to cite.
      const wrong = exam.single ? [] : EXAM_COLUMNS.filter((c) => row[c.id] === 'bo');
      const where = wrong.map((c) => c.label).join(', ');
      return {
        key: `row:${row.id}`,
        ...base,
        label: row.label,
        where: exam.single ? ON_THE_SHEET : where.charAt(0) + where.slice(1).toLowerCase(),
        ...tail(row),
        refs: wrong.flatMap((c) => c.refs),
      };
    });
  const fromConditions = exam.conditions
    .filter((c) => c.answer === 'bo')
    .map((c): Finding => ({
      key: `cond:${c.id}`,
      ...base,
      label: conditionOf.get(c.id)?.label ?? c.id,
      where: 'Conditions',
      ...tail(c),
      refs: conditionOf.get(c.id)?.refs ?? [],
    }));
  return [...fromRows, ...fromConditions];
}

/** Conditions that have no fix date yet: a danger first, then the newest. */
export function openFindings(exams: AreaExam[], sheetId?: string): Finding[] {
  return exams
    .filter((exam) => !sheetId || exam.sheetId === sheetId)
    .flatMap(examFindings)
    .filter((finding) => !finding.fixed)
    .sort((a, b) => Number(b.danger) - Number(a.danger) || b.foundAt - a.foundAt);
}

/** How many lines were OK, Bad Order and N/A. A line of the area sheet counts once. */
export function examCounts(exam: AreaExam): Record<Answer, number> & { lines: number } {
  const counts = { ok: 0, bo: 0, na: 0, lines: exam.rows.length + exam.conditions.length };
  for (const row of exam.rows) counts[rowAnswer(row)] += 1;
  for (const condition of exam.conditions) counts[condition.answer] += 1;
  return counts;
}

export type ExamResult = 'clear' | 'conditions' | 'danger';

/** What the examination found: nothing, conditions to correct, or a danger to keep people out of. */
export function examResult(exam: AreaExam): ExamResult {
  const found = examFindings(exam);
  if (found.length === 0) return 'clear';
  return found.some((f) => f.danger) ? 'danger' : 'conditions';
}

/** Change the one line a key names: `row:<id>` on the area sheet, `cond:<id>` on the conditions page. Any other key changes nothing. */
function onLine(exam: AreaExam, key: string, change: <T extends ExamRow | ExamCondition>(line: T) => T): AreaExam {
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (kind === 'row') {
    const rows = exam.rows.map((row) => (row.id === id ? change(row) : row));
    return rows.some((row, i) => row !== exam.rows[i]) ? { ...exam, rows } : exam;
  }
  if (kind !== 'cond') return exam;
  const conditions = exam.conditions.map((c) => (c.id === id ? change(c) : c));
  return conditions.some((c, i) => c !== exam.conditions[i]) ? { ...exam, conditions } : exam;
}

/**
 * Add the date a condition was corrected to the record. The first date stands:
 * a line that already has one comes back unchanged.
 */
export function withFix(exam: AreaExam, key: string, fix: ExamFix): AreaExam {
  return onLine(exam, key, (line) => (line.fixed ? line : { ...line, fixed: fix }));
}

/** Note the maintenance request a condition was sent on. */
export function withMrf(exam: AreaExam, key: string, mrfId: string): AreaExam {
  return onLine(exam, key, (line) => (line.mrfId === mrfId ? line : { ...line, mrfId }));
}
