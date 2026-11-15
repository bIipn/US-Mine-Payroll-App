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

// The second page of every Pre Shift Exam, top to bottom, as it is printed. One spelling is
// put right: on the first aid line the paper has "accesible".
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

  // The mine's own sheets are private and this repository is public (see AGENTS.md), so the
  // samples must not borrow from them. Jest does not load .env.local, so this reads it itself,
  // and only where a build on this machine names its sheets there. Nowhere else is there
  // anything to compare with.
  const named = (() => {
    // This project has no Node types, so the file system is asked for by name with the two calls used here.
    const fs = jest.requireActual<{ existsSync(file: string): boolean; readFileSync(file: string, encoding: 'utf8'): string }>('fs');
    const here = expect.getState().testPath ?? '';
    const file = `${here.slice(0, here.search(/[\\/]src[\\/]/))}/.env.local`;
    if (!fs.existsSync(file)) return [];
    const found = fs.readFileSync(file, 'utf8').match(/^EXPO_PUBLIC_AREA_SHEETS=(?:"([\s\S]*?)"|'([\s\S]*?)'|(.*))$/m);
    return parseAreaSheets(found?.[1] ?? found?.[2] ?? found?.[3]);
  })();

  (named.length ? it : it.skip)('repeat no area and no line of the sheets a build on this machine names', () => {
    const words = (sheets: AreaSheet[]) => sheets.flatMap((s) => [s.title, ...s.rows.map((r) => r.label)]);
    const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const own = new Set(words(named).map(plain));
    expect(words(SAMPLE_AREA_SHEETS).filter((text) => own.has(plain(text)))).toEqual([]);
  });

  it('are read from pasted text: a name, then one line for each line of the sheet', () => {
    const sheets = parseAreaSheets('  North Plant areas:  \nDump pocket\n  Conveyor 12 \nCore saw\nCore saw\n\n\nCore shed\nCore racks\n');
    expect(sheets).toEqual([
      {
        id: 'north_plant',
        title: 'North Plant',
        active: true,
        rows: [
          { id: 'dump_pocket', label: 'Dump pocket' },
          { id: 'conveyor_12', label: 'Conveyor 12' },
          // The same thing can be on a sheet twice. Each line keeps its own answer.
          { id: 'core_saw', label: 'Core saw' },
          { id: 'core_saw_2', label: 'Core saw' },
        ],
      },
      { id: 'core_shed', title: 'Core shed', active: true, rows: [{ id: 'core_racks', label: 'Core racks' }] },
    ]);
  });

  it('read the same whatever made the text: Windows line ends, or \\n typed out in a setting', () => {
    const plain = parseAreaSheets('North Plant Pre Shift Exam\nDump pocket\nConveyor 12\n\nCore shed\nCore racks');
    expect(plain.map((s) => [s.title, s.rows.length])).toEqual([['North Plant', 2], ['Core shed', 1]]);
    expect(parseAreaSheets('North Plant Pre Shift Exam\r\nDump pocket\r\nConveyor 12\r\n\r\nCore shed\r\nCore racks\r\n')).toEqual(plain);
    // An unquoted or single-quoted setting keeps the two characters \ and n instead of a line end.
    expect(parseAreaSheets('North Plant Pre Shift Exam\\nDump pocket\\nConveyor 12\\n\\nCore shed\\nCore racks')).toEqual(plain);
  });

  it('take "areas" off a name only when it is the printed heading, with its colon', () => {
    expect(makeSheet('North Plant areas:', '')?.title).toBe('North Plant');
    expect(makeSheet('North Plant areas :  ', '')?.title).toBe('North Plant');
    expect(makeSheet('Staging areas', '')?.title).toBe('Staging areas');
    expect(makeSheet('North Plant Pre Shift Exam\r', '')?.title).toBe('North Plant');
  });

  it('read as nothing when a build names none', () => {
    expect(parseAreaSheets(undefined)).toEqual([]);
    expect(parseAreaSheets(' \n \n')).toEqual([]);
  });

  it('can be an area with no lines of its own yet, which still gets the conditions page', () => {
    expect(makeSheet('Wash bay', '')).toEqual({ id: 'wash_bay', title: 'Wash bay', active: true, rows: [] });
  });

  it('need a name, and never share an id with a sheet that is already there', () => {
    expect(makeSheet('  ', 'Core saw')).toBeNull();
    expect(makeSheet('Crusher', 'Jaw crusher', ['crusher', 'crusher_2'])?.id).toBe('crusher_3');
  });

  it("are added to a phone's saved sheets when a build names new ones, and never brought back once removed", () => {
    const removed: AreaSheet = { id: 'crusher', title: 'Crusher', active: false, rows: [] };
    const configured = parseAreaSheets('Crusher\nJaw crusher\n\nBagging plant\nFeed bin');
    const merged = withSheets([removed], configured);
    expect(merged.map((s) => [s.id, s.active])).toEqual([['crusher', false], ['bagging_plant', true]]);
    // Nothing to add: the same list comes back, so nothing is saved again.
    expect(withSheets(merged, configured)).toBe(merged);
  });
});

