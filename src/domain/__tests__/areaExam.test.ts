import {
  AREA_CONDITIONS,
  buildExam,
  EXAM_COLUMNS,
  examCounts,
  examFindings,
  examResult,
  examRow,
  makeSheet,
  openFindings,
  parseAreaSheets,
  rowAnswer,
  SAMPLE_AREA_SHEETS,
  shiftAt,
  withFix,
  withMrf,
  withSheets,
  type ExamDraft,
} from '../areaExam';
import { STANDARDS } from '../standards';
import type { AreaExam, AreaSheet } from '../types';

const at = (h: number, m = 0, day = 13) => new Date(2026, 10, day, h, m).getTime();

// The second page of every Pre Shift Exam, top to bottom, as it is printed.
const PRINTED_CONDITIONS = [
  'Ground Conditions (stable footing, no trip hazards)',
  'Berms in Place & Maintained',
  'Walkways/Travelways/Catwalks (clear, safe access, stable)',
  'Handrails, Guardrails, Toe Boards',
  'Ladders and Stairways (secure and undamaged)',
  'Conveyor Head/Tail Pulleys (properly guarded)',
  'Belt Conveyor Components (rollers, skirts, spillage)',
  'Emergency Stop Devices (cords, switches)',
  'Mobile Equipment (implements down, chocked)',
  'Haul Roads (maintained, visibility, width)',
  'Lockout/Tagout Equipment (available, clearly marked)',
  'Electrical Panels and Cords (closed, covers on, undamaged cords)',
  'Fire Extinguishers (charged, monthly punch tag + annual sticker current, accessible)',
  'First Aid Kit (stocked, in date, accessible)',
  'Dust Suppression/Control Measures (in place + functioning as required)',
  'Noise Hazards (signage posted, hearing protection enforced)',
  'Respiratory Protection (signage posted, respirator use enforced)',
  'Barricades/Warning Signs (in place where required)',
  'Lighting (working and travel areas)',
  'Chemical Storage / Labeling / SDS access',
];

describe('the sheet itself', () => {
  it('has the three columns of the paper sheet', () => {
    expect(EXAM_COLUMNS.map((c) => c.label)).toEqual(['Guarding', 'Electrical', 'Safe access']);
  });

  it('has the 20 conditions of the second page, in its order', () => {
    const lines = AREA_CONDITIONS.map((c) => (c.detail ? `${c.label} (${c.detail})` : c.label).toLowerCase());
    expect(lines).toEqual(PRINTED_CONDITIONS.map((line) => line.toLowerCase()));
    expect(new Set(AREA_CONDITIONS.map((c) => c.id)).size).toBe(20);
  });

  it('only cites standards that are in the standards table', () => {
    const refs = [...EXAM_COLUMNS, ...AREA_CONDITIONS].flatMap((line) => line.refs);
    expect(refs.length).toBeGreaterThan(15);
    for (const key of refs) expect(STANDARDS[key]).toBeDefined();
    // The examination itself is 30 CFR 56.18002.
    expect(STANDARDS['56.18002'].agency).toBe('MSHA');
  });

  it('takes the shift from the time of day', () => {
    expect([shiftAt(at(6, 15)), shiftAt(at(15, 59)), shiftAt(at(18, 0)), shiftAt(at(2, 30))]).toEqual(['day', 'day', 'night', 'night']);
  });
});

describe('area sheets', () => {
  it('come with made-up samples that are ready to use', () => {
    expect(SAMPLE_AREA_SHEETS.length).toBe(3);
    expect(new Set(SAMPLE_AREA_SHEETS.map((s) => s.id)).size).toBe(3);
    for (const sheet of SAMPLE_AREA_SHEETS) {
      expect(sheet.active).toBe(true);
      expect(sheet.rows.length).toBeGreaterThanOrEqual(6);
      expect(new Set(sheet.rows.map((r) => r.id)).size).toBe(sheet.rows.length);
    }
  });

  it('are read from pasted text: a name, then one line for each line of the sheet', () => {
    const sheets = parseAreaSheets('  North Plant areas:  \nFeed hopper\n  Pump 12 \nVacuum pump\nVacuum pump\n\n\nLab\nScale\n');
    expect(sheets).toEqual([
      {
        id: 'north_plant',
        title: 'North Plant',
        active: true,
        rows: [
          { id: 'feed_hopper', label: 'Feed hopper' },
          { id: 'pump_12', label: 'Pump 12' },
          // The same thing can be on a sheet twice. Each line keeps its own answer.
          { id: 'vacuum_pump', label: 'Vacuum pump' },
          { id: 'vacuum_pump_2', label: 'Vacuum pump' },
        ],
      },
      { id: 'lab', title: 'Lab', active: true, rows: [{ id: 'scale', label: 'Scale' }] },
    ]);
  });

  it('read as nothing when a build names none', () => {
    expect(parseAreaSheets(undefined)).toEqual([]);
    expect(parseAreaSheets(' \n \n')).toEqual([]);
  });

  it('can be an area with no lines of its own yet, which still gets the conditions page', () => {
    expect(makeSheet('Clay side', '')).toEqual({ id: 'clay_side', title: 'Clay side', active: true, rows: [] });
  });

  it('need a name, and never share an id with a sheet that is already there', () => {
    expect(makeSheet('  ', 'Scale')).toBeNull();
    expect(makeSheet('Lab', 'Scale', ['lab', 'lab_2'])?.id).toBe('lab_3');
  });

  it("are added to a phone's saved sheets when a build names new ones, and never brought back once removed", () => {
    const lab: AreaSheet = { id: 'lab', title: 'Lab', active: false, rows: [] };
    const configured = parseAreaSheets('Lab\nScale\n\nWash plant\nSump pump');
    const merged = withSheets([lab], configured);
    expect(merged.map((s) => [s.id, s.active])).toEqual([['lab', false], ['wash_plant', true]]);
    // Nothing to add: the same list comes back, so nothing is saved again.
    expect(withSheets(merged, configured)).toBe(merged);
  });
});