describe('marking a line', () => {
  const line = { id: 'conveyor_12', label: 'Conveyor 12' };

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

  it('keeps what was written only on a Bad Order: a note left on a line changed back to OK is not signed', () => {
    const withdrawn = { columns: ['guarding' as const], note: 'Guard hanging by one bolt', danger: true };
    expect(examRow(line, { answer: 'ok', ...withdrawn })).toEqual({ ...line, guarding: 'ok', electrical: 'ok', access: 'ok' });
    expect(examRow(line, { answer: 'na', ...withdrawn })).toEqual({ ...line, guarding: 'na', electrical: 'na', access: 'na' });
  });
});

describe('buildExam', () => {
  const sheet = makeSheet('Bagging plant', 'Feed bin\nBag conveyor\nControl booth')!;
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
      exam: { id: 'exam_1', sheetId: 'bagging_plant', area: 'Bagging plant', employeeId: 'e1', shift: 'day', startedAt: at(6, 10), submittedAt: at(6, 21) },
    });
    if (!result.ok) return;
    expect(result.exam.rows.map((r) => r.label)).toEqual(['Feed bin', 'Bag conveyor', 'Control booth']);
    expect(result.exam.conditions.map((c) => c.id)).toEqual(AREA_CONDITIONS.map((c) => c.id));
    expect(examResult(result.exam)).toBe('clear');
    expect(examCounts(result.exam)).toEqual({ ok: 23, bo: 0, na: 0, lines: 23 });
  });

  it('will not sign off with a line unanswered', () => {
    expect(build((d) => { delete d.rows.bag_conveyor; })).toEqual({ ok: false, error: '1 line still needs an answer.' });
    expect(build((d) => { delete d.rows.bag_conveyor; delete d.conditions.berms; })).toEqual({ ok: false, error: '2 lines still need an answer.' });
    // A mark that is not OK, BO or N/A is no answer.
    expect(build((d) => { d.rows.bag_conveyor = {} as ExamDraft['rows'][string]; })).toEqual({ ok: false, error: '1 line still needs an answer.' });
    expect(build((d) => { d.conditions.berms = { answer: 'maybe' } as unknown as ExamDraft['conditions'][string]; })).toEqual({
      ok: false, error: '1 line still needs an answer.',
    });
    expect(build((d) => { d.others = [{ label: 'Hose reel', mark: {} as ExamDraft['rows'][string] }]; })).toEqual({
      ok: false, error: '1 line still needs an answer.',
    });
  });

  it('needs to know what is wrong, and which column, on every Bad Order', () => {
    expect(build((d) => { d.rows.bag_conveyor = { answer: 'bo', columns: ['guarding'], note: ' ' }; })).toEqual({
      ok: false, error: 'Say what is wrong on each Bad Order.',
    });
    expect(build((d) => { d.rows.bag_conveyor = { answer: 'bo', columns: [], note: 'Guard off' }; })).toEqual({
      ok: false, error: 'On each Bad Order, pick what is wrong: guarding, electrical or safe access.',
    });
    expect(build((d) => { d.conditions.lighting = { answer: 'bo' }; })).toEqual({
      ok: false, error: 'Say what is wrong on each Bad Order.',
    });
  });

  it('signs nothing that was written on a line and then withdrawn', () => {
    const result = build((d) => {
      d.rows.bag_conveyor = { answer: 'ok', columns: ['guarding'], note: 'Guard hanging by one bolt' };
      d.conditions.lighting = { answer: 'na', note: 'Lamp out', danger: true };
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.exam.rows[1]).toEqual({ id: 'bag_conveyor', label: 'Bag conveyor', guarding: 'ok', electrical: 'ok', access: 'ok' });
    expect(result.exam.conditions.find((c) => c.id === 'lighting')).toEqual({ id: 'lighting', answer: 'na' });
    expect(examResult(result.exam)).toBe('clear');
  });

  it('gives a line written in under Other an id no printed line has', () => {
    const odd = makeSheet('Yard', 'Other 1\nGate')!;
    const result = buildExam(
      odd,
      {
        sheetId: odd.id, shift: 'day', startedAt: at(6, 10),
        rows: { other_1: { answer: 'ok' }, gate: { answer: 'ok' } },
        others: [{ label: 'Hose reel', mark: { answer: 'bo', columns: ['access'], note: 'Reel blocks the walkway' } }],
        conditions: Object.fromEntries(AREA_CONDITIONS.map((c) => [c.id, { answer: 'ok' as const }])),
      },
      who,
    );
    if (!result.ok) throw new Error(result.error);
    expect(new Set(result.exam.rows.map((r) => r.id)).size).toBe(3);
    // Recording the fix for the written-in line leaves the printed line that shares its name alone.
    const written = result.exam.rows[2];
    const fixed = withFix(result.exam, `row:${written.id}`, { at: at(9), by: 'e1' });
    expect(fixed.rows.map((r) => !!r.fixed)).toEqual([false, false, true]);
  });

  it('adds the lines written in under Other, after the printed ones', () => {
    const result = build((d) => {
      d.others = [{ label: ' Portable generator ', mark: { answer: 'bo', columns: ['electrical'], note: 'Cord jacket cut' } }];
    });
    expect(result.ok && result.exam.rows[3]).toEqual({
      id: 'other_1', label: 'Portable generator', other: true, guarding: 'ok', electrical: 'bo', access: 'ok', note: 'Cord jacket cut',
    });
    expect(build((d) => { d.others = [{ label: ' ', mark: { answer: 'ok' } }]; })).toEqual({
      ok: false, error: 'Name each line you added under Other.',
    });
  });
});