describe('marking a line', () => {
  const line = { id: 'pump_12', label: 'Pump 12' };

  it('is one tap for OK or N/A, which fills all three columns', () => {
    expect(examRow(line, { answer: 'ok' })).toEqual({ ...line, guarding: 'ok', electrical: 'ok', access: 'ok' });
    expect(examRow(line, { answer: 'na' })).toEqual({ ...line, guarding: 'na', electrical: 'na', access: 'na' });
  });

  it('puts a Bad Order in the columns that are wrong and leaves the others OK', () => {
    const row = examRow(line, { answer: 'bo', columns: ['guarding', 'access'], note: ' Guard off, ladder loose ', danger: true });
    expect(row).toEqual({ ...line, guarding: 'bo', electrical: 'ok', access: 'bo', note: 'Guard off, ladder loose', danger: true });
    expect(rowAnswer(row)).toBe('bo');
  });

  it('reads back as the answer that was tapped', () => {
    expect(rowAnswer(examRow(line, { answer: 'ok' }))).toBe('ok');
    expect(rowAnswer(examRow(line, { answer: 'na' }))).toBe('na');
  });

  it('keeps the danger flag only on a Bad Order', () => {
    expect(examRow(line, { answer: 'ok', danger: true }).danger).toBeUndefined();
  });
});

describe('buildExam', () => {
  const sheet = makeSheet('Wash plant', 'Sump pump\nSpirals\nOperator room')!;
  const allOk = (): ExamDraft => ({
    sheetId: sheet.id,
    shift: 'day',
    startedAt: at(6, 10),
    rows: Object.fromEntries(sheet.rows.map((r) => [r.id, { answer: 'ok' as const }])),
    others: [],
    conditions: Object.fromEntries(AREA_CONDITIONS.map((c) => [c.id, { answer: 'ok' as const }])),
  });
  const who = { id: 'exam_1', employeeId: 'e1', submittedAt: at(6, 21) };
  const build = (change: (draft: ExamDraft) => void) => {
    const draft = allOk();
    change(draft);
    return buildExam(sheet, draft, who);
  };

  it('makes the record the standard asks for: who, when, where, and every line examined', () => {
    const result = build(() => {});
    expect(result).toMatchObject({
      ok: true,
      exam: { id: 'exam_1', sheetId: 'wash_plant', area: 'Wash plant', employeeId: 'e1', shift: 'day', startedAt: at(6, 10), submittedAt: at(6, 21) },
    });
    if (!result.ok) return;
    expect(result.exam.rows.map((r) => r.label)).toEqual(['Sump pump', 'Spirals', 'Operator room']);
    expect(result.exam.conditions.map((c) => c.id)).toEqual(AREA_CONDITIONS.map((c) => c.id));
    expect(examResult(result.exam)).toBe('clear');
    expect(examCounts(result.exam)).toEqual({ ok: 23, bo: 0, na: 0, lines: 23 });
  });

  it('will not sign off with a line unanswered', () => {
    expect(build((d) => { delete d.rows.spirals; })).toEqual({ ok: false, error: '1 line still needs an answer.' });
    expect(build((d) => { delete d.rows.spirals; delete d.conditions.berms; })).toEqual({ ok: false, error: '2 lines still need an answer.' });
  });

  it('needs to know what is wrong, and which column, on every Bad Order', () => {
    expect(build((d) => { d.rows.spirals = { answer: 'bo', columns: ['guarding'], note: ' ' }; })).toEqual({
      ok: false, error: 'Say what is wrong on each Bad Order.',
    });
    expect(build((d) => { d.rows.spirals = { answer: 'bo', columns: [], note: 'Guard off' }; })).toEqual({
      ok: false, error: 'On each Bad Order, pick what is wrong: guarding, electrical or safe access.',
    });
    expect(build((d) => { d.conditions.lighting = { answer: 'bo' }; })).toEqual({
      ok: false, error: 'Say what is wrong on each Bad Order.',
    });
  });

  it('adds the lines written in under Other, after the printed ones', () => {
    const result = build((d) => {
      d.others = [{ label: ' Portable pump ', mark: { answer: 'bo', columns: ['electrical'], note: 'Cord jacket cut' } }];
    });
    expect(result.ok && result.exam.rows[3]).toEqual({
      id: 'other_1', label: 'Portable pump', other: true, guarding: 'ok', electrical: 'bo', access: 'ok', note: 'Cord jacket cut',
    });
    expect(build((d) => { d.others = [{ label: ' ', mark: { answer: 'ok' } }]; })).toEqual({
      ok: false, error: 'Name each line you added under Other.',
    });
  });
});