describe('conditions found', () => {
  const sheet = makeSheet('Bagging plant', 'Feed bin\nBag conveyor\nControl booth')!;
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
    d.rows.bag_conveyor = { answer: 'bo', columns: ['guarding', 'access'], note: 'Guard off the drive', danger: true };
    d.rows.control_booth = { answer: 'na' };
    d.conditions.fire_extinguishers = { answer: 'bo', note: 'Monthly tag not punched' };
  });

  it('lists each Bad Order with where it is and what is wrong', () => {
    expect(examFindings(found)).toEqual([
      {
        key: 'row:bag_conveyor', examId: 'x1', sheetId: 'bagging_plant', area: 'Bagging plant', employeeId: 'e1', foundAt: at(6, 21),
        label: 'Bag conveyor', where: 'Guarding, safe access', note: 'Guard off the drive', danger: true,
        refs: ['56.14107', '1910.212', '56.11001'],
      },
      {
        key: 'cond:fire_extinguishers', examId: 'x1', sheetId: 'bagging_plant', area: 'Bagging plant', employeeId: 'e1', foundAt: at(6, 21),
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

    const sent = withMrf(found, 'row:bag_conveyor', 'mrf_9');
    expect(examFindings(sent)[0].mrfId).toBe('mrf_9');
    // A fix is recorded once: the first date stands.
    expect(withFix(fixed, 'cond:fire_extinguishers', { at: at(12), by: 'e1' })).toBe(fixed);
  });

  it('touches only the line a key names: a key with no page in front of it matches nothing', () => {
    const fix = { at: at(9, 5), by: 'sup1' };
    expect(withFix(found, 'fire_extinguishers', fix)).toBe(found);
    expect(withFix(found, 'page:fire_extinguishers', fix)).toBe(found);
    expect(withFix(found, 'cond:no_such_line', fix)).toBe(found);
    expect(withMrf(found, 'bag_conveyor', 'mrf_9')).toBe(found);
  });

  it('puts a danger ahead of everything else that is open', () => {
    const tag = exam('x4', at(8, 0), (d) => { d.conditions.fire_extinguishers = { answer: 'bo', note: 'Tag not punched' }; });
    const danger = exam('x5', at(5, 0), (d) => { d.conditions.ground = { answer: 'bo', note: 'Bank is sloughing onto the walkway', danger: true }; });
    expect(openFindings([tag, danger]).map((f) => [f.label, f.danger])).toEqual([
      ['Ground conditions', true],
      ['Fire extinguishers', false],
    ]);
  });

  it('keeps a condition open, newest first, until it is fixed', () => {
    const older = exam('x0', at(6, 30, 11), (d) => { d.conditions.lighting = { answer: 'bo', note: 'Lamp out over the conveyor' }; });
    const elsewhere = { ...exam('x3', at(7, 0), (d) => { d.conditions.berms = { answer: 'bo', note: 'Berm washed out' }; }), sheetId: 'crusher', area: 'Crusher' };
    const fixed = withFix(found, 'row:bag_conveyor', { at: at(10), by: 'e6' });
    const open = openFindings([older, fixed, elsewhere]);
    expect(open.map((f) => [f.area, f.label])).toEqual([
      ['Crusher', 'Berms in place & maintained'],
      ['Bagging plant', 'Fire extinguishers'],
      ['Bagging plant', 'Lighting'],
    ]);
    expect(openFindings([older, fixed, elsewhere], 'bagging_plant')).toHaveLength(2);
  });
});