describe('conditions found', () => {
  const sheet = makeSheet('Wash plant', 'Sump pump\nSpirals\nOperator room')!;
  const exam = (id: string, submittedAt: number, change: (draft: ExamDraft) => void = () => {}): AreaExam => {
    const draft: ExamDraft = {
      sheetId: sheet.id, shift: 'day', startedAt: submittedAt - 600_000, others: [],
      rows: Object.fromEntries(sheet.rows.map((r) => [r.id, { answer: 'ok' as const }])),
      conditions: Object.fromEntries(AREA_CONDITIONS.map((c) => [c.id, { answer: 'ok' as const }])),
    };
    change(draft);
    const result = buildExam(sheet, draft, { id, employeeId: 'e1', submittedAt });
    if (!result.ok) throw new Error(result.error);
    return result.exam;
  };
  const found = exam('x1', at(6, 21), (d) => {
    d.rows.spirals = { answer: 'bo', columns: ['guarding', 'access'], note: 'Guard off the drive', danger: true };
    d.rows.operator_room = { answer: 'na' };
    d.conditions.fire_extinguishers = { answer: 'bo', note: 'Monthly tag not punched' };
  });

  it('lists each Bad Order with where it is and what is wrong', () => {
    expect(examFindings(found)).toEqual([
      {
        key: 'row:spirals', examId: 'x1', sheetId: 'wash_plant', area: 'Wash plant', employeeId: 'e1', foundAt: at(6, 21),
        label: 'Spirals', where: 'Guarding, safe access', note: 'Guard off the drive', danger: true,
        refs: ['56.14107', '1910.212', '56.11001'],
      },
      {
        key: 'cond:fire_extinguishers', examId: 'x1', sheetId: 'wash_plant', area: 'Wash plant', employeeId: 'e1', foundAt: at(6, 21),
        label: 'Fire extinguishers', where: 'Conditions', note: 'Monthly tag not punched', danger: false,
        refs: ['56.4201', '1910.157(e)(2)'],
      },
    ]);
    expect(examCounts(found)).toEqual({ ok: 20, bo: 2, na: 1, lines: 23 });
    expect(examResult(found)).toBe('danger');
    expect(examResult(exam('x2', at(6, 21), (d) => { d.conditions.lighting = { answer: 'bo', note: 'Lamp out' }; }))).toBe('conditions');
  });

  it('adds the date of the fix to the record, and the request it was sent on', () => {
    const fixed = withFix(found, 'cond:fire_extinguishers', { at: at(9, 5), by: 'sup1', note: 'Punched the tag' });
    expect(fixed.conditions.find((c) => c.id === 'fire_extinguishers')?.fixed).toEqual({ at: at(9, 5), by: 'sup1', note: 'Punched the tag' });
    // The record as it was signed is not rewritten.
    expect(found.conditions.find((c) => c.id === 'fire_extinguishers')?.fixed).toBeUndefined();
    expect(fixed.rows).toBe(found.rows);

    const sent = withMrf(found, 'row:spirals', 'mrf_9');
    expect(examFindings(sent)[0].mrfId).toBe('mrf_9');
    // A fix is recorded once: the first date stands.
    expect(withFix(fixed, 'cond:fire_extinguishers', { at: at(12), by: 'e1' })).toBe(fixed);
  });

  it('keeps a condition open, newest first, until it is fixed', () => {
    const older = exam('x0', at(6, 30, 11), (d) => { d.conditions.lighting = { answer: 'bo', note: 'Lamp out over the sump' }; });
    const elsewhere = { ...exam('x3', at(7, 0), (d) => { d.conditions.berms = { answer: 'bo', note: 'Berm washed out' }; }), sheetId: 'screening', area: 'Screening' };
    const fixed = withFix(found, 'row:spirals', { at: at(10), by: 'e6' });
    const open = openFindings([older, fixed, elsewhere]);
    expect(open.map((f) => [f.area, f.label])).toEqual([
      ['Screening', 'Berms in place & maintained'],
      ['Wash plant', 'Fire extinguishers'],
      ['Wash plant', 'Lighting'],
    ]);
    expect(openFindings([older, fixed, elsewhere], 'wash_plant')).toHaveLength(2);
  });
});
